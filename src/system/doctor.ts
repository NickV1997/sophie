/**
 * /doctor — one screen that says why something is broken, instead of letting
 * it fail mid-turn. Probes every external dependency Sophie leans on and
 * reports ✓ / ✗ / ― (not configured) per line. All probes run in parallel
 * with short timeouts; a hung dependency reads as a failure, not a hang.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { config, getContextWindow, REPO_ROOT } from "../config.ts";
import { ping } from "../llm/client.ts";
import { telegramConfigured, telegramReady, telegramToken } from "../channels/telegram.ts";
import { listSchedule } from "../agent/scheduler.ts";
import { listWatchers } from "../agent/watcher.ts";
import { listMemories } from "../memory/facts.ts";
import { embeddingsAvailable } from "../memory/embeddings.ts";
import { MEMORY_DIR } from "../memory/store.ts";
import { fetchWithTimeout } from "../system/net.ts";
import { ttsStatus } from "../tts/service.ts";
import { undoStats } from "./undo.ts";

const OK = "✓";
const BAD = "✗";
const OFF = "―";

function line(mark: string, name: string, detail: string): string {
  return `${mark} ${name.padEnd(12)} ${detail}`;
}

async function checkModel(): Promise<string> {
  const res = await ping();
  return res.ok
    ? line(OK, "model", `${config.model} @ ${config.baseUrl} · ctx ${getContextWindow()} tokens`)
    : line(BAD, "model", res.detail);
}

async function checkEmbeddings(): Promise<string> {
  if (!config.embeddings) return line(OFF, "embeddings", "disabled (SOPHIE_EMBEDDINGS=false) — keyword recall only");
  if (!embeddingsAvailable()) return line(BAD, "embeddings", `${config.embeddingsUrl} rejected an earlier request this session — keyword recall fallback active`);
  try {
    const res = await fetchWithTimeout(`${config.embeddingsUrl}/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({ model: config.embeddingsModel, input: ["ping"] }),
      timeoutMs: 8000,
    });
    if (!res.ok) return line(BAD, "embeddings", `${config.embeddingsUrl}/embeddings responded ${res.status} — semantic recall will fall back to keywords`);
    const json: any = await res.json();
    const dim = json?.data?.[0]?.embedding?.length;
    return line(OK, "embeddings", `${config.embeddingsModel} @ ${config.embeddingsUrl}${dim ? ` · ${dim} dims` : ""}`);
  } catch (e: any) {
    return line(BAD, "embeddings", `${config.embeddingsUrl} unreachable (${e?.message ?? e})`);
  }
}

async function checkTts(): Promise<string> {
  if (config.ttsBackend === "macos") {
    if (platform() !== "darwin") return line(BAD, "speech", "backend 'macos' but this is not macOS");
    return line(OK, "speech", `macOS say${config.speakVoice ? ` · voice ${config.speakVoice}` : ""}`);
  }
  const tts = ttsStatus();
  if (!tts.enabled) return line(OFF, "speech", "Sophie Kokoro autostart disabled");
  if (!existsSync(tts.python)) return line(BAD, "speech", `missing Sophie TTS Python: ${tts.python}`);
  if (!existsSync(tts.model)) return line(BAD, "speech", `missing Kokoro model: ${tts.model}`);
  if (!existsSync(tts.voices)) return line(BAD, "speech", `missing Kokoro voices: ${tts.voices}`);
  try {
    const res = await fetchWithTimeout(`${config.ttsBaseUrl}/health`, { timeoutMs: 3000 });
    return line(OK, "speech", `Sophie Kokoro @ ${config.ttsBaseUrl} (HTTP ${res.status})`);
  } catch {
    return line(BAD, "speech", `Sophie Kokoro @ ${config.ttsBaseUrl} not running yet — it starts with the sophie command`);
  }
}

async function checkTelegram(): Promise<string> {
  if (!telegramConfigured()) return line(OFF, "telegram", "no TELEGRAM_BOT_TOKEN — remote messaging off (/setup to add)");
  if (!telegramReady()) return line(BAD, "telegram", "token set but no TELEGRAM_CHAT_ID yet — message the bot once to link");
  try {
    const res = await fetchWithTimeout(`https://api.telegram.org/bot${telegramToken()}/getMe`, { timeoutMs: 6000 });
    const json: any = await res.json().catch(() => null);
    return json?.ok
      ? line(OK, "telegram", `bot @${json.result?.username ?? "?"} linked`)
      : line(BAD, "telegram", `Telegram API rejected the token (HTTP ${res.status})`);
  } catch (e: any) {
    return line(BAD, "telegram", `cannot reach api.telegram.org (${e?.message ?? e})`);
  }
}

function checkMcp(cwd: string): string {
  const candidates = [join(cwd, "mcp.json"), join(REPO_ROOT, "mcp.json")];
  const found = candidates.find((p) => existsSync(p));
  if (!found) return line(OFF, "mcp", "no mcp.json — no MCP servers configured");
  try {
    const json = JSON.parse(readFileSync(found, "utf8"));
    const servers = Object.keys(json?.mcpServers ?? json?.servers ?? {});
    return line(OK, "mcp", `${servers.length} server${servers.length === 1 ? "" : "s"} configured (${servers.join(", ") || "none"}) — connect status shows at startup`);
  } catch {
    return line(BAD, "mcp", `${found} is not valid JSON`);
  }
}

async function checkBrowser(): Promise<string> {
  const bins = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ];
  const found = bins.find((p) => existsSync(p));
  return found
    ? line(OK, "browser", `${found.split("/").filter(Boolean).slice(-1)[0]} available for browser_act/browser_check`)
    : line(BAD, "browser", "no Chrome/Chromium found — browser tools unavailable");
}

async function checkDocs(): Promise<string> {
  const probe = async (cmd: string) => {
    try {
      const proc = Bun.spawn(["which", cmd], { stdout: "ignore", stderr: "ignore" });
      return (await proc.exited) === 0;
    } catch {
      return false;
    }
  };
  const pdftotext = await probe("pdftotext");
  const darwin = platform() === "darwin";
  const pdf = pdftotext ? "pdftotext" : darwin ? "PDFKit (built-in)" : null;
  const office = darwin ? "textutil (built-in)" : (await probe("pandoc")) ? "pandoc" : null;
  if (pdf && office) return line(OK, "documents", `pdf via ${pdf} · docx/rtf via ${office}`);
  return line(BAD, "documents", `${pdf ? "" : "no PDF extractor (brew install poppler) "}${office ? "" : "no docx/rtf converter (install pandoc)"}`.trim());
}

function checkStores(cwd: string): string[] {
  const out: string[] = [];
  try {
    const sessionsDir = join(MEMORY_DIR, "sessions");
    const sessions = existsSync(sessionsDir) ? readdirSync(sessionsDir).filter((f) => f.endsWith(".json")) : [];
    const bytes = sessions.reduce((n, f) => n + statSync(join(sessionsDir, f)).size, 0);
    out.push(line(OK, "sessions", `${sessions.length} saved · ${(bytes / 1024).toFixed(0)} KB`));
  } catch {
    out.push(line(BAD, "sessions", `cannot read ${join(MEMORY_DIR, "sessions")}`));
  }
  try {
    const facts = listMemories("user", cwd).length + listMemories("project", cwd).length;
    out.push(line(OK, "memory", `${facts} facts stored (${MEMORY_DIR})`));
  } catch (e: any) {
    out.push(line(BAD, "memory", `store unreadable: ${e?.message ?? e}`));
  }
  const undo = undoStats();
  out.push(line(OK, "undo", `${undo.groups} checkpointed turn${undo.groups === 1 ? "" : "s"} (${undo.entries} file changes) — /undo reverts the latest`));
  const schedules = listSchedule().length;
  const watchers = listWatchers().filter((w) => w.enabled).length;
  out.push(line(OK, "triggers", `${schedules} scheduled · ${watchers} watcher${watchers === 1 ? "" : "s"} active`));
  return out;
}

export async function runDoctor(cwd: string): Promise<string> {
  const settle = (p: Promise<string>, name: string) =>
    p.catch((e: any) => line(BAD, name, `check crashed: ${e?.message ?? e}`));
  const [model, embeddings, tts, telegram, browser, docs] = await Promise.all([
    settle(checkModel(), "model"),
    settle(checkEmbeddings(), "embeddings"),
    settle(checkTts(), "speech"),
    settle(checkTelegram(), "telegram"),
    settle(checkBrowser(), "browser"),
    settle(checkDocs(), "documents"),
  ]);
  const lines = [model, embeddings, tts, telegram, checkMcp(cwd), browser, docs, ...checkStores(cwd)];
  const bad = lines.filter((l) => l.startsWith(BAD)).length;
  return [
    `Sophie doctor — ${bad === 0 ? "all systems go" : `${bad} problem${bad === 1 ? "" : "s"} found`}`,
    ...lines,
  ].join("\n");
}
