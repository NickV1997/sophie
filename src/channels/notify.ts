/**
 * Unified outbound notifier. Sophie reaches the user through whatever channels
 * are available: a native desktop notification (always, on macOS), Telegram (if
 * configured), and optionally spoken aloud. Used by the `notify` tool, the
 * scheduler when a reminder fires, and the presence system when Sophie goes away.
 */
import { platform } from "node:os";
import { tmpdir } from "node:os";
import { existsSync, unlinkSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.ts";
import { sendTelegram, telegramReady } from "./telegram.ts";

export type NotifyChannel = "desktop" | "telegram" | "voice";

export interface NotifyResult {
  delivered: NotifyChannel[];
  failed: { channel: NotifyChannel; detail: string }[];
}

export interface NotifyOptions {
  title?: string;
  /** Restrict to specific channels. Default: desktop + telegram. */
  channels?: NotifyChannel[];
  /** Also speak the message aloud (macOS `say`). */
  voice?: boolean;
  /** Play a sound / mark the desktop notification as attention-worthy. */
  urgent?: boolean;
}

const DEFAULT_FEMALE_VOICE = "Samantha";
const FEMALE_VOICES = new Set([
  "alice",
  "allison",
  "alva",
  "amelie",
  "amira",
  "anna",
  "ava",
  "carmit",
  "damayanti",
  "daria",
  "ellen",
  "fiona",
  "flo",
  "geeta",
  "grandma",
  "joana",
  "kanya",
  "karen",
  "kate",
  "kyoko",
  "laura",
  "lekha",
  "luciana",
  "mei-jia",
  "melina",
  "moira",
  "monica",
  "nora",
  "paulina",
  "samantha",
  "sara",
  "serena",
  "shelley",
  "soumya",
  "tessa",
  "ting-ting",
  "veena",
  "victoria",
  "xinyi",
  "yuna",
  "zosia",
]);

function voiceKey(voice: string): string {
  return voice.trim().replace(/\s+\(.+$/, "").toLowerCase();
}

export function isFemaleVoice(voice: string | undefined): boolean {
  return !!voice && FEMALE_VOICES.has(voiceKey(voice));
}

export function femaleVoiceOrDefault(voice: string | undefined): string {
  return isFemaleVoice(voice) ? voice!.trim() : DEFAULT_FEMALE_VOICE;
}

/** Send a message to the user across the chosen channels. */
export async function notifyUser(message: string, opts: NotifyOptions = {}): Promise<NotifyResult> {
  const text = message.trim();
  const title = (opts.title ?? "Sophie").trim() || "Sophie";
  const channels = new Set<NotifyChannel>(opts.channels ?? ["desktop", "telegram"]);
  if (opts.voice) channels.add("voice");

  const delivered: NotifyChannel[] = [];
  const failed: NotifyResult["failed"] = [];

  if (channels.has("desktop")) {
    const r = await desktopNotify(title, text, opts.urgent);
    r.ok ? delivered.push("desktop") : failed.push({ channel: "desktop", detail: r.detail });
  }
  if (channels.has("telegram")) {
    if (telegramReady()) {
      const r = await sendTelegram(`${title === "Sophie" ? "" : `*${title}*\n`}${text}`);
      r.ok ? delivered.push("telegram") : failed.push({ channel: "telegram", detail: r.detail });
    } else {
      failed.push({ channel: "telegram", detail: "not configured" });
    }
  }
  if (channels.has("voice")) {
    failed.push({ channel: "voice", detail: "voice is only available through the speak tool" });
  }

  return { delivered, failed };
}

/** A short one-line summary of where a notification went, for tool output. */
export function summarizeDelivery(r: NotifyResult): string {
  const parts: string[] = [];
  if (r.delivered.length) parts.push(`delivered via ${r.delivered.join(", ")}`);
  if (r.failed.length) parts.push(`failed: ${r.failed.map((f) => `${f.channel} (${f.detail})`).join(", ")}`);
  return parts.join("; ") || "no channels available";
}

// ── platform primitives ──────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function desktopNotify(title: string, body: string, urgent?: boolean): Promise<{ ok: boolean; detail: string }> {
  try {
    if (platform() === "darwin") {
      const sound = urgent ? ' sound name "Ping"' : "";
      const script = `display notification "${esc(body)}" with title "${esc(title)}"${sound}`;
      const proc = Bun.spawn(["osascript", "-e", script], { stdout: "ignore", stderr: "pipe" });
      const code = await proc.exited;
      if (code !== 0) return { ok: false, detail: (await new Response(proc.stderr).text()).trim() || `exit ${code}` };
      return { ok: true, detail: "macOS notification" };
    }
    if (platform() === "linux") {
      const proc = Bun.spawn(["notify-send", urgent ? "-u" : "-u", urgent ? "critical" : "normal", title, body], {
        stdout: "ignore",
        stderr: "ignore",
      });
      const code = await proc.exited;
      return code === 0 ? { ok: true, detail: "notify-send" } : { ok: false, detail: "notify-send unavailable" };
    }
    return { ok: false, detail: `no desktop notifier for ${platform()}` };
  } catch (e: any) {
    return { ok: false, detail: e?.message ?? "notifier failed" };
  }
}

async function playFile(file: string): Promise<{ ok: boolean; detail: string }> {
  const play = Bun.spawn(["afplay", file], { stdout: "ignore", stderr: "pipe" });
  const playCode = await play.exited;
  const playErr = (await new Response(play.stderr).text()).trim();
  return playCode === 0
    ? { ok: true, detail: "afplay" }
    : { ok: false, detail: playErr || `afplay exit ${playCode}` };
}

/** Kokoro voice names understood by the sidecar (bf_ = British, af_ = American). */
function isKokoroVoice(v: string | undefined): boolean {
  return !!v && /^[ab][fm]_/.test(v);
}

/** Synthesize text → raw WAV bytes via the TTS sidecar. Returns null on any failure. */
export async function synthesizeToWav(text: string, voice?: string, speed?: number): Promise<Uint8Array | null> {
  // Prefer the configured Kokoro voice; ignore macOS `say` voice names passed in.
  const kokoroVoice = isKokoroVoice(voice) ? voice!
    : isKokoroVoice(config.speakVoice) ? config.speakVoice!
    : "bf_emma";
  try {
    const res = await fetch(`${config.ttsBaseUrl}/v1/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "local-tts",
        input: text,
        voice: kokoroVoice,
        ...(speed ? { speed } : {}),
        response_format: "wav",
      }),
    });
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/** Play raw WAV bytes (writes to a temp file, plays with afplay, cleans up). */
export async function playWavBytes(wav: Uint8Array): Promise<{ ok: boolean; detail: string }> {
  const file = join(tmpdir(), `sophie-tts-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
  try {
    await writeFile(file, wav);
    return await playFile(file);
  } finally {
    if (existsSync(file)) unlinkSync(file);
  }
}

async function speakSidecar(text: string, voice?: string): Promise<{ ok: boolean; detail: string }> {
  // synthesizeToWav already resolves macOS voice names → Kokoro voice names
  const wav = await synthesizeToWav(text, voice);
  if (!wav) return { ok: false, detail: "tts sidecar unavailable or returned no audio" };
  const played = await playWavBytes(wav);
  return played.ok ? { ok: true, detail: `spoke via TTS sidecar at ${config.ttsBaseUrl}` } : played;
}

/** Speak text aloud. Prefers the configured neural backend, with macOS fallback. */
export async function speak(text: string, voice?: string): Promise<{ ok: boolean; detail: string }> {
  const body = text.trim().slice(0, 1000);
  if (!body) return { ok: false, detail: "nothing to say" };
  try {
    if (config.ttsBackend === "sidecar") {
      const sidecar = await speakSidecar(body, voice);
      if (sidecar.ok) return sidecar;
      // Fall through to OS TTS so speaking still works if the sidecar is down.
    }
    if (platform() === "darwin") {
      const selectedVoice = femaleVoiceOrDefault(voice);
      const file = join(tmpdir(), `sophie-voice-${Date.now()}-${Math.random().toString(36).slice(2)}.aiff`);
      const via = `say voice=${selectedVoice}`;
      try {
        const render = Bun.spawn(["say", "-v", selectedVoice, "-o", file, body], { stdout: "ignore", stderr: "pipe" });
        const renderCode = await render.exited;
        const renderErr = (await new Response(render.stderr).text()).trim();
        if (renderCode !== 0) return { ok: false, detail: renderErr || `${via} render exit ${renderCode}` };

        const played = await playFile(file);
        return played.ok ? { ok: true, detail: `spoke via ${via} + afplay` } : played;
      } finally {
        if (existsSync(file)) unlinkSync(file);
      }
    }
    // espeak / spd-say are common on Linux; try espeak-ng then espeak.
    for (const bin of ["espeak-ng", "espeak"]) {
      try {
        const proc = Bun.spawn([bin, "-v", "en+f3", body], { stdout: "ignore", stderr: "ignore" });
        const code = await proc.exited;
        if (code === 0) return { ok: true, detail: `spoke via ${bin}` };
      } catch {
        /* try next */
      }
    }
    return { ok: false, detail: `no TTS engine for ${platform()}` };
  } catch (e: any) {
    return { ok: false, detail: e?.message ?? "tts failed" };
  }
}
