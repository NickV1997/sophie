import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { memoryHomeDir } from "../memory/facts.ts";
export type EntityType = "person" | "project" | "task" | "calendar_event" | "delegation" | "communication";
export interface Entity { id: string; type: EntityType; sourceId: string; name: string; aliases: string[]; updatedAt: number; }
let db: Database | null = null;
let activePath: string | null = null;
function database(): Database {
  const dir = memoryHomeDir();
  const path = join(dir, "state.sqlite");
  if (db && activePath === path) return db;
  db?.close();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  db = new Database(path, { create: true });
  activePath = path;
  db.run("PRAGMA journal_mode=WAL");
  db.run("PRAGMA foreign_keys=ON");
  db.run("CREATE TABLE IF NOT EXISTS entities(id TEXT PRIMARY KEY,type TEXT NOT NULL,source_id TEXT NOT NULL,name TEXT NOT NULL,aliases_json TEXT NOT NULL DEFAULT '[]',updated_at INTEGER NOT NULL,UNIQUE(type,source_id))");
  db.run("CREATE INDEX IF NOT EXISTS entities_name_idx ON entities(name)");
  db.run("CREATE TABLE IF NOT EXISTS entity_links(from_id TEXT NOT NULL,to_id TEXT NOT NULL,relation TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(from_id,to_id,relation),FOREIGN KEY(from_id) REFERENCES entities(id) ON DELETE CASCADE,FOREIGN KEY(to_id) REFERENCES entities(id) ON DELETE CASCADE)");
  try { chmodSync(path, 0o600); } catch {}
  return db;
}
function rowEntity(row: any): Entity { return { id: row.id, type: row.type, sourceId: row.source_id, name: row.name, aliases: JSON.parse(row.aliases_json || "[]"), updatedAt: row.updated_at }; }
export function upsertEntity(type: EntityType, sourceId: string, name: string, aliases: string[] = []): Entity { const existing: any = database().query("SELECT * FROM entities WHERE type=? AND source_id=?").get(type, sourceId); const now = Date.now(); if (existing) { const merged = [...new Set([...JSON.parse(existing.aliases_json || "[]"), ...aliases].filter(Boolean))]; database().run("UPDATE entities SET name=?,aliases_json=?,updated_at=? WHERE id=?", [name, JSON.stringify(merged), now, existing.id]); return { ...rowEntity(existing), name, aliases: merged, updatedAt: now }; } const id = `ent-${crypto.randomUUID()}`; database().run("INSERT INTO entities(id,type,source_id,name,aliases_json,updated_at) VALUES (?,?,?,?,?,?)", [id, type, sourceId, name, JSON.stringify([...new Set(aliases.filter(Boolean))]), now]); return { id, type, sourceId, name, aliases, updatedAt: now }; }
export function findEntities(query: string, type?: EntityType): Entity[] { const q = `%${query.toLowerCase()}%`; const rows: any[] = type ? database().query("SELECT * FROM entities WHERE type=? AND (lower(name) LIKE ? OR lower(aliases_json) LIKE ?) ORDER BY updated_at DESC").all(type, q, q) : database().query("SELECT * FROM entities WHERE lower(name) LIKE ? OR lower(aliases_json) LIKE ? ORDER BY updated_at DESC").all(q, q); return rows.map(rowEntity); }
export function getEntity(type: EntityType, sourceId: string): Entity | undefined { const row: any = database().query("SELECT * FROM entities WHERE type=? AND source_id=?").get(type, sourceId); return row ? rowEntity(row) : undefined; }
export function linkEntities(fromId: string, toId: string, relation: string): void { if (fromId === toId) return; database().run("INSERT OR IGNORE INTO entity_links(from_id,to_id,relation,created_at) VALUES (?,?,?,?)", [fromId, toId, relation, Date.now()]); }
export function entityLinks(id: string): Array<{ entity: Entity; relation: string; direction: "out" | "in" }> { const rows: any[] = database().query("SELECT e.*,l.relation,'out' direction FROM entity_links l JOIN entities e ON e.id=l.to_id WHERE l.from_id=? UNION ALL SELECT e.*,l.relation,'in' direction FROM entity_links l JOIN entities e ON e.id=l.from_id WHERE l.to_id=?").all(id, id); return rows.map((r) => ({ entity: rowEntity(r), relation: r.relation, direction: r.direction })); }
export function resetEntityDbForTests(): void { db?.close(); db = null; activePath = null; }
