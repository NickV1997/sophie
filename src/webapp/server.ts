import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { basename, extname, join } from "node:path";
import process from "node:process";
import { Agent, type ApprovalDecision, type ToolCallEvent } from "../agent/agent.ts";
import { getMode, setMode as setModeStore } from "../agent/mode.ts";
import { getPresence, noteExchange, noteUserActivity } from "../agent/presence.ts";
import { createAgentRuntime, runWithRuntime, type AgentRuntimeState } from "../agent/runtime.ts";
import {
  getCurrentJob,
  getJournal,
  getObjective,
  getTasks,
  restoreCurrentJob,
  restoreJournal,
  restoreTasks,
  setObjective,
} from "../agent/tasks.ts";
import { config, type Mode } from "../config.ts";
import {
  addEvent,
  cancelEvent,
  getEvent,
  listEvents,
  updateEvent,
  type CalendarEvent,
} from "../calendar/store.ts";
import { calendarSyncStatus, syncCalendarEvent } from "../calendar/sync.ts";
import { readDreamState, runDreamPass } from "../memory/dream.ts";
import { deleteEngineMemory, listEngineMemories, updateEngineMemory } from "../memory/engine.ts";
import { deleteFactMemory, listMemories, updateFactMemory } from "../memory/facts.ts";
import { synthesizeToWav } from "../channels/notify.ts";
import { ttsStatus } from "../tts/service.ts";
import { IMAGE_EXTENSIONS, MAX_IMAGE_BYTES } from "../llm/image-files.ts";
import { detectLoadedModel, ping } from "../llm/client.ts";
import { ENV_KEYS, readEnvFile, writeEnv } from "../system/env.ts";
import { startTelegramBridge, stopTelegramBridge, telegramReady } from "../channels/telegram.ts";
import {
  deleteSession as deleteSavedSession,
  latestSession,
  listSessions,
  loadSession,
  newSessionId,
  saveSession,
  setCurrentSessionId,
  titleFrom,
  type SessionState,
} from "../agent/session.ts";
import type { ToolResult } from "../tools/types.ts";
import { authorized } from "./auth.ts";
import { WebAudioStream } from "./audio.ts";
export { authorized } from "./auth.ts";

type BunServer = ReturnType<typeof Bun.serve>;

type WebBlock =
  | { id: string; kind: "user"; text: string; attachments?: WebAttachment[] }
  | { id: string; kind: "assistant" | "thinking" | "system" | "error"; text: string }
  | {
      id: string;
      kind: "tool";
      name: string;
      summary: string;
      risk: ToolCallEvent["risk"];
      status: "running" | "done" | "error" | "denied" | "awaiting" | "cancelled";
      result?: string;
    };

interface WebAttachment {
  name: string;
  path: string;
  size: number;
  type: string;
}

interface PendingApproval {
  id: string;
  call: ToolCallEvent;
  resolve: (decision: ApprovalDecision) => void;
}

interface RunningWebApp {
  servers: BunServer[];
  webUrl: string;
  localWebUrl: string;
  token: string;
  displayUrls: string[];
}

export interface WebAppStartOptions {
  cwd?: string;
  host?: string;
  port?: number;
  open?: boolean;
  foreground?: boolean;
}

export interface WebAppStartResult {
  url: string;
  reused: boolean;
  detail: string;
}

export interface WebAppStopResult {
  stopped: boolean;
  detail: string;
}

interface TtsVoice {
  id: string;
  language?: string;
  description?: string;
}

interface WebAppPidFile {
  webUrl: string;
  localWebUrl?: string;
  /** Per-launch API token; required on every /api/* request. */
  token?: string;
  /** Tokenized URLs to show the user when this server is reused. */
  displayUrls?: string[];
  ownerPid: number;
  killOwnerOnExternalStop: boolean;
  startedAt: number;
}

const STATIC_DIR = join(import.meta.dir, "static");
const DEFAULT_WEB_PORT = 3737;
const PID_PATH = join(homedir(), ".sophie", "webapp.json");

let active: RunningWebApp | null = null;

export async function startWebAppServer(opts: WebAppStartOptions = {}): Promise<WebAppStartResult> {
  if (active) {
    return {
      url: active.webUrl,
      reused: true,
      detail: `Sophie web app is already running.\n${urlLines(active.displayUrls)}`,
    };
  }

  const external = await liveExternalWebApp();
  if (external) {
    const urls = external.displayUrls ?? [external.localWebUrl ?? external.webUrl];
    return {
      url: preferredWebUrl(urls),
      reused: true,
      detail: `Reusing the Sophie web app already running in another process.\n${urlLines(urls)}`,
    };
  }

  const cwd = opts.cwd ?? process.cwd();
  const { hosts, note } = resolveBindHosts(opts.host ?? process.env.SOPHIE_WEBAPP_HOST);
  const port = await choosePort(hosts, opts.port ?? envPort("SOPHIE_WEBAPP_PORT", DEFAULT_WEB_PORT));
  // Per-launch bearer token. Every /api/* request must present it, so a
  // stranger who can reach the port (mis-set host override, shared tailnet
  // node) still cannot drive the agent or approve its actions.
  const token = randomBytes(16).toString("hex");
  const runtime = new WebRuntime(cwd);
  const handler = (req: Request): Response | Promise<Response> => {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      if (req.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
      if (!authorized(req, url, token)) {
        return json({ error: "Unauthorized. Open the web app with the exact URL Sophie printed (it carries the access token)." }, 401);
      }
      return runtime.fetch(req);
    }
    return serveStatic(url.pathname);
  };
  const servers = hosts.map((hostname) => Bun.serve({ hostname, port, idleTimeout: 240, fetch: handler }));

  const localHost = hosts.includes("0.0.0.0") || hosts.includes("127.0.0.1") ? "127.0.0.1" : hosts[0];
  const localWebUrl = `http://${localHost}:${port}`;
  const displayUrls = displayUrlsFor(hosts, port, token);
  const webUrl = preferredWebUrl(displayUrls);

  active = { servers, webUrl, localWebUrl, token, displayUrls };
  writePidFile({
    webUrl,
    localWebUrl,
    token,
    displayUrls,
    ownerPid: process.pid,
    killOwnerOnExternalStop: Boolean(opts.foreground),
    startedAt: Date.now(),
  });

  if (opts.open !== false) void openBrowser(tokenizedUrl(localWebUrl, token));

  return {
    url: webUrl,
    reused: false,
    detail: `Sophie web app is live.\n${urlLines(displayUrls)}${note ? `\n${note}` : ""}`,
  };
}

