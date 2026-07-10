import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { completeChat, type ChatContentPart } from "../llm/client.ts";
import { fetchWithTimeout } from "../system/net.ts";
import type { Tool } from "./types.ts";

interface CdpResponse {
  id?: number;
  result?: any;
  error?: { message?: string; data?: string };
  method?: string;
  params?: any;
}

function chromeBin(): string | null {
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitForPort(userDataDir: string, signal?: AbortSignal): Promise<number> {
  const path = join(userDataDir, "DevToolsActivePort");
  for (let i = 0; i < 80; i++) {
    if (existsSync(path)) {
      const [port] = readFileSync(path, "utf8").trim().split("\n");
      const n = Number(port);
      if (Number.isInteger(n) && n > 0) return n;
    }
    await sleep(100, signal);
  }
  throw new Error("Chrome did not expose a DevTools port.");
}

async function cdpSession(wsUrl: string, signal?: AbortSignal) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const events: CdpResponse[] = [];
  let seq = 0;

  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("Failed to connect to Chrome DevTools.")), { once: true });
  });

  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(String(event.data)) as CdpResponse;
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id)!;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${msg.error.message ?? "CDP error"} ${msg.error.data ?? ""}`.trim()));
      else p.resolve(msg.result);
    } else {
      events.push(msg);
    }
  });

  const send = (method: string, params: Record<string, any> = {}) => {
    const id = ++seq;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise<any>((resolve, reject) => pending.set(id, { resolve, reject }));
  };

  return {
    events,
    close: () => ws.close(),
    send,
  };
}

function textFromRemote(result: any): string {
  const value = result?.result?.value;
  if (typeof value === "string") return value;
  if (value == null) return "";
  return String(value);
}

/** Turn a raw CDP console/exception event into a readable one-line message. */
function consoleMessage(event: { method?: string; params?: any }): string {
  const p = event.params ?? {};
  if (event.method === "Runtime.exceptionThrown") {
    const d = p.exceptionDetails ?? {};
    const msg = d.exception?.description ?? d.exception?.value ?? d.text ?? "uncaught exception";
    return `[exception] ${String(msg).split("\n")[0]}`;
  }
  // Log.entryAdded
  const entry = p.entry ?? {};
  const level = entry.level ?? "log";
  const url = entry.url ? ` (${String(entry.url).split("/").pop()})` : "";
  return `[${level}] ${String(entry.text ?? "").slice(0, 300)}${url}`;
}

function screenshotDir(): string {
  const dir = join(homedir(), ".sophie", "screenshots");
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function describeScreenshot(path: string, prompt: string, signal?: AbortSignal): Promise<string> {
  const parts: ChatContentPart[] = [
    {
      type: "text",
      text:
        `${prompt}\n\n` +
        `You are inspecting a browser screenshot captured by Sophie: ${path}\n` +
        "Focus on visible UI, layout, styling, text, broken rendering, overlap, empty states, and anything that looks wrong. Say what is uncertain.",
    },
    {
      type: "image_url",
      image_url: { url: `data:image/png;base64,${readFileSync(path).toString("base64")}` },
    },
  ];

  return completeChat(
    [
      {
        role: "system",
        content:
          "You are Sophie using her configured local vision model. Only describe what is visible in the browser screenshot. Do not invent details.",
      },
      { role: "user", content: parts },
    ],
    { temperature: 0.2, signal },
  );
}

// ── browser_act: a persistent, driveable browser session ─────────────────
//
// Unlike browser_check (launch → inspect → kill, for verifying built UIs),
// browser_act keeps ONE Chrome alive across calls with a durable profile under
// ~/.sophie/browser-profile — so logins persist and multi-step flows
// (navigate → click → type → read) work like a person at the keyboard.

interface LiveBrowser {
  proc: ReturnType<typeof Bun.spawn>;
  session: Awaited<ReturnType<typeof cdpSession>>;
  userDataDir: string;
  visible: boolean;
}

let live: LiveBrowser | null = null;
let exitHookInstalled = false;

function killLiveBrowser(): void {
  if (!live) return;
  try {
    live.session.close();
  } catch {
    /* ignore */
  }
  try {
    live.proc.kill();
  } catch {
    /* ignore */
  }
  live = null;
}

async function ensureLiveBrowser(visible: boolean, signal?: AbortSignal): Promise<LiveBrowser> {
  if (live) return live;
  const bin = chromeBin();
  if (!bin) throw new Error("Chrome/Chromium not found — install Google Chrome to use browser_act.");
  const userDataDir = join(homedir(), ".sophie", "browser-profile");
  mkdirSync(userDataDir, { recursive: true });
  // Remove a stale port file so waitForPort can't read last session's port.
  rmSync(join(userDataDir, "DevToolsActivePort"), { force: true });
  // NOTE: deliberately no ctx.signal on the spawn — the browser must outlive
  // the turn that started it (that's the whole point of a persistent session).
  const proc = Bun.spawn(
    [
      bin,
      ...(visible ? [] : ["--headless=new"]),
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-debugging-port=0",
      "--window-size=1280,900",
      `--user-data-dir=${userDataDir}`,
      "about:blank",
    ],
    { stdout: "ignore", stderr: "ignore", stdin: "ignore" },
  );
  const port = await waitForPort(userDataDir, signal);
  const pages = await fetchWithTimeout(`http://127.0.0.1:${port}/json/list`, { signal, timeoutMs: 10_000 }).then(
    (r) => r.json(),
  ) as any[];
  const page = pages.find((p) => p.type === "page") ?? pages[0];
  if (!page?.webSocketDebuggerUrl) {
    proc.kill();
    throw new Error("No debuggable page found in the launched browser.");
  }
  const session = await cdpSession(page.webSocketDebuggerUrl, signal);
  await session.send("Runtime.enable");
  await session.send("Page.enable");
  live = { proc, session, userDataDir, visible };
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once("exit", killLiveBrowser);
  }
  return live;
}

