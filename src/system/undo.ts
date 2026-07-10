/**
 * Undo — checkpoints for Sophie's file edits, grouped per user turn.
 *
 * Every write/edit/replace_lines already snapshots the previous content into
 * ~/.sophie/backups; this module adds the journal that makes those snapshots
 * actionable: which files one turn touched, which backup restores each one,
 * and which files were newly created (undo = delete). The TUI's /undo command
 * reverts the most recent turn's changes, newest first.
 *
 * Scope: only Sophie's own file tools are checkpointed. Changes made through
 * bash (mv, sed, git…) are not tracked — /undo reports what it restores.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { memoryHomeDir } from "../memory/facts.ts";

interface UndoEntry {
  path: string;
  /** Backup file holding the pre-change content; null = the file was created. */
  backup: string | null;
  at: number;
}

interface UndoGroup {
  id: string;
  label: string;
  at: number;
  entries: UndoEntry[];
}

// Resolved lazily (SOPHIE_HOME-aware) so tests never touch the real ~/.sophie.
const undoJournalPath = () => join(memoryHomeDir(), "undo.json");
const backupDir = () => join(memoryHomeDir(), "backups");
const MAX_GROUPS = 30;

let groups: UndoGroup[] | null = null;
let currentGroupId: string | null = null;
let currentLabel = "";

function load(): UndoGroup[] {
  if (groups) return groups;
  if (!existsSync(undoJournalPath())) return (groups = []);
  try {
    const parsed = JSON.parse(readFileSync(undoJournalPath(), "utf8"));
    groups = Array.isArray(parsed?.groups) ? parsed.groups : [];
  } catch {
    groups = [];
  }
  return groups!;
}

function persist(): void {
  mkdirSync(memoryHomeDir(), { recursive: true });
  writeFileSync(undoJournalPath(), `${JSON.stringify({ groups: load().slice(-MAX_GROUPS) }, null, 2)}\n`);
}

/** Write a timestamped backup of `content` for `path`; returns the backup path. */
export function writeBackup(path: string, content: string): string {
  mkdirSync(backupDir(), { recursive: true });
  const safe = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}-${basename(path).replace(/[^a-z0-9._-]/gi, "_")}`;
  const backup = join(backupDir(), safe);
  writeFileSync(backup, content);
  return backup;
}

/**
 * Mark the start of a new turn. Entries recorded after this call land in a
 * fresh group; the group is only persisted once it has an entry, so turns that
 * touch no files leave no empty journal rows.
 */
export function beginUndoGroup(label: string): void {
  currentGroupId = `u-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  currentLabel = label.replace(/\s+/g, " ").trim().slice(0, 80);
}

/**
 * Record one file change. `before` is the previous content, or null when the
 * file did not exist (undo will delete it). Returns the backup path (if any)
 * so callers can mention it.
 */
export function recordFileChange(path: string, before: string | null): string | null {
  const list = load();
  if (!currentGroupId) beginUndoGroup("(untracked turn)");
  let group = list.find((g) => g.id === currentGroupId);
  if (!group) {
    group = { id: currentGroupId!, label: currentLabel, at: Date.now(), entries: [] };
    list.push(group);
    if (list.length > MAX_GROUPS) list.splice(0, list.length - MAX_GROUPS);
  }
  const backup = before === null ? null : writeBackup(path, before);
  group.entries.push({ path, backup, at: Date.now() });
  persist();
  return backup;
}

export interface UndoResult {
  ok: boolean;
  summary: string;
}

/**
 * Revert the most recent group of changes, newest entry first. Each reverted
 * file's pre-undo content is itself backed up, so an accidental /undo never
 * destroys work. Returns a human-readable summary for the TUI.
 */
export function undoLast(): UndoResult {
  const list = load();
  const group = [...list].reverse().find((g) => g.entries.length > 0);
  if (!group) return { ok: false, summary: "Nothing to undo — no checkpointed file changes." };

  const restored: string[] = [];
  const deleted: string[] = [];
  const failed: string[] = [];
  for (const entry of [...group.entries].reverse()) {
    try {
      // Safety net: keep what we're about to overwrite/delete.
      if (existsSync(entry.path)) writeBackup(entry.path, readFileSync(entry.path, "utf8"));
      if (entry.backup === null) {
        if (existsSync(entry.path)) unlinkSync(entry.path);
        deleted.push(entry.path);
      } else if (existsSync(entry.backup)) {
        mkdirSync(dirname(entry.path), { recursive: true });
        writeFileSync(entry.path, readFileSync(entry.backup, "utf8"));
        restored.push(entry.path);
      } else {
        failed.push(`${entry.path} (backup missing)`);
      }
    } catch (e: any) {
      failed.push(`${entry.path} (${e?.message ?? e})`);
    }
  }
  list.splice(list.indexOf(group), 1);
  persist();

  const bits = [
    restored.length ? `restored ${restored.length} file${restored.length === 1 ? "" : "s"}:\n${restored.map((p) => `  · ${p}`).join("\n")}` : "",
    deleted.length ? `deleted ${deleted.length} created file${deleted.length === 1 ? "" : "s"}:\n${deleted.map((p) => `  · ${p}`).join("\n")}` : "",
    failed.length ? `FAILED:\n${failed.map((p) => `  · ${p}`).join("\n")}` : "",
  ].filter(Boolean);
  return {
    ok: failed.length === 0,
    summary:
      `Undid "${group.label || "last changes"}" (${new Date(group.at).toLocaleTimeString()}) — ${bits.join("\n")}` +
      "\nNote: only Sophie's file tools are checkpointed; bash-made changes are not reverted.",
  };
}

/** Cleanup for /clear and tests. */
export function resetUndoState(): void {
  groups = null;
  currentGroupId = null;
  currentLabel = "";
}

/** For the doctor readout. */
export function undoStats(): { groups: number; entries: number } {
  const list = load();
  return { groups: list.length, entries: list.reduce((n, g) => n + g.entries.length, 0) };
}

/** Remove journal + backups entirely (not exposed as a command; test helper). */
export function purgeUndoData(): void {
  rmSync(undoJournalPath(), { force: true });
  resetUndoState();
}
