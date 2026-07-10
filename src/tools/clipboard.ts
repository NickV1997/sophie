import { platform } from "node:os";
import type { Tool } from "./types.ts";

/**
 * Read and write the system clipboard — the natural bridge between Sophie and
 * whatever the user is doing in other apps ("copy this", "what did I just copy",
 * "put this on my clipboard"). Uses the OS clipboard utilities.
 */
export const clipboard: Tool = {
  name: "clipboard",
  description:
    "Read or write the user's system clipboard. action 'read' returns whatever is " +
    "currently copied; action 'write' puts text on the clipboard for the user to " +
    "paste. Handy for moving text between Sophie and other apps.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["read", "write"], description: "read the clipboard or write to it." },
      text: { type: "string", description: "Text to copy (for action 'write')." },
    },
    required: ["action"],
  },
  summarize: (a) => (a.action === "write" ? `write ${String(a.text ?? "").length} chars` : "read"),
  risk: () => "safe",
  async execute(args) {
    const action = String(args.action ?? "read");
    const os = platform();

    // Linux has no single clipboard utility — Wayland uses wl-clipboard,
    // X11 uses xclip/xsel — so try them in turn and report the whole set if
    // none is installed, rather than assuming xclip.
    const writeCmds =
      os === "darwin"
        ? [["pbcopy"]]
        : os === "linux"
          ? [["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]]
          : [];
    const readCmds =
      os === "darwin"
        ? [["pbpaste"]]
        : os === "linux"
          ? [["wl-paste", "--no-newline"], ["xclip", "-selection", "clipboard", "-o"], ["xsel", "--clipboard", "--output"]]
          : [];

    if (action === "write") {
      if (!writeCmds.length) return { content: `Clipboard write unsupported on ${os}.`, isError: true };
      const text = String(args.text ?? "");
      let lastErr = "";
      for (const cmd of writeCmds) {
        try {
          const proc = Bun.spawn(cmd, { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
          proc.stdin.write(text);
          await proc.stdin.end();
          const code = await proc.exited;
          if (code === 0) {
            return { content: `Copied ${text.length} characters to the clipboard.`, display: `copied ${text.length} chars` };
          }
          lastErr = `${cmd[0]} exited ${code}`;
        } catch (e: any) {
          lastErr = `${cmd[0]}: ${e?.message ?? "not found"}`;
        }
      }
      return {
        content:
          `Clipboard write failed (${lastErr}). ` +
          (os === "linux" ? "Install wl-clipboard (Wayland) or xclip/xsel (X11)." : ""),
        isError: true,
      };
    }

    // read
    if (!readCmds.length) return { content: `Clipboard read unsupported on ${os}.`, isError: true };
    let lastErr = "";
    for (const cmd of readCmds) {
      try {
        const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
        const text = await new Response(proc.stdout).text();
        const code = await proc.exited;
        if (code !== 0) {
          lastErr = `${cmd[0]} exited ${code}`;
          continue;
        }
        return text
          ? { content: `Clipboard contents:\n${text}`, display: `${text.length} chars` }
          : { content: "The clipboard is empty.", display: "empty" };
      } catch (e: any) {
        lastErr = `${cmd[0]}: ${e?.message ?? "not found"}`;
      }
    }
    return {
      content:
        `Clipboard read failed (${lastErr}). ` +
        (os === "linux" ? "Install wl-clipboard (Wayland) or xclip/xsel (X11)." : ""),
      isError: true,
    };
  },
};