/** In-page finder: CSS selector first, then visible text / label / placeholder. */
const FIND_JS = `function __sophieFind(target){
  try { const el = document.querySelector(target); if (el) return el; } catch (e) {}
  const nodes = [...document.querySelectorAll('a,button,input,textarea,select,[role="button"],[role="link"],[role="tab"],[onclick],label,summary')];
  const t = String(target).trim().toLowerCase();
  const labelOf = (n) => ((n.innerText || n.value || n.placeholder || n.getAttribute('aria-label') || n.title || '') + '').trim().toLowerCase();
  return nodes.find((n) => labelOf(n) === t) || nodes.find((n) => t && labelOf(n).includes(t)) || null;
}`;

/** One evaluate that returns everything the model needs to act next. */
async function pageSnapshot(session: LiveBrowser["session"]): Promise<string> {
  const res = await session.send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const clip = (s, n) => { s = (s || '').replace(/\\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
      const els = [...document.querySelectorAll('a,button,input,textarea,select,[role="button"]')]
        .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
        .slice(0, 25)
        .map((el) => {
          const tag = el.tagName.toLowerCase();
          const label = clip(el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || '', 60);
          const hint = el.id ? '#' + el.id : el.name ? tag + '[name="' + el.name + '"]' : '';
          const type = tag === 'input' ? ':' + (el.type || 'text') : '';
          return '- ' + tag + type + (label ? ' "' + label + '"' : '') + (hint ? ' (' + hint + ')' : '');
        });
      return JSON.stringify({
        title: document.title,
        url: location.href,
        text: clip(document.body ? document.body.innerText : '', 2500),
        elements: els,
      });
    })()`,
  });
  try {
    const snap = JSON.parse(textFromRemote(res));
    return (
      `URL: ${snap.url}\nTitle: ${snap.title}\n\n--- visible text ---\n${snap.text || "(empty)"}` +
      (snap.elements?.length ? `\n\n--- interactive elements (target by text or selector) ---\n${snap.elements.join("\n")}` : "")
    );
  } catch {
    return "(could not snapshot the page)";
  }
}

const PRESS_KEYS: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", keyCode: 9 },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
};

async function pressKey(session: LiveBrowser["session"], name: string): Promise<void> {
  const k = PRESS_KEYS[name.toLowerCase()];
  if (!k) throw new Error(`Unsupported key "${name}". Supported: ${Object.keys(PRESS_KEYS).join(", ")}.`);
  await session.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode });
  if (k.text) await session.send("Input.dispatchKeyEvent", { type: "char", text: k.text });
  await session.send("Input.dispatchKeyEvent", { type: "keyUp", key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode });
}

export const browserAct: Tool = {
  name: "browser_act",
  description:
    "Drive a real persistent browser like a person: navigate and interact with live websites across " +
    "multiple calls (the session and its logins persist in a dedicated Chrome profile). Actions: " +
    "'goto' (url), 'read' (current page text + clickable elements), 'click' (target = visible text or CSS " +
    "selector), 'type' (target + text, optional submit=true to press Enter after), 'press' (key: enter/tab/" +
    "escape/arrowdown/arrowup/pagedown/pageup), 'back', 'screenshot', 'close'. Every action returns a fresh " +
    "page snapshot. Set visible=true on the first call to show the window (e.g. so the user can log in). " +
    "Use browser_check instead for one-shot verification of an app you built.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["goto", "read", "click", "type", "press", "back", "screenshot", "close"],
        description: "What to do in the live browser.",
      },
      url: { type: "string", description: "goto: the URL to open." },
      target: { type: "string", description: "click/type: element to act on — visible text, aria-label, placeholder, or a CSS selector." },
      text: { type: "string", description: "type: the text to enter." },
      submit: { type: "boolean", description: "type: press Enter after typing (submits most forms)." },
      key: { type: "string", description: "press: which key (enter, tab, escape, arrowdown, arrowup, pagedown, pageup)." },
      visible: { type: "boolean", description: "Launch the browser with a visible window instead of headless (first call only)." },
      wait_ms: { type: "number", description: "Extra wait after the action before reading the page, ms (default 1500)." },
      inspect_visual: { type: "boolean", description: "screenshot: also describe the screenshot with the vision model." },
    },
    required: ["action"],
  },
  summarize: (a) => {
    const action = String(a.action ?? "read");
    if (action === "goto") return `goto ${a.url}`;
    if (action === "click") return `click "${a.target}"`;
    if (action === "type") return `type into "${a.target}"`;
    if (action === "press") return `press ${a.key}`;
    return action;
  },
  // Reading and navigating are safe; clicking/typing/keys act on real accounts
  // and real forms, so they get a per-call approval.
  risk: (a) => (["click", "type", "press"].includes(String(a.action)) ? "caution" : "safe"),
  async execute(args, ctx) {
    const action = String(args.action ?? "read");
    const waitMs = Math.max(0, Math.min(Number(args.wait_ms) || 1500, 15_000));

    if (action === "close") {
      if (!live) return { content: "No live browser session to close.", display: "not open" };
      killLiveBrowser();
      return { content: "Closed the live browser session (profile and logins are kept for next time).", display: "closed" };
    }

    // One relaunch retry: the user may have quit the window between calls.
    for (let attempt = 0; ; attempt++) {
      try {
        const browser = await ensureLiveBrowser(Boolean(args.visible), ctx.signal);
        const { session } = browser;

        switch (action) {
          case "goto": {
            const url = String(args.url ?? "").trim();
            if (!url) return { content: "goto needs a url.", isError: true };
            await session.send("Page.navigate", { url: /^[a-z]+:\/\//i.test(url) ? url : `https://${url}` });
            break;
          }
          case "back":
            await session.send("Runtime.evaluate", { expression: "history.back()" });
            break;
          case "click": {
            const target = String(args.target ?? "").trim();
            if (!target) return { content: "click needs a target (visible text or CSS selector).", isError: true };
            const res = await session.send("Runtime.evaluate", {
              returnByValue: true,
              expression: `(() => { ${FIND_JS}
                const el = __sophieFind(${JSON.stringify(target)});
                if (!el) return 'NOT_FOUND';
                el.scrollIntoView({ block: 'center' });
                el.click();
                return 'CLICKED ' + el.tagName.toLowerCase();
              })()`,
            });
            const out = textFromRemote(res);
            if (out === "NOT_FOUND") {
              return {
                content: `No element matching "${target}" found.\n\n${await pageSnapshot(session)}`,
                isError: true,
                display: "target not found",
              };
            }
            break;
          }
          case "type": {
            const target = String(args.target ?? "").trim();
            const text = String(args.text ?? "");
            if (!target) return { content: "type needs a target (input's label/placeholder or a CSS selector).", isError: true };
            const res = await session.send("Runtime.evaluate", {
              returnByValue: true,
              expression: `(() => { ${FIND_JS}
                const el = __sophieFind(${JSON.stringify(target)});
                if (!el) return 'NOT_FOUND';
                el.scrollIntoView({ block: 'center' });
                el.focus();
                if (el.isContentEditable) { el.innerText = ${JSON.stringify(text)}; }
                else {
                  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
                  const setter = Object.getOwnPropertyDescriptor(proto, 'value');
                  if (setter && setter.set) setter.set.call(el, ${JSON.stringify(text)}); else el.value = ${JSON.stringify(text)};
                }
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                return 'TYPED';
              })()`,
            });
            const out = textFromRemote(res);
            if (out === "NOT_FOUND") {
              return {
                content: `No input matching "${target}" found.\n\n${await pageSnapshot(session)}`,
                isError: true,
                display: "target not found",
              };
            }
            if (args.submit) await pressKey(session, "enter");
            break;
          }
          case "press":
            await pressKey(session, String(args.key ?? "enter"));
            break;
          case "screenshot": {
            await sleep(waitMs, ctx.signal);
            const shot = await session.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
            const path = join(screenshotDir(), `browser-act-${Date.now().toString(36)}.png`);
            writeFileSync(path, Buffer.from(String(shot.data ?? ""), "base64"));
            let visual = "";
            if (args.inspect_visual) {
              visual = await describeScreenshot(path, "Describe this live web page screenshot for someone acting on it.", ctx.signal);
            }
            return {
              content: `Screenshot: ${path}\n${visual ? `\n--- visual inspection ---\n${visual}\n` : ""}\n${await pageSnapshot(session)}`,
              display: "screenshot saved",
            };
          }
          case "read":
            break;
          default:
            return { content: `Unknown browser_act action "${action}".`, isError: true };
        }

        await sleep(waitMs, ctx.signal);
        const snapshot = await pageSnapshot(session);
        return { content: `${action.toUpperCase()} done.\n\n${snapshot}`, display: action };
      } catch (e: any) {
        if (e?.name === "AbortError") throw e;
        // The window may have been closed since the last call — relaunch once.
        killLiveBrowser();
        if (attempt === 0) continue;
        return { content: `browser_act failed: ${e?.message ?? e}`, isError: true, display: "failed" };
      }
    }
  },
};

