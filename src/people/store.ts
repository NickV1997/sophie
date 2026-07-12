/**
 * People — persistent contact context for Sophie.
 *
 * Records live in ~/.sophie/people.jsonl (newline-delimited JSON).
 * Each record holds relationship context, open threads, contact history,
 * and freeform notes — so Sophie always has the right framing before
 * messaging someone.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { memoryHomeDir } from "../memory/facts.ts";
import { upsertEntity } from "../system/entities.ts";

export interface PersonRecord {
  id: string;           // p_<base36timestamp><random>
  name: string;
  aliases: string[];    // nicknames / terms of endearment ("babushka", "dad", "boss")
  role: string;         // "investor", "cofounder", "client", "friend", etc.
  relationship: string; // one-sentence summary of the relationship
  phones: string[];
  emails: string[];
  tags: string[];
  notes: string;        // freeform running notes (can be multi-line)
  openThreads: string[]; // pending items / conversations
  lastContact: number | null; // epoch ms
  createdAt: number;
  updatedAt: number;
}

function storePath(): string {
  return join(memoryHomeDir(), "people.jsonl");
}

function ensureDir(): void {
  const dir = memoryHomeDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function newId(): string {
  return `p_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function readAll(): PersonRecord[] {
  const path = storePath();
  if (!existsSync(path)) return [];
  const out: PersonRecord[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const rec = JSON.parse(t) as PersonRecord;
      if (rec && typeof rec.name === "string") {
        if (!Array.isArray(rec.aliases)) rec.aliases = [];
        out.push(rec);
      }
    } catch {
      /* skip corrupt line */
    }
  }
  return out;
}

function writeAll(records: PersonRecord[]): void {
  ensureDir();
  writeFileSync(
    storePath(),
    records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : ""),
  );
}

function findByIdOrName(records: PersonRecord[], idOrName: string): PersonRecord | undefined {
  const lower = idOrName.toLowerCase().trim();
  return (
    records.find((r) => r.id === idOrName) ??
    records.find((r) => r.name.toLowerCase() === lower) ??
    records.find((r) => r.name.toLowerCase().startsWith(lower))
  );
}

// ── public api ────────────────────────────────────────────────────────────────

/** Search by name (exact → startsWith → contains) and by tags. */
export function lookupPeople(query: string): PersonRecord[] {
  const records = readAll();
  const q = query.toLowerCase().trim();
  if (!q) return records;

  // Exact name match first
  const hasAlias = (r: PersonRecord) => r.aliases.some((a) => a.toLowerCase() === q);
  const aliasExact = records.filter(hasAlias);
  if (aliasExact.length) return aliasExact;

  const exact = records.filter((r) => r.name.toLowerCase() === q);
  if (exact.length) return exact;

  // startsWith name or alias
  const starts = records.filter(
    (r) => r.name.toLowerCase().startsWith(q) || r.aliases.some((a) => a.toLowerCase().startsWith(q)),
  );
  if (starts.length) return starts;

  // Contains in name, aliases, or tags
  return records.filter(
    (r) =>
      r.name.toLowerCase().includes(q) ||
      r.aliases.some((a) => a.toLowerCase().includes(q)) ||
      r.tags.some((t) => t.toLowerCase().includes(q)) ||
      r.role.toLowerCase().includes(q),
  );
}

export function getPerson(id: string): PersonRecord | undefined {
  return readAll().find((r) => r.id === id);
}

export function listPeople(): PersonRecord[] {
  return readAll();
}

/** Create or update a person. Arrays are merged (union), notes appended only if non-empty. */
export function upsertPerson(data: Partial<PersonRecord> & { name: string }): PersonRecord {
  const records = readAll();
  const existing = records.find((r) => r.name.toLowerCase() === data.name.toLowerCase());
  const now = Date.now();

  if (existing) {
    const merged: PersonRecord = {
      ...existing,
      role: data.role ?? existing.role,
      relationship: data.relationship ?? existing.relationship,
      aliases: [...new Set([...(existing.aliases ?? []), ...(data.aliases ?? [])])],
      phones: [...new Set([...existing.phones, ...(data.phones ?? [])])],
      emails: [...new Set([...existing.emails, ...(data.emails ?? [])])],
      tags: [...new Set([...existing.tags, ...(data.tags ?? [])])],
      notes: data.notes?.trim()
        ? existing.notes
          ? `${existing.notes}\n${data.notes.trim()}`
          : data.notes.trim()
        : existing.notes,
      openThreads: data.openThreads != null
        ? [...new Set([...existing.openThreads, ...data.openThreads])]
        : existing.openThreads,
      lastContact: data.lastContact ?? existing.lastContact,
      updatedAt: now,
    };
    const idx = records.findIndex((r) => r.id === existing.id);
    records[idx] = merged;
    writeAll(records);
    upsertEntity("person", merged.id, merged.name, [...merged.aliases, ...merged.emails, ...merged.phones]);
    return merged;
  }

  const record: PersonRecord = {
    id: newId(),
    name: data.name.trim(),
    aliases: data.aliases ?? [],
    role: data.role ?? "",
    relationship: data.relationship ?? "",
    phones: data.phones ?? [],
    emails: data.emails ?? [],
    tags: data.tags ?? [],
    notes: data.notes?.trim() ?? "",
    openThreads: data.openThreads ?? [],
    lastContact: data.lastContact ?? null,
    createdAt: now,
    updatedAt: now,
  };
  records.push(record);
  writeAll(records);
  upsertEntity("person", record.id, record.name, [...record.aliases, ...record.emails, ...record.phones]);
  return record;
}

