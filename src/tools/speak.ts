import { speak } from "../channels/notify.ts";
import type { Tool } from "./types.ts";

/**
 * Say something out loud through the computer's speakers. Useful hands-free — a
 * spoken heads-up, a reminder read aloud, or just answering by voice when the
 * user is across the room.
 */
export const speakTool: Tool = {
  name: "speak",
  description:
    "Speak text aloud through the computer's speakers (text-to-speech). Use when " +
    "the user asks Sophie to say/read something out loud, or for a spoken heads-up " +
    "when they're away from the screen. This is voice only — it does not print. " +
    "Only put the exact words to say in `text`; never put the user's whole command, " +
    "tool JSON, XML tool tags, or explanation text in `text`.",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "The exact words to say out loud, and nothing else." },
    },
    required: ["text"],
  },
  summarize: (a) => `"${String(a.text ?? "").slice(0, 48)}"`,
  risk: () => "safe",
  async execute(args) {
    const text = speechTextFrom(args.text);
    if (!text) return { content: "speak needs some text.", isError: true };
    const r = await speak(text);
    return r.ok
      ? { content: `Spoke: "${text.slice(0, 120)}"`, display: "spoke" }
      : { content: `Couldn't speak: ${r.detail}.`, isError: true };
  },
};

function speechTextFrom(raw: unknown): string {
  let text = String(raw ?? "").trim();
  if (!text) return "";

  const extracted = extractToolSpeechText(text);
  if (extracted) text = extracted;

  return text
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
    .replace(/<tool_response>[\s\S]*?<\/tool_response>/g, "")
    .replace(/^\s*(sophie\s*,?\s*)?(please\s+)?(speak|say|read\s+aloud|tell\s+me\s+out\s+loud)\s*[:,-]?\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractToolSpeechText(text: string): string | null {
  const tagged = text.match(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/i)?.[1]?.trim();
  for (const candidate of [tagged, text]) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      const inner = parsed?.arguments?.text ?? parsed?.text;
      if (typeof inner === "string" && inner.trim()) return inner.trim();
    } catch {
      // Not JSON; fall through to plain text cleanup.
    }
  }
  return null;
}