export const browserCheck: Tool = {
  name: "browser_check",
  description:
    "Open a URL in headless Chrome and verify what the browser actually renders. " +
    "Use this for frontend work before claiming a page shows the expected UI. Can capture a screenshot " +
    "and optionally inspect it with the configured local vision model for styling/layout bugs. " +
    "Returns title, URL, visible text, expected_text result, browser/runtime errors, and screenshot path.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL to open, e.g. http://localhost:3001." },
      expected_text: { type: "string", description: "Text that should appear in the rendered page." },
      wait_ms: { type: "number", description: "Wait after load before reading, ms (default 1500)." },
      screenshot: { type: "boolean", description: "Capture a PNG screenshot (default true)." },
      viewport_width: { type: "number", description: "Viewport width px (default 1280)." },
      viewport_height: { type: "number", description: "Viewport height px (default 900)." },
      inspect_visual: {
        type: "boolean",
        description: "Send the screenshot to the vision model and include its inspection.",
      },
      visual_prompt: {
        type: "string",
        description: "Prompt for visual inspection (styling/layout tasks).",
      },
    },
    required: ["url"],
  },
  summarize: (a) => `browser ${a.url}`,
  risk: () => "safe",
  async execute(args, ctx) {
    const bin = chromeBin();
    if (!bin) return { content: "Chrome/Chromium not found.", isError: true, display: "no browser" };

    const url = String(args.url ?? "").trim();
    if (!url) return { content: "Error: url is required.", isError: true };
    const expected = typeof args.expected_text === "string" ? args.expected_text : "";
    const waitMs = Math.max(0, Math.min(Number(args.wait_ms) || 1500, 10_000));
    const captureScreenshot = args.screenshot !== false;
    const inspectVisual = Boolean(args.inspect_visual);
    const viewportWidth = Math.max(320, Math.min(Number(args.viewport_width) || 1280, 3840));
    const viewportHeight = Math.max(240, Math.min(Number(args.viewport_height) || 900, 2160));
    const userDataDir = mkdtempSync(join(tmpdir(), "sophie-chrome-"));
    const proc = Bun.spawn(
      [
        bin,
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--remote-debugging-port=0",
        `--window-size=${viewportWidth},${viewportHeight}`,
        `--user-data-dir=${userDataDir}`,
        url,
      ],
      { stdout: "ignore", stderr: "ignore", stdin: "ignore", signal: ctx.signal },
    );

    let session: Awaited<ReturnType<typeof cdpSession>> | null = null;
    try {
      const port = await waitForPort(userDataDir, ctx.signal);
      const pages = await fetchWithTimeout(`http://127.0.0.1:${port}/json/list`, {
        signal: ctx.signal,
        timeoutMs: 10_000,
      }).then((r) => r.json()) as any[];
      const page = pages.find((p) => p.type === "page") ?? pages[0];
      if (!page?.webSocketDebuggerUrl) throw new Error("No debuggable page found.");

      session = await cdpSession(page.webSocketDebuggerUrl, ctx.signal);
      await session.send("Runtime.enable");
      await session.send("Log.enable");
      await session.send("Page.enable");
      await session.send("Emulation.setDeviceMetricsOverride", {
        width: viewportWidth,
        height: viewportHeight,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await sleep(waitMs, ctx.signal);

      const [title, href, bodyText, html] = await Promise.all([
        session.send("Runtime.evaluate", { expression: "document.title", returnByValue: true }),
        session.send("Runtime.evaluate", { expression: "location.href", returnByValue: true }),
        session.send("Runtime.evaluate", { expression: "document.body ? document.body.innerText : ''", returnByValue: true }),
        session.send("Runtime.evaluate", { expression: "document.documentElement ? document.documentElement.outerHTML.slice(0, 2000) : ''", returnByValue: true }),
      ]);

      const text = textFromRemote(bodyText);
      const errors = session.events
        .filter((e) => e.method === "Runtime.exceptionThrown" || e.method === "Log.entryAdded")
        .map((e) => consoleMessage(e))
        .slice(-10);
      let screenshotPath = "";
      let visual = "";
      if (captureScreenshot) {
        const shot = await session.send("Page.captureScreenshot", {
          format: "png",
          captureBeyondViewport: false,
        });
        screenshotPath = join(screenshotDir(), `browser-${Date.now().toString(36)}.png`);
        writeFileSync(screenshotPath, Buffer.from(String(shot.data ?? ""), "base64"));
        if (inspectVisual) {
          visual = await describeScreenshot(
            screenshotPath,
            String(args.visual_prompt ?? "Inspect this frontend page screenshot. Does it show the intended UI? Note layout/styling problems."),
            ctx.signal,
          );
        }
      }
      const found = expected ? text.toLowerCase().includes(expected.toLowerCase()) : undefined;
      const clippedText = text.length > 3000 ? `${text.slice(0, 3000)}\n...(visible text truncated)` : text;
      // Two independent signals: did it RENDER (expected text present / page has
      // content) and is the CONSOLE clean. Keep them separate so a working page
      // with console errors isn't reported as a blank "text found" error.
      const renderOk = expected ? Boolean(found) : text.trim().length > 0;
      const errorCount = errors.length;
      const renderStatus = expected ? (found ? "expected text present" : "expected text MISSING") : renderOk ? "page has content" : "page is EMPTY";
      const consoleStatus = errorCount ? `${errorCount} console error${errorCount === 1 ? "" : "s"}` : "clean";
      const display = !renderOk
        ? expected
          ? "text missing"
          : "empty page"
        : errorCount
          ? `rendered, ${errorCount} console error${errorCount === 1 ? "" : "s"}`
          : "rendered, clean";
      return {
        content:
          `RENDER: ${renderStatus}. CONSOLE: ${consoleStatus}.` +
          (renderOk && errorCount ? " The page renders but the console is not clean — fix these errors." : "") +
          `\n\nURL: ${textFromRemote(href)}\nTitle: ${textFromRemote(title)}\n` +
          `Viewport: ${viewportWidth}x${viewportHeight}\n` +
          (screenshotPath ? `Screenshot: ${screenshotPath}\n` : "") +
          (expected ? `Expected text ${JSON.stringify(expected)}: ${found ? "FOUND" : "NOT FOUND"}\n` : "") +
          `Console errors: ${errorCount ? `\n- ${errors.join("\n- ")}` : "none captured"}\n\n` +
          (visual ? `--- visual inspection ---\n${visual}\n\n` : "") +
          `--- visible text ---\n${clippedText || "(empty visible text)"}\n\n` +
          `--- html sample ---\n${textFromRemote(html)}`,
        isError: !renderOk || errorCount > 0,
        display,
      };
    } catch (e: any) {
      return { content: `browser_check failed: ${e?.message ?? e}`, isError: true, display: "failed" };
    } finally {
      try {
        session?.close();
      } catch {
        /* ignore */
      }
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
      try {
        rmSync(userDataDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  },
};