/**
 * Hosts to listen on. Default: loopback plus the Tailscale interface only, so
 * the app is reachable from this Mac and the user's own tailnet but is never
 * exposed on the open LAN (coffee-shop wifi, office network). An explicit
 * host — the --host flag or SOPHIE_WEBAPP_HOST — overrides entirely, including
 * 0.0.0.0 for users who really want a LAN bind; the API token still applies.
 * (Exported for tests.)
 */
export function resolveBindHosts(override?: string): { hosts: string[]; note: string } {
  if (override) return { hosts: [override], note: "" };
  const tailscale = externalAddresses().filter((a) => a.label === "Tailscale");
  const hosts = ["127.0.0.1", ...tailscale.map((a) => a.address)];
  const note = tailscale.length
    ? ""
    : "  No Tailscale interface found — the web app is reachable from this Mac only.\n" +
      "  Start Tailscale and rerun /webapp to reach it from your other devices,\n" +
      "  or set SOPHIE_WEBAPP_HOST to bind a specific interface.";
  return { hosts, note };
}

/** Constant-time check of the per-launch API token, accepted as a Bearer
 *  header, an X-Sophie-Token header, or a ?token= query parameter.
 *  (Exported for tests.) */
/** The token rides in the URL fragment: never sent over the wire on page
 *  load; the app shell reads it into localStorage and strips it. */
function tokenizedUrl(base: string, token: string): string {
  return `${base}/#token=${token}`;
}

function displayUrlsFor(hosts: string[], port: number, token: string): string[] {
  const shown = hosts.includes("0.0.0.0")
    ? ["127.0.0.1", ...externalAddresses().map((a) => a.address)]
    : hosts;
  return shown.map((host) => tokenizedUrl(`http://${host}:${port}`, token));
}

function preferredWebUrl(urls: string[]): string {
  return urls.find((url) => isTailscaleIp(new URL(url).hostname)) ?? urls[urls.length - 1] ?? urls[0];
}

function urlLines(urls: string[]): string {
  return urls
    .map((url) => {
      const host = new URL(url).hostname;
      const label = host === "127.0.0.1" || host === "localhost" ? "This Mac " : isTailscaleIp(host) ? "Tailscale" : "LAN      ";
      return `  ${label}:  ${url}`;
    })
    .join("\n");
}

export async function stopWebAppServer(): Promise<WebAppStopResult> {
  if (active) {
    const url = active.webUrl;
    for (const server of active.servers) server.stop(true);
    active = null;
    removePidFile();
    return { stopped: true, detail: `Stopped Sophie web app at ${url}.` };
  }

  const file = readPidFile();
  if (!file) return { stopped: false, detail: "Sophie web app is not running." };

  if (!isPidAlive(file.ownerPid)) {
    removePidFile();
    return { stopped: false, detail: "Removed stale Sophie web app state." };
  }

  if (file.killOwnerOnExternalStop && file.ownerPid !== process.pid) {
    process.kill(file.ownerPid, "SIGTERM");
    removePidFile();
    return { stopped: true, detail: `Stopped Sophie web app at ${file.webUrl}.` };
  }

  return {
    stopped: false,
    detail: `The web app is running inside another Sophie process (pid ${file.ownerPid}). Stop it there with /webapp stop, or kill that process.`,
  };
}

function serveStatic(pathname: string): Response {
  // Single-page UI: anything that is not an API route gets the app shell.
  const name = pathname === "/" ? "index.html" : basename(pathname);
  const file = Bun.file(join(STATIC_DIR, name));
  const headers = { "Cache-Control": "no-store" };
  if (name !== "index.html" && !existsSync(join(STATIC_DIR, name))) {
    return new Response(Bun.file(join(STATIC_DIR, "index.html")), { headers });
  }
  return new Response(file, { headers });
}

/** IPv4 in Tailscale's CGNAT range (100.64.0.0/10). */
function isTailscaleIp(address: string): boolean {
  return /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address);
}

function externalAddresses(): Array<{ label: string; address: string }> {
  const out: Array<{ label: string; address: string }> = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family !== "IPv4" || addr.internal) continue;
      out.push({ label: isTailscaleIp(addr.address) ? "Tailscale" : "LAN", address: addr.address });
    }
  }
  out.sort((a, b) => (a.label === "Tailscale" ? -1 : 0) - (b.label === "Tailscale" ? -1 : 0));
  return out;
}

class WebRuntime {
  private runtime: AgentRuntimeState = createAgentRuntime();
  private agent = new Agent(this.runtime);
  private sessionId = (() => { const id = newSessionId(); setCurrentSessionId(id); return id; })();
  private blocks: WebBlock[] = [];
  private busy = false;
  private pendingApproval: PendingApproval | null = null;
  private lastProgressSaveAt = 0;
  private audioVoice = defaultAudioVoice();

  constructor(private cwd: string) {
    runWithRuntime(this.runtime, () => {
      const session = latestSession(cwd) ?? latestSession();
      if (session) this.restoreSession(session);
    });
  }

  async fetch(req: Request): Promise<Response> {
    return runWithRuntime(this.runtime, () => this.fetchInRuntime(req));
  }

