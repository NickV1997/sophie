/**
 * Working set — a runtime-maintained memory of the files Sophie has touched this
 * session, and the shell commands that mattered. On long conversations a small
 * model loses track of what it already created ("what did we name the storage
 * file?", "does add still match storage.py?"). Rather than hope the model
 * remembers across a growing transcript — or that lossy compaction keeps it —
 * the runtime tracks it deterministically and injects a compact recap into the
 * live-state block every turn. This offloads recall from the model.
 *
 * Module-global, mirroring the task ledger; reset on Agent.reset().
 */

export type FileAction = "created" | "edited" | "read";

interface FileEntry {
  path: string;
  action: FileAction;
  at: number;
  touches: number;
}

const files = new Map<string, FileEntry>();

/** Precedence so a created→edited file keeps the stronger label. */
const RANK: Record<FileAction, number> = { read: 0, edited: 1, created: 2 };

export function noteFileTouch(path: string, action: FileAction): void {
  const key = path.trim();
  if (!key) return;
  const existing = files.get(key);
  if (existing) {
    existing.touches++;
    existing.at = Date.now();
    if (RANK[action] > RANK[existing.action]) existing.action = action;
  } else {
    files.set(key, { path: key, action, at: Date.now(), touches: 1 });
  }
}

export function resetWorkset(): void {
  files.clear();
}

/** How many distinct files are tracked (used to decide whether to inject). */
export function worksetSize(): number {
  return files.size;
}

/**
 * A compact recap of the working set for the live-state block. Returns "" when
 * empty so early turns inject nothing. Newest-touched first, capped so it never
 * bloats the prompt. Paths are shown relative when possible.
 */
export function worksetForPrompt(cwd: string, max = 12): string {
  if (!files.size) return "";
  const rel = (p: string) => (p.startsWith(cwd) ? p.slice(cwd.length).replace(/^\//, "") || "." : p);
  // Files Sophie created/edited matter more than files she merely read, so they
  // never get pushed out of the capped recap by a burst of recent reads; within
  // the same rank, newest first.
  const rows = [...files.values()]
    .sort((a, b) => RANK[b.action] - RANK[a.action] || b.at - a.at)
    .slice(0, max)
    .map((f) => `- ${f.action}: ${rel(f.path)}`);
  return [
    "# Working set (files you've touched this session — source of truth, don't misremember)",
    ...rows,
    "Re-read a file before assuming its current contents; it may have changed since you last saw it.",
  ].join("\n");
}
