import { config } from "../config.ts";
import { speak, synthesizeToWav, playWavBytes } from "./notify.ts";

const MIN_CHUNK_CHARS = 80;
const MAX_CHUNK_CHARS = 260;

export function cleanForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " code block omitted. ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_#>~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function splitReadyChunk(buffer: string, force = false): [string | null, string] {
  const normalized = buffer.replace(/\s+/g, " ");
  if (!normalized.trim()) return [null, ""];

  const punctuation = [...normalized.matchAll(/[.!?。！？]\s+/g)].map((m) => (m.index ?? 0) + m[0].length);
  const goodBoundary = punctuation.find((idx) => idx >= MIN_CHUNK_CHARS);
  if (goodBoundary !== undefined) {
    return [normalized.slice(0, goodBoundary).trim(), normalized.slice(goodBoundary)];
  }

  if (normalized.length >= MAX_CHUNK_CHARS) {
    const window = normalized.slice(0, MAX_CHUNK_CHARS);
    const soft = Math.max(window.lastIndexOf(", "), window.lastIndexOf("; "), window.lastIndexOf(": "));
    const space = window.lastIndexOf(" ");
    const idx = soft >= MIN_CHUNK_CHARS ? soft + 2 : space >= MIN_CHUNK_CHARS ? space + 1 : MAX_CHUNK_CHARS;
    return [normalized.slice(0, idx).trim(), normalized.slice(idx)];
  }

  if (force && normalized.trim()) return [normalized.trim(), ""];
  return [null, normalized];
}

/**
 * Pipelined streaming TTS. As LLM tokens arrive, sentence boundaries are
 * detected and synthesis is fired immediately — so the next chunk is already
 * synthesizing while the current one plays. This eliminates the inter-sentence
 * gap: playback is continuous with no idle synthesis time between sentences.
 *
 * Pass `enabled: true` to activate (controlled by audio mode in the TUI).
 *
 * Pipeline:
 *   LLM delta → push() → sentence detector → synthesize() [fires immediately]
 *                                                ↓ (Promise<WAV | null>)
 *                                            ordered queue
 *                                                ↓
 *                                        sequential playback
 */
export class StreamingSpeech {
  private buffer = "";
  // Each entry is a Promise<WAV bytes>. They're enqueued in sentence order
  // and synthesis starts the moment the sentence text is complete — so by
  // the time the previous sentence finishes playing, the next WAV is ready.
  private synthQueue: Promise<Uint8Array | null>[] = [];
  private playing = false;
  private stopped = false;
  private firstError: string | null = null;
  private idleResolve: (() => void) | null = null;

  constructor(private readonly enabled: boolean, private readonly voice?: string) {}

  push(delta: string): void {
    if (this.stopped || !this.enabled) return;
    this.buffer += delta;
    this.flushReady(false);
  }

  async finish(): Promise<{ ok: boolean; detail: string }> {
    if (!this.enabled) return { ok: true, detail: "audio mode off" };
    this.flushReady(true);
    await this.drain();
    return this.firstError ? { ok: false, detail: this.firstError } : { ok: true, detail: "streamed speech" };
  }

  stop(): void {
    this.stopped = true;
    this.buffer = "";
    this.synthQueue = [];
    this.idleResolve?.();
    this.idleResolve = null;
  }

  private flushReady(force: boolean): void {
    while (!this.stopped) {
      const [chunk, rest] = splitReadyChunk(this.buffer, force);
      this.buffer = rest;
      if (!chunk) break;
      const clean = cleanForSpeech(chunk);
      if (clean) {
        if (config.ttsBackend === "sidecar") {
          // Fire synthesis immediately — don't wait for playback to finish.
          this.synthQueue.push(synthesizeToWav(clean, this.voice ?? config.speakVoice));
        } else {
          // Fallback: wrap macOS `say` as a promise that returns null (plays inline).
          this.synthQueue.push(speak(clean, this.voice).then(() => null));
        }
        this.startPlayer();
      }
      force = false;
    }
  }

  private startPlayer(): void {
    if (this.playing || this.stopped) return;
    this.playing = true;
    void this.playerLoop();
  }

  private async playerLoop(): Promise<void> {
    while (!this.stopped && this.synthQueue.length > 0) {
      const wavPromise = this.synthQueue.shift()!;
      try {
        const wav = await wavPromise;
        if (this.stopped) break;
        if (wav) {
          const r = await playWavBytes(wav);
          if (!r.ok && !this.firstError) this.firstError = r.detail;
        }
        // null means playback already happened inline (macOS `say` fallback)
      } catch (e: any) {
        if (!this.firstError) this.firstError = e?.message ?? String(e);
      }
    }
    this.playing = false;
    this.idleResolve?.();
    this.idleResolve = null;
  }

  private drain(): Promise<void> {
    if (!this.playing && this.synthQueue.length === 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.idleResolve = resolve;
    });
  }
}