  private async fetchInRuntime(req: Request): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (req.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
      if (req.method === "GET" && url.pathname === "/api/health") {
        return json({
          cwd: this.cwd,
          baseUrl: config.baseUrl,
          model: config.model,
          modelServer: await ping(),
          tts: ttsStatus(),
        });
      }
      if (req.method === "GET" && url.pathname === "/api/state") return json(this.state());

      // ── calendar ── The internal Sophie calendar (~/.sophie/calendar.json)
      // is the source of truth; every write mirrors to Apple Calendar when
      // running on macOS (syncCalendarEvent no-ops elsewhere).
      if (req.method === "GET" && url.pathname === "/api/calendar/events") {
        const now = Date.now();
        const dayMs = 24 * 3_600_000;
        const from = numberParam(url, "from") ?? now - 31 * dayMs;
        const to = numberParam(url, "to") ?? now + 62 * dayMs;
        if (to <= from) return json({ error: "'to' must be after 'from'." }, 400);
        return json({ events: listEvents(from, to), syncStatus: calendarSyncStatus() });
      }
      if (req.method === "POST" && url.pathname === "/api/calendar/events") {
        const body = await req.json().catch(() => ({}));
        const parsed = parseEventBody(body);
        if ("error" in parsed) return json({ error: parsed.error }, 400);
        if (!parsed.value.title) return json({ error: "Title is required." }, 400);
        if (parsed.value.start == null || parsed.value.end == null) {
          return json({ error: "Start and end times are required." }, 400);
        }
        if (parsed.value.end <= parsed.value.start) return json({ error: "End must be after start." }, 400);
        if (startOfDayMs(parsed.value.start) < startOfDayMs()) {
          return json({ error: "Events can't be added to days that have already passed." }, 400);
        }
        const ev = addEvent({
          title: parsed.value.title,
          start: parsed.value.start,
          end: parsed.value.end,
          location: parsed.value.location,
          notes: parsed.value.notes,
          attendees: parsed.value.attendees,
          reminderLeads: parsed.value.reminderLeads,
        });
        const sync = await syncCalendarEvent(ev);
        return json({ event: getEvent(ev.id) ?? ev, sync });
      }
      const calEvent = url.pathname.match(/^\/api\/calendar\/events\/([^/]+)$/);
      if (calEvent && (req.method === "POST" || req.method === "DELETE")) {
        const id = decodeURIComponent(calEvent[1]);
        const existing = getEvent(id);
        if (!existing) return json({ error: "Event not found." }, 404);
        if (req.method === "DELETE") {
          const ev = cancelEvent(id)!;
          const sync = await syncCalendarEvent(ev);
          return json({ event: getEvent(id) ?? ev, sync });
        }
        const body = await req.json().catch(() => ({}));
        const parsed = parseEventBody(body);
        if ("error" in parsed) return json({ error: parsed.error }, 400);
        const start = parsed.value.start ?? existing.start;
        const end = parsed.value.end ?? existing.end;
        if (end <= start) return json({ error: "End must be after start." }, 400);
        // An event already on a past day may be edited in place, but nothing
        // can be moved onto a day that has already passed.
        if (startOfDayMs(start) < startOfDayMs() && startOfDayMs(start) !== startOfDayMs(existing.start)) {
          return json({ error: "Events can't be moved to a day that has already passed." }, 400);
        }
        const ev = updateEvent(id, parsed.value)!;
        const sync = await syncCalendarEvent(ev);
        return json({ event: getEvent(id) ?? ev, sync });
      }
      // ── memory ── The webapp memory page: read everything Sophie believes,
      // edit/delete individual records, and trigger a dream pass on demand.
      if (req.method === "GET" && url.pathname === "/api/memory") {
        const memories = listEngineMemories(this.cwd)
          .filter((r) => !r.id.startsWith("legacy:"))
          .map((r) => ({
            id: r.id,
            kind: r.kind,
            scope: r.scope,
            text: r.full,
            capsule: r.capsule,
            source: r.source,
            confidence: r.confidence,
            useCount: r.useCount,
            evidence: r.evidence,
            createdAt: r.createdAt,
            lastUsedAt: r.lastUsedAt,
          }));
        const facts = (["user", "project"] as const).flatMap((scope) =>
          listMemories(scope, this.cwd).map((r) => ({
            id: r.id,
            kind: r.type,
            scope: scope === "user" ? "global" : "project",
            text: r.text,
            capsule: r.text,
            source: "runtime",
            confidence: r.salience,
            useCount: r.useCount,
            evidence: "keyword fact store",
            createdAt: r.createdAt,
            lastUsedAt: r.lastUsedAt,
            legacy: true,
          })),
        );
        return json({ memories: [...memories, ...facts], dream: readDreamState() });
      }
      if (req.method === "POST" && url.pathname === "/api/memory/dream") {
        const server = await ping();
        const report = await runDreamPass(this.cwd, { llm: server.ok });
        return json({ report });
      }
      const memoryItem = url.pathname.match(/^\/api\/memory\/([^/]+)$/);
      if (memoryItem && (req.method === "POST" || req.method === "DELETE")) {
        const id = decodeURIComponent(memoryItem[1]!);
        if (req.method === "DELETE") {
          const removed = deleteEngineMemory(id, this.cwd) || deleteFactMemory(id, this.cwd);
          return removed ? json({ ok: true }) : json({ error: "Memory not found." }, 404);
        }
        const body = await req.json().catch(() => ({}));
        const text = typeof body?.text === "string" ? body.text.trim() : "";
        if (!text) return json({ error: "Memory text is required." }, 400);
        const updated = updateEngineMemory(id, text, this.cwd) ?? updateFactMemory(id, text, this.cwd);
        if (!updated) return json({ error: "Memory not found, or the new text is too vague to keep." }, 404);
        return json({ ok: true });
      }

      if (req.method === "GET" && url.pathname === "/api/audio/voices") {
        return json({ voices: await listTtsVoices(), selected: this.audioVoice });
      }
      if (req.method === "POST" && url.pathname === "/api/audio/voice") {
        const body = await req.json().catch(() => ({}));
        const voice = String(body?.voice ?? "").trim();
        if (!validVoiceId(voice)) return json({ error: "Invalid voice id." }, 400);
        this.audioVoice = voice;
        // Persist to .env (and the live config) so the choice survives restarts,
        // matching the `voice` tool. SOPHIE_TTS_SPEAKER keeps the sidecar's own
        // default speaker aligned on the next launch.
        writeEnv({ SOPHIE_SPEAK_VOICE: voice, SOPHIE_TTS_SPEAKER: voice });
        return json({ ok: true, selected: this.audioVoice, voices: await listTtsVoices() });
      }
      if (req.method === "GET" && url.pathname === "/api/settings") {
        return json(settingsPayload());
      }
      if (req.method === "POST" && url.pathname === "/api/settings") {
        const body = await req.json().catch(() => ({}));
        const parsed = parseSettingsUpdates(body?.updates);
        if ("error" in parsed) return json({ error: parsed.error }, 400);
        return json(this.applySettings(parsed.values));
      }
      if (req.method === "GET" && url.pathname === "/api/models") {
        return json(await modelsPayload());
      }
      if (req.method === "POST" && url.pathname === "/api/audio/test") {
        const body = await req.json().catch(() => ({}));
        const requested = String(body?.voice ?? "").trim();
        const voice = validVoiceId(requested) ? requested : this.audioVoice;
        const text = String(body?.text ?? "Hi, I'm Sophie. This is what this voice sounds like.").trim().slice(0, 240);
        const wav = await synthesizeToWav(text || "Hi, I'm Sophie.", voice);
        if (!wav) return json({ error: `TTS test failed at ${config.ttsBaseUrl}.` }, 503);
        return json({ ok: true, voice, mime: "audio/wav", audio: bytesToBase64(wav) });
      }
      if (req.method === "POST" && url.pathname === "/api/audio/warmup") {
        const startedAt = Date.now();
        const wav = await synthesizeToWav("Ready.", this.audioVoice);
        if (!wav) return json({ ok: false, error: `TTS warmup failed at ${config.ttsBaseUrl}.` }, 503);
        return json({ ok: true, elapsedMs: Date.now() - startedAt });
      }
      if (req.method === "POST" && url.pathname === "/api/presence/activity") {
        noteUserActivity();
        return json({ ok: true, presence: getPresence() });
      }
      if (req.method === "GET" && url.pathname === "/api/sessions") {
        return json({ sessions: listSessions() });
      }
      if (req.method === "POST" && url.pathname === "/api/sessions/new") {
        if (this.busy) return json({ error: "Sophie is busy." }, 409);
        noteUserActivity();
        noteExchange();
        this.agent.reset();
        this.sessionId = newSessionId();
        setCurrentSessionId(this.sessionId);
        this.blocks = [];
        setModeStore("normal");
        return json(this.state());
      }

      const sessionResume = url.pathname.match(/^\/api\/sessions\/([^/]+)\/resume$/);
      if (req.method === "POST" && sessionResume) {
        if (this.busy) return json({ error: "Sophie is busy." }, 409);
        noteUserActivity();
        noteExchange();
        const session = loadSession(decodeURIComponent(sessionResume[1]));
        if (!session) return json({ error: "Session not found." }, 404);
        this.restoreSession(session);
        return json(this.state());
      }

      const sessionDelete = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
      const legacySessionDelete = url.pathname.match(/^\/api\/sessions\/([^/]+)\/delete$/);
      if ((req.method === "DELETE" && sessionDelete) || (req.method === "POST" && legacySessionDelete)) {
        const id = decodeURIComponent((sessionDelete ?? legacySessionDelete)![1]);
        noteUserActivity();
        noteExchange();
        return this.deleteSession(id);
      }

      const approval = url.pathname.match(/^\/api\/approvals\/([^/]+)$/);
      if (req.method === "POST" && approval) {
        const id = decodeURIComponent(approval[1]);
        if (!this.pendingApproval || this.pendingApproval.id !== id) {
          return json({ error: "Approval is no longer pending." }, 404);
        }
        const body = await req.json().catch(() => ({}));
        const decision = body?.decision === "approve" ? "approve" : "deny";
        noteUserActivity();
        noteExchange();
        this.pendingApproval.resolve(decision);
        return json({ ok: true });
      }

      if (req.method === "POST" && url.pathname === "/api/chat") return this.chat(req);
      return json({ error: "Not found." }, 404);
    } catch (error: any) {
      return json({ error: error?.message ?? String(error) }, 500);
    }
  }

  private async chat(req: Request): Promise<Response> {
    if (this.busy) return json({ error: "Sophie is already working." }, 409);
    const input = await parseChatInput(req, this.cwd);
    if (!input.displayText.trim() && input.attachments.length === 0) {
      return json({ error: "Message or image required." }, 400);
    }
    noteUserActivity();
    noteExchange();

    const userBlock: WebBlock = {
      id: nid(),
      kind: "user",
      text: input.displayText || "Uploaded image",
      attachments: input.attachments,
    };

    this.busy = true;
    // Keep the agent turn alive if the browser closes or the phone sleeps.
    const turnController = new AbortController();

    const encoder = new TextEncoder();
    let closed = false;
    const stream = new ReadableStream<Uint8Array>({
      start: (streamController) => {
        const markClosed = () => {
          closed = true;
        };
        req.signal.addEventListener("abort", markClosed, { once: true });
        const send = (event: unknown) => {
          if (closed) return;
          try {
            streamController.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          } catch {
            closed = true;
          }
        };
        this.addBlock(userBlock, send);
        void this.runTurn(input.modelText, send, turnController.signal, input.audio)
          .catch((error) => {
            this.addBlock({ id: nid(), kind: "error", text: error?.message ?? String(error) }, send);
          })
          .finally(() => {
            this.busy = false;
            this.pendingApproval = null;
            this.save();
            send({ type: "done", state: this.state() });
            req.signal.removeEventListener("abort", markClosed);
            if (!closed) {
              closed = true;
              try {
                streamController.close();
              } catch {
                /* client already disconnected */
              }
            }
          });
      },
      cancel: () => {
        closed = true;
      },
    });

    return cors(new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson",
        "Cache-Control": "no-store",
      },
    }));
  }

  private async runTurn(
    text: string,
    send: (event: unknown) => void,
    signal: AbortSignal,
    audio: boolean,
  ): Promise<void> {
    let assistantId: string | null = null;
    let thinkingId: string | null = null;
    const toolBlocks = new Map<string, string>();
    let toolCueSpoken = false;
    const markAudibleStarted = () => {
      if (audio) send({ type: "audio_loading", action: "stop" });
    };
    const webAudio = new WebAudioStream(audio, send, this.audioVoice, markAudibleStarted);
    if (audio) send({ type: "audio_loading", action: "start" });

    try {
      await this.agent.run(
        text,
        {
          onThinking: (delta) => {
            if (!thinkingId) {
              thinkingId = nid();
              this.addBlock({ id: thinkingId, kind: "thinking", text: "" }, send);
            }
            this.appendText(thinkingId, delta, send);
          },
          onContent: (delta) => {
            if (!assistantId) {
              assistantId = nid();
              this.addBlock({ id: assistantId, kind: "assistant", text: "" }, send);
            }
            this.appendText(assistantId, delta, send);
            webAudio.push(delta);
          },
          onToolCall: (call) => {
            assistantId = null;
            thinkingId = null;
            if (call.name === "speak") {
              markAudibleStarted();
              webAudio.clearPendingText();
              webAudio.speakNow(speechTextFromToolArgs(call.args));
            } else if (!toolCueSpoken) {
              toolCueSpoken = true;
              if (audio) send({ type: "audio_loading", action: "pause" });
              if (audio) send({ type: "audio_loading", action: "resume_after_next_audio" });
              webAudio.speakNow("Let me look into that.");
            }
            const id = nid();
            toolBlocks.set(call.id, id);
            this.addBlock(
              {
                id,
                kind: "tool",
                name: call.name,
                summary: call.summary,
                risk: call.risk,
                status: "running",
              },
              send,
            );
          },
          onToolResult: (callId, result) => {
            const id = toolBlocks.get(callId);
            if (!id) {
              const text = result.display ?? clip(result.content, 240);
              if (text) this.addBlock({ id: nid(), kind: "system", text }, send);
              return;
            }
            this.patchBlock(
              id,
              {
                status: statusForToolResult(result),
                result: result.display ?? clip(result.content, 800),
              },
              send,
            );
          },
          requestApproval: (call) =>
            new Promise((resolve) => {
              const approvalId = crypto.randomUUID();
              const toolBlockId = toolBlocks.get(call.id);
              const finish = (decision: ApprovalDecision) => {
                if (this.pendingApproval?.id === approvalId) this.pendingApproval = null;
                if (toolBlockId) {
                  this.patchBlock(
                    toolBlockId,
                    decision === "approve"
                      ? { status: "running", result: "approved; running..." }
                      : { status: "denied", result: "denied" },
                    send,
                  );
                }
                resolve(decision);
              };
              this.pendingApproval = { id: approvalId, call, resolve: finish };
              if (toolBlockId) this.patchBlock(toolBlockId, { status: "awaiting" }, send);
              send({ type: "approval_required", approval: { id: approvalId, call } });
              signal.addEventListener("abort", () => finish("deny"), { once: true });
            }),
          onCheckpoint: () => this.save(),
          onError: (message) => this.addBlock({ id: nid(), kind: "error", text: message }, send),
        },
        signal,
        { source: "webapp" },
      );
      await webAudio.finish();
    } finally {
      if (audio) send({ type: "audio_loading", action: "stop" });
      webAudio.stop();
    }
  }

  private restoreSession(session: SessionState): void {
    this.sessionId = session.id;
    setCurrentSessionId(session.id);
    this.agent.restoreHistory(session.history);
    restoreCurrentJob(session.job);
    restoreTasks(session.tasks);
    restoreJournal(session.journal);
    setObjective(session.objective ?? null);
    setModeStore(session.mode);
    this.blocks = normalizeBlocks(session.blocks);
  }

  private deleteSession(id: string): Response {
    if (this.busy && id === this.sessionId) {
      return json({ error: "Cannot delete the active conversation while Sophie is working." }, 409);
    }
    const deleted = deleteSavedSession(id);
    if (!deleted) return json({ error: "Session not found." }, 404);
    if (id === this.sessionId) {
      this.agent.reset();
      this.sessionId = newSessionId();
      setCurrentSessionId(this.sessionId);
      this.blocks = [];
      this.pendingApproval = null;
      setModeStore("normal");
    }
    return json({ ok: true, state: this.state() });
  }

  /** Persist validated setting updates to .env (live via reloadConfig) and
   *  ripple the side effects the setup wizard would apply. */
  private applySettings(updates: Record<string, string>) {
    writeEnv(updates);

    // Telegram credentials changed: bounce the bridge like the wizard does.
    if ("TELEGRAM_BOT_TOKEN" in updates || "TELEGRAM_CHAT_ID" in updates) {
      stopTelegramBridge();
      if (telegramReady()) startTelegramBridge();
    }
    // Model or server changed: re-resolve the model actually loaded so the
    // next request targets it.
    if ("SOPHIE_MODEL" in updates || "SOPHIE_BASE_URL" in updates) {
      void detectLoadedModel();
    }
    // Keep the audio-mode voice in step when it changed through settings.
    const voice = updates.SOPHIE_SPEAK_VOICE;
    if (voice && validVoiceId(voice)) this.audioVoice = voice;

    const restartKeys = Object.keys(updates).filter((key) => RESTART_KEYS.has(key));
    const note = restartKeys.length
      ? "Saved. This change takes full effect the next time Sophie starts."
      : "Saved.";
    return { ok: true, note, ...settingsPayload() };
  }

  private state() {
    return {
      sessionId: this.sessionId,
      cwd: this.cwd,
      mode: getMode(),
      presence: getPresence(),
      busy: this.busy,
      blocks: this.blocks,
      tasks: getTasks(),
      sessions: listSessions(),
      pendingApproval: this.pendingApproval
        ? { id: this.pendingApproval.id, call: this.pendingApproval.call }
        : null,
    };
  }

  private save(): void {
    const history = this.agent.getHistory();
    saveSession({
      id: this.sessionId,
      title: history.length ? titleFrom(history) : "Sophie web chat",
      cwd: this.cwd,
      updatedAt: Date.now(),
      mode: getMode() as Mode,
      history,
      tasks: getTasks(),
      job: getCurrentJob(),
      journal: getJournal(),
      objective: getObjective(),
      blocks: this.blocks,
    });
    this.lastProgressSaveAt = Date.now();
  }

  private addBlock(block: WebBlock, send: (event: unknown) => void): void {
    this.blocks.push(block);
    noteExchange();
    this.saveProgress(true);
    send({ type: "block", block });
  }

  private appendText(id: string, delta: string, send: (event: unknown) => void): void {
    const block = this.blocks.find((item) => item.id === id);
    if (block && "text" in block) block.text += delta;
    noteExchange();
    this.saveProgress();
    send({ type: "delta", id, text: delta });
  }

  private patchBlock(id: string, patch: Partial<WebBlock>, send: (event: unknown) => void): void {
    const block = this.blocks.find((item) => item.id === id);
    if (block) Object.assign(block, patch);
    noteExchange();
    this.saveProgress(true);
    send({ type: "patch", id, patch });
  }

  private saveProgress(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastProgressSaveAt < 1000) return;
    this.save();
  }
}

