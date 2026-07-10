import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { config, reloadConfig, REPO_ROOT } from "../config.ts";
import { synthesizeToWav, playWavBytes } from "../channels/notify.ts";
import type { Tool } from "./types.ts";

const ENV_PATH = join(REPO_ROOT, ".env");

const SAMPLE_TEXT = "Hi, I'm Sophie. This is what I sound like with this voice. What do you think?";

interface VoiceEntry {
  id: string;
  language: string;
  description: string;
}

async function fetchVoices(): Promise<VoiceEntry[]> {
  const res = await fetch(`${config.ttsBaseUrl}/v1/voices`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`sidecar returned ${res.status}`);
  const body = (await res.json()) as { data?: VoiceEntry[] };
  return body.data ?? [];
}

function persistVoice(voice: string): void {
  if (!existsSync(ENV_PATH)) throw new Error(`.env not found at ${ENV_PATH}`);
  const content = readFileSync(ENV_PATH, "utf8");
  const updated = content.replace(/^SOPHIE_SPEAK_VOICE=.*/m, `SOPHIE_SPEAK_VOICE=${voice}`);
  writeFileSync(ENV_PATH, updated, "utf8");
  process.env.SOPHIE_SPEAK_VOICE = voice;
  reloadConfig();
}

export const voiceTool: Tool = {
  name: "voice",
  description:
    "Manage Sophie's TTS voice. " +
    "Use `list` to see every available voice with its language and description. " +
    "Use `preview` to play a short sample so the user can hear what a voice sounds like before committing. " +
    "Use `set` to make a voice active — updates the runtime and writes it to .env so it persists across restarts. " +
    "Workflow: list → preview each candidate the user is curious about → set the one they choose.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "preview", "set"],
        description: "list = show all voices; preview = play a sample; set = activate a voice permanently",
      },
      voice: {
        type: "string",
        description: "Voice id, e.g. bf_emma or af_heart. Required for preview and set.",
      },
    },
    required: ["action"],
  },
  summarize: (a) => `${a.action}${a.voice ? ` ${a.voice}` : ""}`,
  risk: (a) => (a.action === "set" ? "caution" : "safe"),

  async execute(args) {
    const action = String(args.action ?? "").trim();
    const voiceArg = String(args.voice ?? "").trim();

    // ── list ────────────────────────────────────────────────────────────────
    if (action === "list") {
      let voices: VoiceEntry[];
      try {
        voices = await fetchVoices();
      } catch (e: any) {
        return {
          content:
            `TTS sidecar unavailable (${e?.message ?? e}). Restart Sophie or run \`sophie doctor\` to check the Kokoro TTS server.`,
          isError: true,
        };
      }
      if (!voices.length) return { content: "No voices returned by the sidecar." };
      const current = config.speakVoice;
      const lines = voices.map(
        (v) => `${v.id === current ? "▶ " : "  "}${v.id.padEnd(14)} ${v.language.padEnd(8)} ${v.description}`,
      );
      return {
        content:
          `Available voices (▶ = active now):\n\n${lines.join("\n")}\n\n` +
          `Say "preview <voice>" to hear a sample, or "set my voice to <voice>" to switch.`,
      };
    }

    // ── preview ─────────────────────────────────────────────────────────────
    if (action === "preview") {
      if (!voiceArg) return { content: "Provide a voice name to preview.", isError: true };
      let wav: Uint8Array | null;
      try {
        wav = await synthesizeToWav(SAMPLE_TEXT, voiceArg);
      } catch (e: any) {
        return { content: `Synthesis failed: ${e?.message ?? e}`, isError: true };
      }
      if (!wav) return { content: `The sidecar couldn't synthesise with voice "${voiceArg}". Check the voice name with \`voice(list)\`.`, isError: true };
      const r = await playWavBytes(wav);
      return r.ok
        ? { content: `Playing sample for "${voiceArg}". If you like it, say "set my voice to ${voiceArg}".` }
        : { content: `Synthesised but playback failed: ${r.detail}`, isError: true };
    }

    // ── set ─────────────────────────────────────────────────────────────────
    if (action === "set") {
      if (!voiceArg) return { content: "Provide a voice name to set.", isError: true };

      // Verify it works before committing
      let wav: Uint8Array | null;
      try {
        wav = await synthesizeToWav(SAMPLE_TEXT, voiceArg);
      } catch (e: any) {
        return { content: `Couldn't verify voice "${voiceArg}": ${e?.message ?? e}`, isError: true };
      }
      if (!wav) {
        return {
          content: `Voice "${voiceArg}" didn't produce audio — check the name with \`voice(list)\` and make sure the TTS sidecar is running.`,
          isError: true,
        };
      }

      try {
        persistVoice(voiceArg);
      } catch (e: any) {
        return { content: `Couldn't update .env: ${e?.message ?? e}`, isError: true };
      }

      // Play the confirmation sample with the new voice
      void playWavBytes(wav);

      return {
        content:
          `Voice changed to "${voiceArg}". ` +
          `Updated SOPHIE_SPEAK_VOICE in .env and applied immediately — you can hear the confirmation sample playing now.`,
      };
    }

    return { content: `Unknown action "${action}". Valid actions: list, preview, set.`, isError: true };
  },
};
