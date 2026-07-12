import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { memoryHomeDir } from "../memory/facts.ts";

export type OperationState = "started" | "completed" | "failed";
let db: Database | null = null;
function database(): Database {
  if (db) return db; const dir = memoryHomeDir(); mkdirSync(dir, { recursive: true, mode: 0o700 }); const path = join(dir, "state.sqlite");
  db = new Database(path, { create: true }); db.run("PRAGMA journal_mode=WAL"); db.run("PRAGMA synchronous=FULL");
  db.run("CREATE TABLE IF NOT EXISTS idempotency(operation_key TEXT PRIMARY KEY, state TEXT NOT NULL, started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, result TEXT)");
  try { chmodSync(path, 0o600); } catch {} return db;
}
export function operationKey(operationId: string, tool: string, args: Record<string, unknown>): string {
  return createHash("sha256").update(`${operationId}\0${tool}\0${JSON.stringify(args, Object.keys(args).sort())}`).digest("hex");
}
export function operationState(key: string): { state: OperationState; result?: string } | null {
  const row: any = database().query("SELECT state,result FROM idempotency WHERE operation_key=?").get(key); return row ? { state: row.state, result: row.result ?? undefined } : null;
}
export function startOperation(key: string): boolean { try { const now = Date.now(); database().run("INSERT INTO idempotency(operation_key,state,started_at,updated_at) VALUES (?,?,?,?)", [key, "started", now, now]); return true; } catch { return false; } }
export function finishOperation(key: string, state: Extract<OperationState, "completed" | "failed">, result?: string): void { database().run("UPDATE idempotency SET state=?,updated_at=?,result=? WHERE operation_key=?", [state, Date.now(), result ?? null, key]); }
export function resetIdempotencyForTests(): void { db?.close(); db = null; }