/** Local-time midnight for the given (or current) timestamp, in epoch ms. */
function startOfDayMs(ms = Date.now()): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function numberParam(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw == null || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/** Validate a calendar event payload from the web UI. Every field is optional
 *  (updates send a subset); times are epoch ms. */
function parseEventBody(raw: unknown):
  | { value: Partial<Pick<CalendarEvent, "title" | "start" | "end" | "location" | "notes" | "attendees" | "reminderLeads">> }
  | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "Invalid event payload." };
  const body = raw as Record<string, unknown>;
  const value: Partial<Pick<CalendarEvent, "title" | "start" | "end" | "location" | "notes" | "attendees" | "reminderLeads">> = {};
  if (body.title !== undefined) {
    const title = String(body.title).trim();
    if (!title) return { error: "Title cannot be empty." };
    value.title = title;
  }
  for (const key of ["start", "end"] as const) {
    if (body[key] === undefined) continue;
    const ms = Number(body[key]);
    if (!Number.isFinite(ms)) return { error: `'${key}' must be a timestamp in milliseconds.` };
    value[key] = ms;
  }
  if (body.location !== undefined) value.location = String(body.location);
  if (body.notes !== undefined) value.notes = String(body.notes);
  if (body.attendees !== undefined) {
    if (!Array.isArray(body.attendees)) return { error: "'attendees' must be an array." };
    value.attendees = body.attendees.map(String);
  }
  if (body.reminders !== undefined) {
    if (!Array.isArray(body.reminders)) return { error: "'reminders' must be an array of minutes." };
    const leads = body.reminders.map(Number);
    if (leads.some((n) => !Number.isFinite(n) || n < 0)) return { error: "Reminder lead times must be non-negative minutes." };
    value.reminderLeads = leads;
  }
  return { value };
}

