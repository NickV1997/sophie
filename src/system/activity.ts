import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { memoryHomeDir } from "../memory/facts.ts";
import type { TurnSource } from "../agent/capabilities.ts";

export interface ActivityRecord {
  kind: "tool_call" | "tool_result" | "approval" | "delivery" | "schedule" | "privacy";
  source?: TurnSource;
  entityType?: string;
  entityId?: string;
  action: string;
  status: "started" | "approved" | "denied" | "succeeded" | "failed";
  summary?: string;
  metadata?: Record<string, unknown>;
}

let db: Database | null = null;
let activePath: string | null = null;
function getDb(): Database {
  const dir = memoryHomeDir();
  const path = join(dir, "state.sqlite");
  if (db && activePath === path) return db;
  db?.close();
  db = null;
  activePath = path;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode=WAL");
  db.run("PRAGMA synchronous=FULL");
  db.run("PRAGMA foreign_keys=ON");
  db.run("CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  db.run(`CREATE TABLE IF NOT EXISTS activity(
    id TEXT PRIMARY KEY, at INTEGER NOT NULL, kind TEXT NOT NULL, source TEXT,
    entity_type TEXT, entity_id TEXT, action TEXT NOT NULL, status TEXT NOT NULL,
    summary TEXT, metadata_json TEXT NOT NULL DEFAULT '{}'
  )`);
  db.run("CREATE INDEX IF NOT EXISTS activity_at_idx ON activity(at DESC)");
  db.run("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, ?)", [Date.now()]);
  try { chmodSync(path, 0o600); } catch { /* platform best effort */ }
  return db;
}

export function recordActivity(rec: ActivityRecord): string {
  const id = `act-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
  try {
    getDb().run(
      "INSERT INTO activity(id,at,kind,source,entity_type,entity_id,action,status,summary,metadata_json) VALUES (?,?,?,?,?,?,?,?,?,?)",
      [id, Date.now(), rec.kind, rec.source ?? null, rec.entityType ?? null, rec.entityId ?? null, rec.action, rec.status, rec.summary ?? null, JSON.stringify(rec.metadata ?? {})],
    );
  } catch {
    // Audit failure must never make the assistant repeat or lose the real action.
  }
  return id;
}

export function listActivity(limit = 100): Array<ActivityRecord & { id: string; at: number }> {
  return getDb().query("SELECT * FROM activity ORDER BY at DESC LIMIT ?").all(Math.min(Math.max(limit, 1), 1000)).map((row: any) => ({
    id: row.id, at: row.at, kind: row.kind, source: row.source ?? undefined,
    entityType: row.entity_type ?? undefined, entityId: row.entity_id ?? undefined,
    action: row.action, status: row.status, summary: row.summary ?? undefined,
    metadata: JSON.parse(row.metadata_json || "{}"),
  }));
}

export function resetActivityDbForTests(): void {
  db?.close();
  db = null;
  activePath = null;
}
