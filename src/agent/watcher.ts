/**
 * Watchers — event triggers to complement the scheduler's time triggers.
 *
 * A watcher observes a file or directory and fires when something changes:
 *   - "notify": push a message to the user (via the notifier).
 *   - "run":    wake Sophie with a prompt (the changed paths are appended), so
 *               she can e.g. describe whatever just landed in ~/Downloads.
 *
 * Items persist to ~/.sophie/watchers.json. The runtime uses fs.watch
 * (recursive) with per-watcher debounce so a burst of writes — a download, a
 * build — fires once, after it settles. Partial/temp files are ignored.
 */
import { existsSync, mkdirSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { basename, join } from "node:path";
import { MEMORY_DIR } from "../memory/store.ts";
import { expandHome } from "../system/paths.ts";
import { readJsonWithRecovery, writePrivateFileAtomic } from "../system/atomic-file.ts";
import type { AuthorizationSnapshot } from "./scheduler.ts";

export type WatchAction = "notify" | "run";

export interface WatchItem {
  id: string;
  path: string;
  action: WatchAction;
  title: string;
  /** For action "notify": the message to send (changed files are appended). */
  message?: string;
  /** For action "run": the instruction Sophie carries out when it fires. */
  prompt?: string;
  /** Optional glob filter on the changed file name, e.g. "*.pdf". */
  glob?: string;
  /** Quiet period after the last change before firing (default 2000ms). */
  debounceMs?: number;
  enabled: boolean;
  createdAt: number;
  lastFiredAt?: number;
  authorization?: AuthorizationSnapshot;
}

export const WATCHERS_PATH = join(MEMORY_DIR, "watchers.json");

/** Files that are still being written or are noise — never fire on these. */
const IGNORED_NAME = /^(\.|~)|\.(part|crdownload|download|tmp|swp)$|^(\.DS_Store|Thumbs\.db)$/i;

let items: WatchItem[] | null = null;

function load(): WatchItem[] {
  if (items) return items;
  if (!existsSync(WATCHERS_PATH)) return (items = []);
  try {
    const parsed: any = readJsonWithRecovery(WATCHERS_PATH);
    const list: unknown[] = Array.isArray(parsed?.items) ? parsed.items : [];
    items = list.filter((x): x is WatchItem => !!x && typeof (x as any).id === "string");
  } catch {
    items = [];
  }
  return items;
}

function persist(): void {
  if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true });
  writePrivateFileAtomic(WATCHERS_PATH, `${JSON.stringify({ schemaVersion: 1, items: items ?? [] }, null, 2)}\n`);
}

function newId(): string {
  return `wch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function listWatchers(): WatchItem[] {
  return load().slice().sort((a, b) => b.createdAt - a.createdAt);
}

export function addWatcher(input: {
  path: string;
  action: WatchAction;
  title: string;
  message?: string;
  prompt?: string;
  glob?: string;
  debounceMs?: number;
  authorization?: AuthorizationSnapshot;
}): WatchItem {
  const list = load();
  const item: WatchItem = {
    id: newId(),
    path: input.path,
    action: input.action,
    title: input.title.trim(),
    message: input.message?.trim(),
    prompt: input.prompt?.trim(),
    glob: input.glob?.trim() || undefined,
    debounceMs: input.debounceMs,
    enabled: true,
    createdAt: Date.now(),
    authorization: input.authorization,
  };
  list.push(item);
  persist();
  syncWatchers();
  return item;
}

export function cancelWatcher(id: string): boolean {
  const list = load();
  const i = list.findIndex((x) => x.id === id);
  if (i === -1) return false;
  list.splice(i, 1);
  persist();
  syncWatchers();
  return true;
}

export function setWatcherEnabled(id: string, enabled: boolean): WatchItem | undefined {
  const item = load().find((x) => x.id === id);
  if (!item) return undefined;
  item.enabled = enabled;
  persist();
  syncWatchers();
  return item;
}

// ── runtime ────────────────────────────────────────────────────────────────

type OnFire = (item: WatchItem, files: string[]) => void | Promise<void>;

interface ActiveWatch {
  watcher: FSWatcher;
  pending: Set<string>;
  timer: ReturnType<typeof setTimeout> | null;
}

let onFireCallback: OnFire | null = null;
const active = new Map<string, ActiveWatch>();

function attach(item: WatchItem): void {
  const root = expandHome(item.path);
  if (!existsSync(root)) return; // path may appear later; syncWatchers retries on changes
  let glob: Bun.Glob | null = null;
  try {
    glob = item.glob ? new Bun.Glob(item.glob) : null;
  } catch {
    glob = null;
  }
  try {
    const state: ActiveWatch = { watcher: null as unknown as FSWatcher, pending: new Set(), timer: null };
    state.watcher = watch(root, { recursive: true }, (_event, filename) => {
      const name = filename ? String(filename) : "";
      const base = basename(name);
      if (base && IGNORED_NAME.test(base)) return;
      if (glob && base && !glob.match(base) && !glob.match(name)) return;
      state.pending.add(name ? join(root, name) : root);
      if (state.timer) clearTimeout(state.timer);
      state.timer = setTimeout(() => {
        const files = [...state.pending];
        state.pending.clear();
        state.timer = null;
        const current = load().find((x) => x.id === item.id);
        if (!current?.enabled || !onFireCallback) return;
        current.lastFiredAt = Date.now();
        persist();
        try {
          void onFireCallback(current, files);
        } catch {
          /* one bad watcher must not kill the rest */
        }
      }, Math.max(500, item.debounceMs ?? 2000));
      (state.timer as any).unref?.();
    });
    active.set(item.id, state);
  } catch {
    /* fs.watch can fail on exotic mounts — skip this watcher */
  }
}

function detach(id: string): void {
  const state = active.get(id);
  if (!state) return;
  if (state.timer) clearTimeout(state.timer);
  try {
    state.watcher.close();
  } catch {
    /* ignore */
  }
  active.delete(id);
}

/** Reconcile OS-level watches with the persisted item list. */
export function syncWatchers(): void {
  if (!onFireCallback) return; // not started yet
  const wanted = new Map(load().filter((i) => i.enabled).map((i) => [i.id, i]));
  for (const id of [...active.keys()]) if (!wanted.has(id)) detach(id);
  for (const [id, item] of wanted) if (!active.has(id)) attach(item);
}

/** Start watching. Returns a stop function (used by the TUI on unmount). */
export function startWatchers(onFire: OnFire): () => void {
  onFireCallback = onFire;
  syncWatchers();
  return () => {
    onFireCallback = null;
    for (const id of [...active.keys()]) detach(id);
  };
}