async function parseChatInput(req: Request, cwd: string): Promise<{
  displayText: string;
  modelText: string;
  attachments: WebAttachment[];
  audio: boolean;
}> {
  const form = await req.formData();
  const displayText = String(form.get("message") ?? "").trim();
  const audio = truthyFormValue(form.get("audio"));
  const attachments = await saveUploadedImages(form.getAll("images"));
  const refs = attachments.map((attachment) => `@${attachment.path}`);
  const base = displayText || "Please inspect the uploaded image.";
  const modelText = refs.length
    ? `${base}\n\nUploaded image${refs.length === 1 ? "" : "s"}: ${refs.join(" ")}`
    : base;
  return { displayText, modelText, attachments, audio };
}

async function saveUploadedImages(values: FormDataEntryValue[]): Promise<WebAttachment[]> {
  const dir = join(homedir(), ".sophie", "uploads");
  mkdirSync(dir, { recursive: true });
  const out: WebAttachment[] = [];
  for (const value of values) {
    if (!(value instanceof File) || value.size === 0) continue;
    if (value.size > MAX_IMAGE_BYTES) {
      throw new Error(`${value.name} is too large. Maximum image size is ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB.`);
    }
    const ext = extensionForUpload(value);
    if (!IMAGE_EXTENSIONS.has(ext)) {
      throw new Error(`${value.name} is not a supported image type.`);
    }
    const safeName = safeFileName(value.name || `upload${ext}`, ext);
    const path = join(dir, `${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${safeName}`);
    writeFileSync(path, Buffer.from(await value.arrayBuffer()));
    out.push({ name: value.name || basename(path), path, size: value.size, type: value.type || mimeForExt(ext) });
  }
  return out;
}