/** Record an interaction — bumps lastContact and appends a dated note. */
export function logContact(idOrName: string, note?: string): PersonRecord | null {
  const records = readAll();
  const rec = findByIdOrName(records, idOrName);
  if (!rec) return null;

  const now = Date.now();
  const dateStr = new Date(now).toISOString().slice(0, 10);
  const noteEntry = note?.trim() ? `[${dateStr}] ${note.trim()}` : `[${dateStr}] contact logged`;
  rec.notes = rec.notes ? `${rec.notes}\n${noteEntry}` : noteEntry;
  rec.lastContact = now;
  rec.updatedAt = now;

  writeAll(records);
  return rec;
}

/** Add an open thread to a person. */
export function addThread(idOrName: string, thread: string): PersonRecord | null {
  const records = readAll();
  const rec = findByIdOrName(records, idOrName);
  if (!rec) return null;

  const t = thread.trim();
  if (t && !rec.openThreads.includes(t)) {
    rec.openThreads.push(t);
    rec.updatedAt = Date.now();
    writeAll(records);
  }
  return rec;
}

/** Remove threads that contain the match string (substring). */
export function closeThread(idOrName: string, threadMatch: string): PersonRecord | null {
  const records = readAll();
  const rec = findByIdOrName(records, idOrName);
  if (!rec) return null;

  const lower = threadMatch.toLowerCase();
  const before = rec.openThreads.length;
  rec.openThreads = rec.openThreads.filter((t) => !t.toLowerCase().includes(lower));
  if (rec.openThreads.length !== before) {
    rec.updatedAt = Date.now();
    writeAll(records);
  }
  return rec;
}

/** Delete a person record by id or name. */
export function deletePerson(idOrName: string): boolean {
  const records = readAll();
  const rec = findByIdOrName(records, idOrName);
  if (!rec) return false;
  writeAll(records.filter((r) => r.id !== rec.id));
  return true;
}

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const days = Math.floor(diff / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "1d ago";
  if (days < 30) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 8) return `${weeks}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

/** Format a person record into readable text. */
export function renderPerson(r: PersonRecord): string {
  const lines: string[] = [];
  lines.push(`## ${r.name} (${r.role || "—"})`);
  if (r.aliases?.length) lines.push(`Also known as: ${r.aliases.join(", ")}`);
  if (r.relationship) lines.push(`Relationship: ${r.relationship}`);
  if (r.phones.length) lines.push(`Phone: ${r.phones.join(", ")}`);
  if (r.emails.length) lines.push(`Email: ${r.emails.join(", ")}`);
  if (r.tags.length) lines.push(`Tags: ${r.tags.join(", ")}`);
  lines.push(`Last contact: ${r.lastContact ? relativeTime(r.lastContact) : "never"}`);
  if (r.openThreads.length) {
    lines.push(`Open threads (${r.openThreads.length}):`);
    for (const t of r.openThreads) lines.push(`  · ${t}`);
  }
  if (r.notes) {
    lines.push("Notes:");
    for (const line of r.notes.split("\n").slice(-10)) lines.push(`  ${line}`);
  }
  return lines.join("\n");
}

/** Brief block for the system prompt, or "" if no records. */
export function peopleForPrompt(): string {
  const records = readAll();
  if (!records.length) return "";
  const lines = ["# Your people"];
  for (const r of records) {
    const contact = r.lastContact ? `last contact: ${relativeTime(r.lastContact)}` : "no contact logged";
    const threads = r.openThreads.length ? ` · ${r.openThreads.length} open thread${r.openThreads.length === 1 ? "" : "s"}` : "";
    lines.push(`- ${r.name} (${r.role || "—"}) — ${contact}${threads}`);
  }
  return lines.join("\n");
}
