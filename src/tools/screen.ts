import { platform } from "node:os";
import { join } from "node:path";
import { completeChat, type ChatContentPart } from "../llm/client.ts";
import { imageDataUrl } from "../llm/image-files.ts";
import { MEMORY_DIR } from "../memory/store.ts";
import type { Tool } from "./types.ts";

/**
 * Capture the screen and, by default, describe what's on it with the local
 * vision model — so Sophie can actually "look at the user's screen" to help with
 * whatever they're doing. Screenshots are saved under ~/.sophie/screenshots.
 */
export const captureScreen: Tool = {
  name: "capture_screen",
  description:
    "Take a screenshot of the user's screen and (by default) describe what's on " +
    "it using the local vision model. Use when the user asks Sophie to look at " +
    "their screen, read what's shown, or help with what they're currently doing. " +
    "Set describe=false to just save the image and return its path.",
  parameters: {
    type: "object",
    properties: {
      describe: { type: "boolean", description: "Describe the screenshot with the vision model (default true)." },
      prompt: { type: "string", description: "What to look for in the screen (default: general description)." },
    },
    required: [],
  },
  summarize: () => "screen",
  risk: () => "safe",
  async execute(args, ctx) {
    const os = platform();
    const dir = join(MEMORY_DIR, "screenshots");
    await Bun.$`mkdir -p ${dir}`.quiet().catch(() => {});
    const path = join(dir, `screen-${Date.now()}.png`);

    let cmd: string[];
    if (os === "darwin") cmd = ["screencapture", "-x", path];
    else if (os === "linux") cmd = ["import", "-window", "root", path]; // ImageMagick
    else return { content: `Screen capture unsupported on ${os}.`, isError: true };

    try {
      const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe" });
      const code = await proc.exited;
      if (code !== 0) {
        const err = (await new Response(proc.stderr).text()).trim();
        return {
          content:
            `Screen capture failed: ${err || `exit ${code}`}.` +
            (os === "darwin" ? " Terminal may need Screen Recording permission (System Settings → Privacy)." : " Requires ImageMagick's 'import'."),
          isError: true,
        };
      }
    } catch (e: any) {
      return { content: `Screen capture failed: ${e?.message ?? "error"}.`, isError: true };
    }

    if (args.describe === false) {
      return { content: `Screenshot saved to ${path}.`, display: "captured" };
    }

    const prompt = String(
      args.prompt ??
        "Describe what is on this screen: the app/window in focus, key text, UI elements, and anything the user might want help with.",
    );
    try {
      const parts: ChatContentPart[] = [
        { type: "text", text: `${prompt}\n\nThis is a screenshot of the user's screen. Only describe what is visible.` },
        { type: "image_url", image_url: { url: imageDataUrl(path) } },
      ];
      const description = await completeChat(
        [
          { role: "system", content: "You are Sophie's local vision model. Describe only what is visible in the screenshot; do not invent details." },
          { role: "user", content: parts },
        ],
        { temperature: 0.2, signal: ctx.signal },
      );
      return { content: `Screen (${path}):\n\n${description}`, display: "described screen" };
    } catch (e: any) {
      return { content: `Screenshot saved to ${path}, but description failed: ${e?.message ?? "error"}.`, isError: true };
    }
  },
};
