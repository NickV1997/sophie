import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, reloadConfig } from "../config.ts";

/**
 * .env reader/writer for the setup wizard. Sophie's config is a single .env in
 * the repo root (loaded by config.ts). The wizard needs to (1) read the current
 * values as defaults and (2) write the user's answers back without destroying
 * the file's comments/structure. So we upsert keys in place — existing lines are
 * rewritten where they sit, new keys are appended — and mirror the values into
 * process.env + reloadConfig() so they take effect for the running session.
 */

const ENV_PATH = join(REPO_ROOT, ".env");

/** Keys the wizard manages, in a sensible order for appending new ones. */
export const ENV_KEYS = [
  "SOPHIE_BASE_URL",
  "SOPHIE_MODEL",
  "SOPHIE_API_KEY",
  "SOPHIE_TEMPERATURE",
  "SOPHIE_TOP_P",
  "SOPHIE_MAX_TOKENS",
  "SOPHIE_CONTEXT_WINDOW",
  "SOPHIE_DEFAULT_MODE",
  "SOPHIE_TIMEOUT_MS",
  "SOPHIE_SPEAK_REPLIES",
  "SOPHIE_SPEAK_VOICE",
  "SOPHIE_TTS_BACKEND",
  "SOPHIE_TTS_BASE_URL",
  "SOPHIE_TTS_STREAM_REPLIES",
  "SOPHIE_TTS_AUTOSTART",
  "SOPHIE_MODEL_DIR",
  "SOPHIE_TTS_MODEL",
  "SOPHIE_TTS_VOICES",
  "SOPHIE_TTS_SPEAKER",
  "TAVILY_API_KEY",
  "BRAVE_API_KEY",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "SOPHIE_AWAY_MINUTES",
  "SOPHIE_LOCATION_LOOKUP",
  "SOPHIE_EMAIL_ADDRESS",
  "SOPHIE_EMAIL_APP_PASSWORD",
  "SOPHIE_EMAIL_IMAP_HOST",
  "SOPHIE_EMAIL_IMAP_PORT",
  "SOPHIE_EMAIL_SMTP_HOST",
  "SOPHIE_EMAIL_SMTP_PORT",
] as const;

/** Values the setup wizard must leave filled before Sophie can start normally.
 * Optional integrations like Telegram, search, voice name, and specific TTS
 * model paths may stay blank. Gmail app-password setup is required because
 * Sophie depends on email for public-release assistant behavior. */
export const REQUIRED_SETUP_ENV_KEYS = [
  "SOPHIE_BASE_URL",
  "SOPHIE_MODEL",
  "SOPHIE_API_KEY",
  "SOPHIE_TEMPERATURE",
  "SOPHIE_TOP_P",
  "SOPHIE_MAX_TOKENS",
  "SOPHIE_CONTEXT_WINDOW",
  "SOPHIE_DEFAULT_MODE",
  "SOPHIE_TIMEOUT_MS",
  "SOPHIE_SPEAK_REPLIES",
  "SOPHIE_TTS_BACKEND",
  "SOPHIE_TTS_STREAM_REPLIES",
  "SOPHIE_TTS_AUTOSTART",
  "SOPHIE_AWAY_MINUTES",
  "SOPHIE_EMAIL_ADDRESS",
  "SOPHIE_EMAIL_APP_PASSWORD",
  "SOPHIE_EMAIL_IMAP_HOST",
  "SOPHIE_EMAIL_IMAP_PORT",
  "SOPHIE_EMAIL_SMTP_HOST",
  "SOPHIE_EMAIL_SMTP_PORT",
] as const;

/** Parse the raw .env into a plain key→value map (unquoted). */
export function readEnvFile(): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(ENV_PATH)) return out;
  const raw = readFileSync(ENV_PATH, "utf8");
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
    out[key] = value;
  }
  return out;
}

export function missingRequiredSetupEnv(env = readEnvFile()): string[] {
  return REQUIRED_SETUP_ENV_KEYS.filter((key) => !(env[key] ?? "").trim());
}

export function requiredSetupEnvComplete(): boolean {
  return missingRequiredSetupEnv().length === 0;
}

/** Quote a value only when it needs it (whitespace or a comment char). */
function formatValue(value: string): string {
  return /[\s#'"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

/**
 * Upsert the given keys into .env, preserving all comments and ordering. Values
 * are also written into process.env and applied via reloadConfig() so the change
 * is live. A key mapped to "" is written as an empty assignment (i.e. "unset").
 */
export function writeEnv(updates: Record<string, string>): void {
  const lines = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8").split("\n") : [];
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key in updates) {
      lines[i] = `${key}=${formatValue(updates[key])}`;
      seen.add(key);
    }
  }

  const appended = Object.keys(updates).filter((k) => !seen.has(k));
  if (appended.length) {
    if (lines.length && lines[lines.length - 1].trim() !== "") lines.push("");
    // Append in the canonical ENV_KEYS order, then anything else.
    const ordered = [
      ...ENV_KEYS.filter((k) => appended.includes(k)),
      ...appended.filter((k) => !ENV_KEYS.includes(k as any)),
    ];
    for (const key of ordered) lines.push(`${key}=${formatValue(updates[key])}`);
  }

  const body = lines.join("\n");
  writeFileSync(ENV_PATH, body.endsWith("\n") ? body : `${body}\n`);

  // Make the values live for the running process.
  for (const [key, value] of Object.entries(updates)) process.env[key] = value;
  reloadConfig();
}
