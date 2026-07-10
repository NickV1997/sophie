import { platform } from "node:os";
import { resolvePath } from "../system/paths.ts";
import type { Tool } from "./types.ts";

/**
 * Open a URL, file, folder, or app in the user's default handler — the same as
 * clicking it. Lets Sophie hand things off to the GUI ("open the repo on GitHub",
 * "open this PDF", "launch Spotify").
 */
export const openThing: Tool = {
  name: "open_thing",
  description:
    "Open something in the user's GUI, like clicking it: a URL in the default " +
    "browser, a file/folder in its default app or the file manager, or a named " +
    "application. Use when the user asks to open, launch, show, or pull something " +
    "up on screen.",
  parameters: {
    type: "object",
    properties: {
      target: { type: "string", description: "A URL, a file/folder path, or an application name." },
      kind: {
        type: "string",
        enum: ["auto", "url", "path", "app"],
        description: "How to interpret target. 'auto' (default) infers from the value.",
      },
    },
    required: ["target"],
  },
  summarize: (a) => String(a.target ?? "").slice(0, 60),
  risk: () => "safe",
  async execute(args, ctx) {
    const raw = String(args.target ?? "").trim();
    if (!raw) return { content: "open_thing needs a target.", isError: true };
    const os = platform();
    const kind = String(args.kind ?? "auto");
    const looksUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || /^www\./i.test(raw);

    let cmd: string[];
    if (os === "darwin") {
      if (kind === "app" || (kind === "auto" && !looksUrl && !raw.includes("/") && !raw.includes("."))) {
        cmd = ["open", "-a", raw];
      } else if (kind === "url" || (kind === "auto" && looksUrl)) {
        cmd = ["open", raw.startsWith("www.") ? `https://${raw}` : raw];
      } else {
        cmd = ["open", resolvePath(ctx.cwd, raw)];
      }
    } else if (os === "linux") {
      const value = kind === "url" || (kind === "auto" && looksUrl)
        ? raw.startsWith("www.") ? `https://${raw}` : raw
        : kind === "app"
          ? raw
          : resolvePath(ctx.cwd, raw);
      cmd = ["xdg-open", value];
    } else {
      return { content: `open_thing unsupported on ${os}.`, isError: true };
    }

    try {
      const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe" });
      const code = await proc.exited;
      if (code !== 0) {
        const err = (await new Response(proc.stderr).text()).trim();
        return { content: `Couldn't open "${raw}": ${err || `exit ${code}`}.`, isError: true };
      }
      return { content: `Opened "${raw}".`, display: "opened" };
    } catch (e: any) {
      return { content: `Couldn't open "${raw}": ${e?.message ?? "error"}.`, isError: true };
    }
  },
};
