import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, isAbsolute, join, resolve } from "node:path";

export const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
};

export interface ImageFile {
  path: string;
  size: number;
  modified: string;
}

export function resolveImagePath(ref: string, cwd: string): string | null {
  return candidatePaths(ref, cwd).find((path) => isReadableImage(path)) ?? null;
}

export function isReadableImage(path: string): boolean {
  if (!existsSync(path)) return false;
  const ext = extname(path).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(ext)) return false;
  const st = statSync(path);
  return st.isFile() && st.size > 0 && st.size <= MAX_IMAGE_BYTES;
}

export function imageDataUrl(path: string): string {
  const ext = extname(path).toLowerCase();
  const mime = MIME_BY_EXT[ext] ?? "application/octet-stream";
  return `data:${mime};base64,${readFileSync(path).toString("base64")}`;
}

export function findImages(basePath: string, opts: { recursive: boolean; max: number }): ImageFile[] {
  const out: ImageFile[] = [];
  walk(basePath, opts.recursive ? 8 : 1, out, opts.max);
  return out.sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified));
}

export function desktopImages(max: number): ImageFile[] {
  return findImages(join(homedir(), "Desktop"), { recursive: false, max });
}

function candidatePaths(ref: string, cwd: string): string[] {
  const home = homedir();
  const withoutAt = ref.trim().startsWith("@") ? ref.trim().slice(1) : ref.trim();
  const expanded = withoutAt.startsWith("~/") ? join(home, withoutAt.slice(2)) : withoutAt;
  const candidates = [
    isAbsolute(expanded) ? expanded : resolve(cwd, expanded),
    isAbsolute(expanded) ? expanded : join(home, "Desktop", expanded),
  ];

  if (expanded.startsWith("Desktop/")) candidates.push(join(home, expanded));

  return [...new Set(candidates)];
}

function walk(dir: string, depth: number, out: ImageFile[], max: number): void {
  if (out.length >= max || depth <= 0 || !existsSync(dir)) return;

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (out.length >= max) return;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (skipDir(entry.name)) continue;
      walk(path, depth - 1, out, max);
      continue;
    }
    if (!isReadableImage(path)) continue;
    const st = statSync(path);
    out.push({ path, size: st.size, modified: st.mtime.toISOString() });
  }
}

function skipDir(name: string): boolean {
  return name === "node_modules" ||
    name === ".git" ||
    name === "Library" ||
    name === "Applications" ||
    name === ".Trash";
}