function extensionForUpload(file: File): string {
  const byName = extname(file.name || "").toLowerCase();
  if (byName) return byName;
  if (file.type === "image/png") return ".png";
  if (file.type === "image/jpeg") return ".jpg";
  if (file.type === "image/webp") return ".webp";
  if (file.type === "image/gif") return ".gif";
  if (file.type === "image/bmp") return ".bmp";
  return "";
}

function safeFileName(name: string, ext: string): string {
  const base = basename(name).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return base.toLowerCase().endsWith(ext) ? base : `${base || "upload"}${ext}`;
}

function mimeForExt(ext: string): string {
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".bmp") return "image/bmp";
  return "application/octet-stream";
}

function normalizeBlocks(blocks: unknown[]): WebBlock[] {
  if (!Array.isArray(blocks)) return [];
  return blocks
    .filter((block): block is Record<string, any> => Boolean(block) && typeof block === "object")
    .map((block) => ({ ...block, id: typeof block.id === "string" ? block.id : nid() }) as WebBlock);
}

function defaultAudioVoice(): string {
  const configured = process.env.SOPHIE_TTS_SPEAKER || config.speakVoice || "";
  return validVoiceId(configured) ? configured : "af_bella";
}

function validVoiceId(voice: string): boolean {
  return /^[ab][fm]_[a-z0-9_-]+$/i.test(voice);
}

