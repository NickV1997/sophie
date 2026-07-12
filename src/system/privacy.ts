import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { memoryHomeDir } from "../memory/facts.ts";
import { writePrivateFileAtomic } from "./atomic-file.ts";

const RETAINABLE = new Set(["sessions", "episodes", "jobs"]);
const DELETABLE: Record<string, string[]> = {
  sessions: ["sessions"], memories: ["facts.jsonl", "memory.jsonl", "embeddings.json", "SOPHIE.md"],
  profile: ["profile.json"], calendar: ["calendar.json", "schedule.json"],
  contacts: ["people.jsonl", "projects.jsonl", "delegates.jsonl"],
  watchers: ["watchers.json"], activity: ["state.sqlite", "state.sqlite-wal", "state.sqlite-shm"],
};

export function privacyInventory(): Array<{ category: string; files: number; bytes: number }> {
  const root = memoryHomeDir();
  return Object.entries(DELETABLE).map(([category, names]) => {
    let files = 0, bytes = 0;
    for (const name of names) {
      const path = join(root, name);
      if (!existsSync(path)) continue;
      const stat = statSync(path);
      if (stat.isDirectory()) {
        for (const child of readdirSync(path)) { const s = statSync(join(path, child)); if (s.isFile()) { files++; bytes += s.size; } }
      } else { files++; bytes += stat.size; }
    }
    return { category, files, bytes };
  });
}

export function exportPrivateState(destination: string): string {
  const root = memoryHomeDir();
  const out = resolve(destination, `sophie-export-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(out, { recursive: true, mode: 0o700 });
  for (const names of Object.values(DELETABLE)) for (const name of names) {
    const source = join(root, name);
    if (existsSync(source)) cpSync(source, join(out, name), { recursive: true });
  }
  writePrivateFileAtomic(join(out, "manifest.json"), `${JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), source: "Sophie local personal state", excludes: [".env", "credentials", "tokens"] }, null, 2)}\n`);
  return out;
}

export function deletePrivateCategory(category: string): number {
  const names = DELETABLE[category];
  if (!names) return -1;
  let removed = 0;
  for (const name of names) {
    const path = join(memoryHomeDir(), name);
    if (!existsSync(path)) continue;
    rmSync(path, { recursive: true, force: true }); removed++;
    for (const suffix of [".bak"]) if (existsSync(path + suffix)) rmSync(path + suffix, { force: true });
  }
  return removed;
}

export function enforceRetention(days: number): number {
  const cutoff = Date.now() - Math.max(1, days) * 86_400_000;
  let removed = 0;
  for (const name of RETAINABLE) {
    const dir = join(memoryHomeDir(), name);
    if (!existsSync(dir)) continue;
    for (const child of readdirSync(dir)) {
      const path = join(dir, child);
      if (statSync(path).isFile() && statSync(path).mtimeMs < cutoff) { rmSync(path, { force: true }); removed++; }
    }
  }
  return removed;
}
