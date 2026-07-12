import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writePrivateFileAtomic } from "../system/atomic-file.ts";
import { memoryHomeDir } from "./facts.ts";
import type { EngineMemory, EngineMemoryScope } from "./engine.ts";

const STORE = "memory.engine.jsonl";
export const MAX_CAPSULE_CHARS = 180;
export const MAX_FULL_CHARS = 1200;
export function newEngineMemoryId(): string { return `em_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`; }
function pathFor(scope: EngineMemoryScope, cwd: string): string { return scope === "project" ? join(cwd, ".sophie", STORE) : join(memoryHomeDir(), STORE); }
export function oneLine(text: string, max = MAX_CAPSULE_CHARS): string { const clean = text.replace(/\s+/g, " ").trim(); return clean.length > max ? `${clean.slice(0, max).trimEnd()}...` : clean; }
export function capsuleFrom(full: string): string { return oneLine(full.split(/[.!?]\s+/)[0] ?? full, MAX_CAPSULE_CHARS); }
export function readEngineStore(scope: EngineMemoryScope, cwd: string): EngineMemory[] {
  const path = pathFor(scope, cwd); if (!existsSync(path)) return [];
  const out: EngineMemory[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) { const t = line.trim(); if (!t) continue; try { const rec = JSON.parse(t) as EngineMemory; if (rec?.capsule && rec?.full) out.push(rec); } catch {} }
  return out;
}
export function writeEngineStore(scope: EngineMemoryScope, cwd: string, records: EngineMemory[]): void {
  const path = pathFor(scope, cwd); mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writePrivateFileAtomic(path, records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : ""));
}
