import { Buffer } from "node:buffer";
import { config } from "../config.ts";
import { synthesizeToWav } from "../channels/notify.ts";
import { cleanForSpeech, splitReadyChunk } from "../channels/streaming_speech.ts";

function clean(text: string): string { return cleanForSpeech(text).replace(/\p{Extended_Pictographic}/gu, "").replace(/[\u{1F1E6}-\u{1F1FF}]/gu, "").replace(/[\u{1F3FB}-\u{1F3FF}\uFE0F\u200D]/gu, "").replace(/\s+/g, " ").trim(); }
export class WebAudioStream {
  private buffer = ""; private queue: Promise<void> = Promise.resolve(); private stopped = false; private failed = false;
  constructor(private enabled: boolean, private send: (event: unknown) => void, private voice: string, private onAudioProduced: () => void) {}
  push(delta: string): void { if (!this.enabled || this.stopped) return; this.buffer += delta; this.flush(false); }
  clearPendingText(): void { this.buffer = ""; }
  speakNow(text: string, opts: { speed?: number } = {}): void { const value = clean(text); if (value) this.enqueue(value, opts.speed); }
  async finish(): Promise<void> { if (!this.enabled || this.stopped) return; this.flush(true); await this.queue; }
  stop(): void { this.stopped = true; this.buffer = ""; }
  private flush(force: boolean): void { while (!this.stopped) { const [chunk, rest] = splitReadyChunk(this.buffer, force); this.buffer = rest; if (!chunk) break; const value = clean(chunk); if (value) this.enqueue(value); force = false; } }
  private enqueue(text: string, speed?: number): void { if (!this.enabled || this.stopped) this.queue = Promise.resolve(); else this.queue = this.queue.then(() => this.synthesize(text, speed)); }
  private async synthesize(text: string, speed?: number): Promise<void> {
    if (this.stopped) return; const wav = await synthesizeToWav(text, this.voice, speed);
    if (!wav) { if (!this.failed) { this.failed = true; this.send({ type: "audio_error", message: `Audio mode could not synthesize speech. Check SOPHIE_TTS_BASE_URL (${config.ttsBaseUrl}).` }); } return; }
    if (this.stopped) return; this.onAudioProduced(); this.send({ type: "audio", mime: "audio/wav", text, audio: Buffer.from(wav.buffer, wav.byteOffset, wav.byteLength).toString("base64") });
  }
}
