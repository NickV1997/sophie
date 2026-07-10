import { basename } from "node:path";
import type { ChatContentPart, ChatMessage } from "./client.ts";
import { desktopImages, imageDataUrl, resolveImagePath } from "./image-files.ts";
import { displayPath } from "../system/paths.ts";

const MAX_AUTO_DESKTOP_IMAGES = 8;

interface ImageAttachment {
  path: string;
  dataUrl: string;
}

export interface UserMessageBuild {
  message: ChatMessage;
  attachments: string[];
  missingRefs: string[];
  wantedImage: boolean;
  desktopAutoAttached: boolean;
}

export function buildUserMessage(input: string, cwd: string): UserMessageBuild {
  const found = findImageAttachments(input, cwd);
  if (found.attachments.length === 0) {
    return {
      message: { role: "user", content: input },
      attachments: [],
      missingRefs: found.missingRefs,
      wantedImage: found.wantedImage,
      desktopAutoAttached: found.desktopAutoAttached,
    };
  }

  const parts: ChatContentPart[] = [
    {
      type: "text",
      text:
        `${input}\n\n` +
        `Attached image${found.attachments.length === 1 ? "" : "s"} visible to you: ` +
        found.attachments.map((a) => `${basename(a.path)} (${displayPath(a.path)})`).join(", ") +
        (found.desktopAutoAttached
          ? `\nThese were found automatically on the user's Desktop. Describe each attached image separately.`
          : "") +
        "\nIf you cannot actually see the attached image content, say that plainly instead of guessing.",
    },
    ...found.attachments.map((a) => ({ type: "image_url" as const, image_url: { url: a.dataUrl } })),
  ];

  return {
    message: { role: "user", content: parts },
    attachments: found.attachments.map((a) => a.path),
    missingRefs: found.missingRefs,
    wantedImage: found.wantedImage,
    desktopAutoAttached: found.desktopAutoAttached,
  };
}

function findImageAttachments(input: string, cwd: string): {
  attachments: ImageAttachment[];
  missingRefs: string[];
  wantedImage: boolean;
  desktopAutoAttached: boolean;
} {
  const seen = new Set<string>();
  const attachments: ImageAttachment[] = [];
  const missingRefs: string[] = [];
  const refs = imageRefs(input);
  let desktopAutoAttached = false;

  for (const ref of refs) {
    const path = resolveImagePath(ref, cwd);
    if (!path) {
      missingRefs.push(ref);
      continue;
    }
    if (seen.has(path)) continue;
    seen.add(path);
    attachments.push(loadImage(path));
  }

  if (attachments.length === 0 && refs.length === 0 && asksForDesktopImage(input)) {
    for (const image of desktopImages(MAX_AUTO_DESKTOP_IMAGES)) {
      attachments.push(loadImage(image.path));
    }
    desktopAutoAttached = attachments.length > 0;
  }

  return {
    attachments,
    missingRefs,
    wantedImage: refs.length > 0 || asksForDesktopImage(input),
    desktopAutoAttached,
  };
}

function imageRefs(input: string): string[] {
  const refs: string[] = [];
  const patterns = [
    /@["']([^"']+\.(?:png|jpe?g|webp|gif|bmp))["']/gi,
    /@(\S+\.(?:png|jpe?g|webp|gif|bmp))/gi,
    /["']([^"']+\.(?:png|jpe?g|webp|gif|bmp))["']/gi,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(input)) !== null) refs.push(match[1]);
  }

  return refs;
}

function loadImage(path: string): ImageAttachment {
  return { path, dataUrl: imageDataUrl(path) };
}

function asksForDesktopImage(input: string): boolean {
  return /\b(desktop|screenshot|screen ?shot|image|photo|picture|pic)\b/i.test(input) &&
    /\b(see|look|describe|what'?s|what is|analy[sz]e|read|inspect|view)\b/i.test(input);
}