const FALLBACK_TTS_VOICES: TtsVoice[] = [
  { id: "af_heart", language: "en-US", description: "American female - warm, natural" },
  { id: "af_bella", language: "en-US", description: "American female - clear, articulate" },
  { id: "af_nicole", language: "en-US", description: "American female - calm, professional" },
  { id: "af_sky", language: "en-US", description: "American female - bright, energetic" },
  { id: "af_sarah", language: "en-US", description: "American female - warm, conversational" },
  { id: "af_nova", language: "en-US", description: "American female - smooth, expressive" },
  { id: "bf_emma", language: "en-GB", description: "British female - natural, balanced" },
];

/** Keys whose values never leave the server; the client only learns whether
 *  one is saved. */
const SECRET_KEYS = new Set<string>(["TELEGRAM_BOT_TOKEN", "TAVILY_API_KEY", "BRAVE_API_KEY"]);

/** Keys that reloadConfig() cannot fully apply mid-process. */
const RESTART_KEYS = new Set<string>([
  "SOPHIE_TTS_AUTOSTART",
  "SOPHIE_CONTEXT_WINDOW",
  "SOPHIE_AWAY_MINUTES",
]);

const NUMBER_KEYS = new Set<string>([
  "SOPHIE_TEMPERATURE",
  "SOPHIE_TOP_P",
  "SOPHIE_MAX_TOKENS",
  "SOPHIE_CONTEXT_WINDOW",
  "SOPHIE_TIMEOUT_MS",
  "SOPHIE_AWAY_MINUTES",
]);

/** Effective values shown when a key is absent from .env — mirrors the setup
 *  wizard's initialValues so both UIs present the same defaults. */
function settingsDefaults(): Record<string, string> {
  return {
    SOPHIE_BASE_URL: config.baseUrl,
    SOPHIE_MODEL: config.model,
    SOPHIE_API_KEY: config.apiKey,
    SOPHIE_TEMPERATURE: String(config.temperature),
    SOPHIE_TOP_P: String(config.topP),
    SOPHIE_MAX_TOKENS: String(config.maxTokens),
    SOPHIE_CONTEXT_WINDOW: String(config.contextWindow),
    SOPHIE_DEFAULT_MODE: config.defaultMode,
    SOPHIE_TIMEOUT_MS: String(config.timeoutMs),
    SOPHIE_SPEAK_REPLIES: String(config.speakReplies),
    SOPHIE_SPEAK_VOICE: config.speakVoice,
    SOPHIE_TTS_BACKEND: config.ttsBackend,
    SOPHIE_TTS_BASE_URL: config.ttsBaseUrl,
    SOPHIE_TTS_STREAM_REPLIES: String(config.ttsStreamReplies),
    SOPHIE_TTS_AUTOSTART: String(config.ttsAutostart),
    SOPHIE_AWAY_MINUTES: String(process.env.SOPHIE_AWAY_MINUTES ?? 5),
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID ?? "",
  };
}

function settingsPayload(): { values: Record<string, string>; secrets: Record<string, boolean> } {
  const env = readEnvFile();
  const defaults = settingsDefaults();
  const values: Record<string, string> = {};
  const secrets: Record<string, boolean> = {};
  for (const key of ENV_KEYS) {
    const raw = env[key] ?? process.env[key] ?? "";
    if (SECRET_KEYS.has(key)) secrets[key] = Boolean(raw);
    else values[key] = raw || defaults[key] || "";
  }
  return { values, secrets };
}

function parseSettingsUpdates(raw: unknown): { values: Record<string, string> } | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "No updates provided." };
  const values: Record<string, string> = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!(ENV_KEYS as readonly string[]).includes(key)) return { error: `Unknown setting "${key}".` };
    const value = String(val ?? "").trim();
    if (value && NUMBER_KEYS.has(key) && !Number.isFinite(Number(value))) {
      return { error: `${key} must be a number.` };
    }
    if (key === "SOPHIE_DEFAULT_MODE" && !["normal", "plan", "build"].includes(value)) {
      return { error: "Default mode must be normal, plan, or build." };
    }
    if (key === "SOPHIE_TTS_BACKEND" && !["sidecar", "macos"].includes(value)) {
      return { error: "Speech engine must be sidecar or macos." };
    }
    values[key] = value;
  }
  if (!Object.keys(values).length) return { error: "No updates provided." };
  return { values };
}

