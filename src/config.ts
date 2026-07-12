import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getSecret } from "./system/secrets.ts";

/** Absolute path to the Sophie repo root (this file lives in <root>/src). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Minimal .env loader. Sophie is launched from arbitrary working directories,
 * so we explicitly load the repo's own .env rather than relying on cwd.
 * Existing process.env values win (so `SOPHIE_MODEL=x sophie` still works).
 */
function loadDotEnv(): void {
  const envPath = join(REPO_ROOT, ".env");
  if (!existsSync(envPath)) return;
  const raw = readFileSync(envPath, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv();

function str(key: string, fallback: string): string {
  const v = process.env[key];
  return v === undefined || v === "" ? fallback : v;
}
function num(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function bool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  return /^(1|true|yes|on)$/i.test(v);
}

export type Mode = "normal" | "plan" | "build";
export type ResourceProfile = "small" | "balanced" | "large";

export interface Config {
  baseUrl: string;
  model: string;
  apiKey: string;
  temperature: number;
  topP: number;
  topK: number;
  minP: number;
  repeatPenalty: number;
  maxTokens: number;
  contextWindow: number;
  /** Hard ceiling on working-history tokens before compaction fires, regardless
   *  of how large contextWindow is. A big window (e.g. 200k) does NOT keep a
   *  small model coherent using all of it, so we cap the history it reasons over
   *  and compact past this. */
  maxHistoryTokens: number;
  defaultMode: Mode;
  timeoutMs: number;
  resourceProfile: ResourceProfile;
  /** Send a lazy GBNF grammar so llama.cpp can hard-constrain tool-call JSON.
   *  Harmless elsewhere (ignored, or auto-disabled on rejection). */
  toolGrammar: boolean;
  /** Draft-model name for llama.cpp speculative decoding (informational: the
   *  pairing is configured server-side; see scripts/serve.sh). */
  draftModel: string;
  speakReplies: boolean;
  speakVoice: string;
  ttsBackend: "sidecar" | "macos";
  ttsBaseUrl: string;
  ttsStreamReplies: boolean;
  ttsAutostart: boolean;
  /** Semantic memory retrieval via an OpenAI-compatible /embeddings endpoint.
   *  Defaults to the main model server; latched off for the session on the
   *  first failure, so servers without embeddings cost one request, ever. */
  embeddings: boolean;
  embeddingsUrl: string;
  embeddingsModel: string;
  /** Gmail app-password settings for local IMAP/SMTP email access. */
  emailAddress: string;
  emailAppPassword: string;
  emailImapHost: string;
  emailImapPort: number;
  emailSmtpHost: string;
  emailSmtpPort: number;
}

function ttsBackend(): "sidecar" | "macos" {
  const value = str("SOPHIE_TTS_BACKEND", "sidecar").toLowerCase();
  if (value === "macos") return "macos";
  if (value === "sidecar" || value === "piper" || value === "kokoro") return "sidecar";
  return "sidecar";
}

function computeConfig(): Config {
  return {
    baseUrl: str("SOPHIE_BASE_URL", "http://localhost:11434/v1").replace(/\/+$/, ""),
    model: str("SOPHIE_MODEL", "qwen3"),
    apiKey: getSecret("SOPHIE_API_KEY") || "local",
    temperature: num("SOPHIE_TEMPERATURE", 0.6),
    topP: num("SOPHIE_TOP_P", 0.95),
    // Qwen3 recommendation: top_k=20 tightens the nucleus; min_p=0 is their
    // baseline (a small positive like 0.05 also works well in practice).
    topK: num("SOPHIE_TOP_K", 20),
    minP: num("SOPHIE_MIN_P", 0),
    // Small repeat_penalty prevents model-level output loops before Sophie's
    // loop detection even fires. 1.05 is barely perceptible on text quality.
    repeatPenalty: num("SOPHIE_REPEAT_PENALTY", 1.05),
    maxTokens: num("SOPHIE_MAX_TOKENS", 8192),
    contextWindow: num("SOPHIE_CONTEXT_WINDOW", 32768),
    maxHistoryTokens: num("SOPHIE_MAX_HISTORY_TOKENS", 24000),
    defaultMode: (["normal", "plan", "build"].includes(str("SOPHIE_DEFAULT_MODE", "normal"))
      ? str("SOPHIE_DEFAULT_MODE", "normal")
      : "normal") as Mode,
    timeoutMs: num("SOPHIE_TIMEOUT_MS", 600_000),
    resourceProfile: (["small", "balanced", "large"].includes(str("SOPHIE_RESOURCE_PROFILE", "balanced"))
      ? str("SOPHIE_RESOURCE_PROFILE", "balanced")
      : "balanced") as ResourceProfile,
    toolGrammar: bool("SOPHIE_TOOL_GRAMMAR", true),
    draftModel: str("SOPHIE_DRAFT_MODEL", ""),
    speakReplies: bool("SOPHIE_SPEAK_REPLIES", false),
    speakVoice: str("SOPHIE_SPEAK_VOICE", ""),
    ttsBackend: ttsBackend(),
    ttsBaseUrl: str("SOPHIE_TTS_BASE_URL", "http://127.0.0.1:8090").replace(/\/+$/, ""),
    ttsStreamReplies: bool("SOPHIE_TTS_STREAM_REPLIES", false),
    ttsAutostart: bool("SOPHIE_TTS_AUTOSTART", false),
    embeddings: bool("SOPHIE_EMBEDDINGS", true),
    embeddingsUrl: str("SOPHIE_EMBEDDINGS_URL", str("SOPHIE_BASE_URL", "http://localhost:11434/v1")).replace(/\/+$/, ""),
    embeddingsModel: str("SOPHIE_EMBEDDINGS_MODEL", str("SOPHIE_MODEL", "qwen3")),
    emailAddress: str("SOPHIE_EMAIL_ADDRESS", ""),
    emailAppPassword: getSecret("SOPHIE_EMAIL_APP_PASSWORD"),
    emailImapHost: str("SOPHIE_EMAIL_IMAP_HOST", "imap.gmail.com"),
    emailImapPort: num("SOPHIE_EMAIL_IMAP_PORT", 993),
    emailSmtpHost: str("SOPHIE_EMAIL_SMTP_HOST", "smtp.gmail.com"),
    emailSmtpPort: num("SOPHIE_EMAIL_SMTP_PORT", 465),
  };
}

/** Live config object. Mutated in place by reloadConfig so existing imports of
 *  `config` see updated values after the setup wizard rewrites .env. */
export const config: Config = computeConfig();

/**
 * Recompute every config field from the current process.env. The setup wizard
 * calls this right after it writes new values into process.env and .env, so
 * changes to model/speech/etc. take effect without a restart. Keeps the same
 * `config` object reference so modules that captured it stay in sync.
 */
export function reloadConfig(): void {
  Object.assign(config, computeConfig());
}

/**
 * Effective context window actually used for budgeting/compaction. Starts at
 * the configured value but is lowered at startup to whatever the model server
 * reports (llama.cpp n_ctx), so we never build a request larger than the server
 * will accept. config.contextWindow stays the user's ceiling; this is the floor
 * of (configured, server-reported).
 */
let runtimeContextWindow = config.contextWindow;

export function getContextWindow(): number {
  return runtimeContextWindow;
}

/** Lower the effective window to the server's real limit. Never raises it above
 *  the user-configured ceiling. */
export function setContextWindow(serverNCtx: number): void {
  if (Number.isFinite(serverNCtx) && serverNCtx > 0) {
    runtimeContextWindow = Math.min(config.contextWindow, Math.floor(serverNCtx));
  }
}
