/**
 * Delegates — standing commitments to keep people informed.
 *
 * Records live in ~/.sophie/delegates.jsonl (newline-delimited JSON).
 * Each delegate has a person, topic, instruction, channel, and optional cron
 * schedule. When a delegate fires, Sophie drafts and sends an update.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { memoryHomeDir } from "../memory/facts.ts";

export interface DelegateRecord {
  id: string;          // del_<base36><random>
  title: string;       // short label, e.g. "Paul / Stivy updates"
  person: string;      // contact name
  topic: string;       // what to keep them informed about
  instruction: string; // how to frame updates, tone, what to include
  channel: "imessage" | "notify"; // how to send
  cron?: string;       // 5-field cron for recurring check-ins, optional
  scheduleId?: string; // id in the scheduler if cron was set
  autoSend: boolean;   // auto-send without asking, or draft+ask
  lastSent: number | null;
  enabled: boolean;
  createdAt: number;
}

function storePath(): string {
  return join(memoryHomeDir(), "delegates.jsonl");
}

function ensureDir(): void {
  const dir = memoryHomeDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function newId(): string {
  return `del_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function readAll(): DelegateRecord[] {
  const path = storePath();
  if (!existsSync(path)) return [];
  const out: DelegateRecord[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const rec = JSON.parse(t) as DelegateRecord;
      if (rec && typeof rec.title === "string") out.push(rec);
    } catch {
      /* skip corrupt line */
    }
  }
  return out;
}

function writeAll(records: DelegateRecord[]): void {
  ensureDir();
  writeFileSync(
    storePath(),
    records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : ""),
  );
}

// ── public api ────────────────────────────────────────────────────────────────

export function listDelegates(includeDisabled = false): DelegateRecord[] {
  return readAll().filter((d) => includeDisabled || d.enabled);
}

export function getDelegate(id: string): DelegateRecord | undefined {
  return readAll().find((d) => d.id === id);
}

/** Create a new delegation. Returns the record so the caller can schedule it. */
export function addDelegate(
  data: Omit<DelegateRecord, "id" | "enabled" | "lastSent" | "createdAt">,
): DelegateRecord {
  const records = readAll();
  const now = Date.now();
  const record: DelegateRecord = {
    id: newId(),
    title: data.title.trim(),
    person: data.person.trim(),
    topic: data.topic.trim(),
    instruction: data.instruction.trim(),
    channel: data.channel ?? "imessage",
    cron: data.cron,
    scheduleId: data.scheduleId,
    autoSend: data.autoSend ?? false,
    lastSent: null,
    enabled: true,
    createdAt: now,
  };
  records.push(record);
  writeAll(records);
  return record;
}

/** Disable a delegation (soft-delete). */
export function cancelDelegate(id: string): boolean {
  const records = readAll();
  const rec = records.find((d) => d.id === id);
  if (!rec) return false;
  rec.enabled = false;
  writeAll(records);
  return true;
}

/** Update lastSent to now. */
export function updateDelegateSent(id: string): boolean {
  const records = readAll();
  const rec = records.find((d) => d.id === id);
  if (!rec) return false;
  rec.lastSent = Date.now();
  writeAll(records);
  return true;
}

/** Update the scheduleId after scheduling. */
export function setDelegateScheduleId(id: string, scheduleId: string): boolean {
  const records = readAll();
  const rec = records.find((d) => d.id === id);
  if (!rec) return false;
  rec.scheduleId = scheduleId;
  writeAll(records);
  return true;
}

function cronDescription(cron: string): string {
  // Simple human-readable for common patterns
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return `cron: ${cron}`;
  const [min, hour, , , dow] = parts;
  const days: Record<string, string> = { "0": "Sun", "1": "Mon", "2": "Tue", "3": "Wed", "4": "Thu", "5": "Fri", "6": "Sat" };
  const dayName = dow !== "*" ? (days[dow!] ?? `day ${dow}`) : "daily";
  const time = hour !== "*" && min !== "*" ? ` ${hour}:${String(min).padStart(2, "0")}` : "";
  return `${dayName}${time ? "s" : ""}${time}`;
}

/** Brief block for the system prompt, or "" if no active delegates. */
export function activeDelegatesForPrompt(): string {
  const active = listDelegates();
  if (!active.length) return "";
  const lines = ["# Standing delegations (people you keep informed)"];
  for (const d of active) {
    const sched = d.cron ? ` Recurring: ${cronDescription(d.cron)}.` : "";
    lines.push(`- ${d.person} / ${d.topic}: ${d.instruction} Channel: ${d.channel === "imessage" ? "iMessage" : "notify"}.${sched}`);
  }
  return lines.join("\n");
}