/** The model in use plus every model the server exposes, for the settings page. */
async function modelsPayload() {
  const [server, active] = await Promise.all([ping(), detectLoadedModel()]);
  let models: string[] = [];
  try {
    const res = await fetch(`${config.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) {
      const data: any = await res.json();
      const entries = [
        ...(Array.isArray(data?.data) ? data.data : []),
        ...(Array.isArray(data?.models) ? data.models : []),
      ];
      models = [
        ...new Set(
          entries
            .map((entry: any) =>
              [entry?.id, entry?.model, entry?.name].find((v) => typeof v === "string" && v.trim()),
            )
            .filter((id: unknown): id is string => Boolean(id)),
        ),
      ];
    }
  } catch {
    /* server unreachable — the pill already says offline */
  }
  return { active, configured: config.model, baseUrl: config.baseUrl, server, models };
}

async function listTtsVoices(): Promise<TtsVoice[]> {
  try {
    const res = await fetch(`${config.ttsBaseUrl}/v1/voices`, { signal: AbortSignal.timeout(1500) });
    const data = (await res.json()) as { data?: TtsVoice[] };
    const voices = (data.data ?? []).filter((v) => v?.id && validVoiceId(v.id));
    return voices.length ? voices : FALLBACK_TTS_VOICES;
  } catch {
    return FALLBACK_TTS_VOICES;
  }
}

/* WebAudioStream lives in ./audio.ts so transport/session routing stays separate from synthesis. */
/*
class WebAudioStream {
  private buffer = "";
  private queue: Promise<void> = Promise.resolve();
  private stopped = false;
  private failed = false;

  constructor(
    private readonly enabled: boolean,
    private readonly send: (event: unknown) => void,
    private readonly voice: string,
    private readonly onAudioProduced: () => void,
  ) {}

  push(delta: string): void {
    if (!this.enabled || this.stopped) return;
    this.buffer += delta;
    this.flushReady(false);
  }

  clearPendingText(): void {
    this.buffer = "";
  }

  speakNow(text: string, opts: { speed?: number } = {}): void {
    const clean = cleanForWebTts(text);
    if (clean) this.enqueue(clean, opts.speed);
  }

  async finish(): Promise<void> {
    if (!this.enabled || this.stopped) return;
    this.flushReady(true);
    await this.queue;
  }

  stop(): void {
    this.stopped = true;
    this.buffer = "";
  }

  private flushReady(force: boolean): void {
    while (!this.stopped) {
      const [chunk, rest] = splitReadyChunk(this.buffer, force);
      this.buffer = rest;
      if (!chunk) break;
      const clean = cleanForWebTts(chunk);
      if (clean) this.enqueue(clean);
      force = false;
    }
  }

  private enqueue(text: string, speed?: number): void {
    if (!this.enabled || this.stopped) return;
    this.queue = this.queue.then(() => this.synthesizeAndSend(text, speed));
  }

  private async synthesizeAndSend(text: string, speed?: number): Promise<void> {
    if (this.stopped) return;
    const wav = await synthesizeToWav(text, this.voice, speed);
    if (!wav) {
      if (!this.failed) {
        this.failed = true;
        this.send({
          type: "audio_error",
          message: `Audio mode could not synthesize speech. Check SOPHIE_TTS_BASE_URL (${config.ttsBaseUrl}).`,
        });
      }
      return;
    }
    if (this.stopped) return;
    this.onAudioProduced();
    this.send({
      type: "audio",
      mime: "audio/wav",
      text,
      audio: bytesToBase64(wav),
    });
  }
}

function cleanForWebTts(text: string): string {
  return stripEmoji(cleanForSpeech(text)).replace(/\s+/g, " ").trim();
}

function stripEmoji(text: string): string {
  return text
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/[\u{1F1E6}-\u{1F1FF}]/gu, "")
    .replace(/[\u{1F3FB}-\u{1F3FF}\uFE0F\u200D]/gu, "");
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}
*/
function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

function truthyFormValue(value: FormDataEntryValue | null): boolean {
  const text = String(value ?? "").trim().toLowerCase();
  return text === "1" || text === "true" || text === "yes" || text === "on";
}

function speechTextFromToolArgs(args: Record<string, unknown>): string {
  return String(args.text ?? "")
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
    .replace(/<tool_response>[\s\S]*?<\/tool_response>/g, "")
    .replace(/^\s*(sophie\s*,?\s*)?(please\s+)?(speak|say|read\s+aloud|tell\s+me\s+out\s+loud)\s*[:,-]?\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function statusForToolResult(result: ToolResult): Extract<WebBlock, { kind: "tool" }>["status"] {
  if (result.display === "cancelled") return "cancelled";
  return result.isError ? "error" : "done";
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}...`;
}

let counter = 0;
function nid(): string {
  counter += 1;
  return `w${Date.now().toString(36)}-${counter.toString(36)}`;
}

function json(data: unknown, status = 200): Response {
  return cors(new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  }));
}

function cors(response: Response): Response {
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  response.headers.set("Access-Control-Max-Age", "86400");
  return response;
}

function envPort(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

async function choosePort(hosts: string[], requested: number): Promise<number> {
  for (let offset = 0; offset < 20; offset++) {
    const port = requested + offset;
    const results = await Promise.all(hosts.map((host) => canBind(host, port)));
    if (results.every(Boolean)) return port;
  }
  throw new Error(`No free port found starting at ${requested}.`);
}

async function canBind(host: string, port: number): Promise<boolean> {
  try {
    const server = Bun.serve({ hostname: host, port, fetch: () => new Response("ok") });
    server.stop(true);
    return true;
  } catch {
    return false;
  }
}

async function waitForHttp(url: string, timeoutMs: number, token?: string): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const headers = token ? { "x-sophie-token": token } : undefined;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000), headers });
      if (res.status < 500) return true;
    } catch {
      await Bun.sleep(500);
    }
  }
  return false;
}

async function liveExternalWebApp(): Promise<WebAppPidFile | null> {
  const file = readPidFile();
  if (!file) return null;
  if (!isPidAlive(file.ownerPid)) {
    removePidFile();
    return null;
  }
  if (await waitForHttp(`${file.localWebUrl ?? file.webUrl}/api/state`, 1200, file.token)) return file;
  removePidFile();
  return null;
}

function writePidFile(file: WebAppPidFile): void {
  mkdirSync(join(homedir(), ".sophie"), { recursive: true });
  // Owner-only: the file carries the API token.
  writeFileSync(PID_PATH, JSON.stringify(file, null, 2), { mode: 0o600 });
}

function readPidFile(): WebAppPidFile | null {
  if (!existsSync(PID_PATH)) return null;
  try {
    const parsed = JSON.parse(readFileSync(PID_PATH, "utf8")) as WebAppPidFile;
    return typeof parsed?.ownerPid === "number" ? parsed : null;
  } catch {
    return null;
  }
}

function removePidFile(): void {
  if (existsSync(PID_PATH)) rmSync(PID_PATH, { force: true });
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function openBrowser(url: string): Promise<void> {
  const command =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  try {
    Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
  } catch {
    /* Opening the browser is best-effort; the URL is still shown. */
  }
}
