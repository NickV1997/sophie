import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";
import { completeChat, type ChatContentPart } from "../llm/client.ts";
import { findImages, imageDataUrl, resolveImagePath } from "../llm/image-files.ts";
import type { Tool } from "./types.ts";

const MAX_FIND = 500;
const MAX_DESCRIBE = 12;

function abs(cwd: string, p: string): string {
  const expanded = p === "~" ? homedir() : p.startsWith("~/") ? `${homedir()}/${p.slice(2)}` : p;
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

export const findImagesTool: Tool = {
  name: "find_images",
  description:
    "Find image files on the computer. Use this before describe_images when the user asks Sophie to browse screenshots/photos/images without naming exact files.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Directory to search. Defaults to the user's home directory. Use ~/Desktop for Desktop images.",
      },
      recursive: { type: "boolean", description: "Search subdirectories. Defaults to true." },
      max: { type: "number", description: "Maximum image paths to return. Defaults to 100, hard-capped at 500." },
    },
    required: [],
  },
  summarize: (a) => `find images in ${a.path ?? "~"}`,
  risk: () => "safe",
  async execute(args, ctx) {
    const path = abs(ctx.cwd, String(args.path ?? "~"));
    const max = Math.min(Math.max(Number(args.max ?? 100), 1), MAX_FIND);
    const images = findImages(path, { recursive: args.recursive !== false, max });
    return {
      content: images.length
        ? images.map((img, i) => `${i + 1}. ${img.path} (${img.size} bytes, modified ${img.modified})`).join("\n")
        : `No readable images found under ${path}.`,
      display: `${images.length} image${images.length === 1 ? "" : "s"}`,
    };
  },
};

export const describeImagesTool: Tool = {
  name: "describe_images",
  description:
    "Visually inspect and describe image files using the configured local vision model. Pass exact paths from find_images or paths the user mentioned.",
  parameters: {
    type: "object",
    properties: {
      paths: {
        type: "array",
        items: { type: "string" },
        description: "Image file paths to inspect. Maximum 12 per call.",
      },
      prompt: {
        type: "string",
        description: "What to look for or explain in the images. Defaults to a concise description of each image.",
      },
    },
    required: ["paths"],
  },
  summarize: (a) => `describe ${(a.paths as unknown[])?.length ?? 0} image(s)`,
  risk: () => "safe",
  async execute(args, ctx) {
    const rawPaths = Array.isArray(args.paths) ? args.paths.map(String) : [];
    if (rawPaths.length === 0) return { content: "No image paths provided.", isError: true };

    const paths = rawPaths
      .slice(0, MAX_DESCRIBE)
      .map((p) => resolveImagePath(p, ctx.cwd))
      .filter((p): p is string => Boolean(p));

    if (paths.length === 0) {
      return {
        content: `None of the provided paths resolved to readable images: ${rawPaths.join(", ")}`,
        isError: true,
      };
    }

    const prompt = String(
      args.prompt ??
        "Describe each image separately. Mention visible text, UI elements, objects, people, notable colors, and anything uncertain.",
    );
    const parts: ChatContentPart[] = [
      {
        type: "text",
        text:
          `${prompt}\n\n` +
          `You are inspecting ${paths.length} local image${paths.length === 1 ? "" : "s"}:\n` +
          paths.map((p, i) => `${i + 1}. ${basename(p)} (${p})`).join("\n") +
          "\nIf an image is not visually available to you, say that explicitly for that image.",
      },
      ...paths.map((path) => ({ type: "image_url" as const, image_url: { url: imageDataUrl(path) } })),
    ];

    const description = await completeChat(
      [
        {
          role: "system",
          content:
            "You are Sophie using her configured local vision model. Only describe what is visible in the attached images. Do not invent details.",
        },
        { role: "user", content: parts },
      ],
      { temperature: 0.2, signal: ctx.signal },
    );

    return {
      content: `Inspected image paths:\n${paths.map((p, i) => `${i + 1}. ${p}`).join("\n")}\n\n${description}`,
      display: `inspected ${paths.length}`,
    };
  },
};
