import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

/**
 * Expand a leading `~` (or `~/...`) to the user's home directory. The model
 * frequently writes home-relative paths like `~/Desktop/test/app/page.tsx`;
 * without this they resolve to a literal `~` folder under cwd and every read
 * fails. Non-tilde paths pass through unchanged.
 */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
  return p;
}

/** Resolve a user/model-supplied path to absolute, expanding `~` and honoring
 *  already-absolute paths; everything else is relative to cwd. */
export function resolvePath(cwd: string, p: string): string {
  const expanded = expandHome(p);
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

/** Render local paths without exposing the OS account name to the model/UI. */
export function displayPath(path: string): string {
  const home = homedir();
  if (path === home) return "~";
  const prefix = home.endsWith(sep) ? home : `${home}${sep}`;
  return path.startsWith(prefix) ? `~/${path.slice(prefix.length)}` : path;
}
