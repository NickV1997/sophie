/**
 * Calendar — persistent events with linked reminders.
 *
 * Events live in ~/.sophie/calendar.json. Each event owns zero or more
 * reminders expressed as lead times (minutes before start); the store turns
 * those into one-off scheduler items (action "notify") so the existing tick
 * loop delivers them to the desktop/Telegram like any other reminder. When an
 * event is rescheduled or cancelled its scheduler items are cancelled and
 * (for a reschedule) recreated, so the calendar stays the single source of
 * truth and reminders can never fire for a moved or dead event.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { addOnce, cancelSchedule, hasActiveSchedule } from "../agent/scheduler.ts";
import { memoryHomeDir } from "../memory/facts.ts";
import { readJsonWithRecovery, writePrivateFileAtomic } from "../system/atomic-file.ts";
import { upsertEntity } from "../system/entities.ts";

export type EventStatus = "confirmed" | "cancelled";

export interface CalendarEvent {
  id: string;
  title: string;
  /** Start / end as epoch ms (always local wall-clock when displayed). */
  start: number;
  end: number;
  location?: string;
  notes?: string;
  attendees?: string[];
  status: EventStatus;
  /** Reminder lead times in minutes before start (e.g. [30] = 30 min before). */
  reminderLeads: number[];
  /** Ids of the scheduler items backing those reminders. */
  reminderIds: string[];
  /** External calendar mirrors. Sophie stays the source of truth. */
  external?: {
    appleId?: string;
    lastSyncedAt?: number;
    lastSyncError?: string;
  };
  createdAt: number;
  updatedAt: number;
}

function calendarPath(): string {
  return join(memoryHomeDir(), "calendar.json");
}

/** Default reminder leads for new events: a 30-minute heads-up plus a 5-minute
 *  "it's about to start" ping. Both go to desktop + Telegram via notifyUser. */
export const DEFAULT_REMINDER_LEADS = [30, 5];

let events: CalendarEvent[] | null = null;
let activePath: string | null = null;

function ensureDir(): void {
  const dir = memoryHomeDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function load(): CalendarEvent[] {
  const path = calendarPath();
  if (activePath !== path) {
    events = null;
    activePath = path;
  }
  if (events) return events;
  if (!existsSync(path)) return (events = []);
  try {
    const parsed: any = readJsonWithRecovery(path);
    const list: unknown[] = Array.isArray(parsed?.events) ? parsed.events : [];
    events = list.filter(
      (x): x is CalendarEvent =>
        !!x && typeof (x as any).id === "string" && Number.isFinite((x as any).start) && Number.isFinite((x as any).end),
    );
  } catch {
    events = [];
  }
  return events;
}

function persist(): void {
  ensureDir();
  const sorted = [...(events ?? [])].sort((a, b) => a.start - b.start);
  writePrivateFileAtomic(calendarPath(), `${JSON.stringify({ schemaVersion: 1, events: sorted }, null, 2)}\n`);
}

function newId(): string {
  return `cal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

// ── formatting (shared by the tool and the prompt block) ──────────────────────

export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

export function fmtDay(ts: number): string {
  return new Date(ts).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

export function fmtRange(start: number, end: number): string {
  const sameDay = new Date(start).toDateString() === new Date(end).toDateString();
  return sameDay
    ? `${fmtDay(start)} ${fmtTime(start)}–${fmtTime(end)}`
    : `${fmtDay(start)} ${fmtTime(start)} → ${fmtDay(end)} ${fmtTime(end)}`;
}

// ── reminders ─────────────────────────────────────────────────────────────────

function reminderMessage(ev: CalendarEvent, leadMinutes: number): string {
  const where = ev.location ? ` @ ${ev.location}` : "";
  const who = ev.attendees?.length ? ` with ${ev.attendees.join(", ")}` : "";
  const lead =
    leadMinutes <= 0
      ? "starting now"
      : leadMinutes < 60
        ? `in ${leadMinutes} min`
        : `in ${Math.round(leadMinutes / 60)}h`;
  return `📅 ${ev.title}${who}${where} — ${lead} (${fmtTime(ev.start)})`;
}

/** Cancel any scheduler items the event owns, then recreate one per lead time
 *  that is still in the future. Mutates ev.reminderIds. */
function syncReminders(ev: CalendarEvent): void {
  for (const id of ev.reminderIds) cancelSchedule(id);
  ev.reminderIds = [];
  if (ev.status !== "confirmed") return;
  const now = Date.now();
  for (const lead of ev.reminderLeads) {
    const at = ev.start - lead * 60_000;
    if (at <= now) continue;
    const item = addOnce({
      title: `📅 ${ev.title}`,
      at,
      action: "notify",
      message: reminderMessage(ev, lead),
    });
    ev.reminderIds.push(item.id);
  }
}

/**
 * Repair reminder links after startup. Nothing fires while Sophie is closed;
 * overdue persisted reminders are left for startScheduler's immediate tick,
 * while missing future reminders are recreated from their calendar event.
 */
export function reconcileCalendarReminders(now = Date.now()): { repairedEvents: number; createdReminders: number } {
  let repairedEvents = 0;
  let createdReminders = 0;
  for (const ev of load()) {
    if (ev.status !== "confirmed" || ev.start <= now) continue;
    const expectedFuture = ev.reminderLeads.filter((lead) => ev.start - lead * 60_000 > now).length;
    const active = ev.reminderIds.filter(hasActiveSchedule).length;
    if (active === expectedFuture && ev.reminderIds.length === expectedFuture) continue;
    syncReminders(ev);
    repairedEvents++;
    createdReminders += ev.reminderIds.length;
  }
  if (repairedEvents) persist();
  return { repairedEvents, createdReminders };
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

export function addEvent(input: {
  title: string;
  start: number;
  end: number;
  location?: string;
  notes?: string;
  attendees?: string[];
  reminderLeads?: number[];
}): CalendarEvent {
  const list = load();
  const ev: CalendarEvent = {
    id: newId(),
    title: input.title.trim(),
    start: input.start,
    end: input.end,
    ...(input.location?.trim() ? { location: input.location.trim() } : {}),
    ...(input.notes?.trim() ? { notes: input.notes.trim() } : {}),
    ...(input.attendees?.length ? { attendees: input.attendees.map((a) => a.trim()).filter(Boolean) } : {}),
    status: "confirmed",
    reminderLeads: (input.reminderLeads ?? DEFAULT_REMINDER_LEADS).filter((n) => Number.isFinite(n) && n >= 0),
    reminderIds: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  syncReminders(ev);
  list.push(ev);
  persist();
  syncCalendarEntity(ev);
  return ev;
}

export function getEvent(id: string): CalendarEvent | undefined {
  return load().find((e) => e.id === id);
}

/** Import/update an event whose authoritative identity comes from Apple. */
export function upsertExternalEvent(input: { appleId: string; title: string; start: number; end: number; location?: string; notes?: string; attendees?: string[]; cancelled?: boolean }): CalendarEvent {
  let ev = load().find((item) => item.external?.appleId === input.appleId);
  const now = Date.now();
  if (!ev) {
    ev = { id: newId(), title: input.title.trim() || "Untitled event", start: input.start, end: input.end, status: input.cancelled ? "cancelled" : "confirmed", reminderLeads: [], reminderIds: [], createdAt: now, updatedAt: now, external: { appleId: input.appleId, lastSyncedAt: now } };
    load().push(ev);
  } else {
    ev.title = input.title.trim() || ev.title; ev.start = input.start; ev.end = input.end; ev.status = input.cancelled ? "cancelled" : "confirmed"; ev.updatedAt = now; ev.external = { ...ev.external, appleId: input.appleId, lastSyncedAt: now, lastSyncError: undefined };
  }
  ev.location = input.location?.trim() || undefined; ev.notes = input.notes?.trim() || undefined; ev.attendees = input.attendees?.filter(Boolean);
  syncReminders(ev); persist(); syncCalendarEntity(ev); return ev;
}

export function updateEvent(
  id: string,
  patch: Partial<Pick<CalendarEvent, "title" | "start" | "end" | "location" | "notes" | "attendees" | "reminderLeads">>,
): CalendarEvent | undefined {
  const ev = getEvent(id);
  if (!ev) return undefined;
  if (patch.title?.trim()) ev.title = patch.title.trim();
  if (Number.isFinite(patch.start)) ev.start = patch.start!;
  if (Number.isFinite(patch.end)) ev.end = patch.end!;
  if (patch.location !== undefined) ev.location = patch.location?.trim() || undefined;
  if (patch.notes !== undefined) ev.notes = patch.notes?.trim() || undefined;
  if (patch.attendees !== undefined) {
    const list = patch.attendees?.map((a) => a.trim()).filter(Boolean);
    ev.attendees = list?.length ? list : undefined;
  }
  if (patch.reminderLeads !== undefined) {
    ev.reminderLeads = patch.reminderLeads.filter((n) => Number.isFinite(n) && n >= 0);
  }
  ev.updatedAt = Date.now();
  syncReminders(ev); // times/text may have changed — reminders must match
  persist();
  syncCalendarEntity(ev);
  return ev;
}

function syncCalendarEntity(event: CalendarEvent): void {
  upsertEntity("calendar_event", event.id, event.title, [event.external?.appleId ?? "", ...(event.attendees ?? [])]);
}

/** Persist external calendar mirror ids/status without changing event content. */
export function setEventExternal(
  id: string,
  external: CalendarEvent["external"],
): CalendarEvent | undefined {
  const ev = getEvent(id);
  if (!ev) return undefined;
  ev.external = { ...(ev.external ?? {}), ...(external ?? {}) };
  ev.updatedAt = Date.now();
  persist();
  return ev;
}

/** Cancel keeps the event for history but kills its reminders. */
export function cancelEvent(id: string): CalendarEvent | undefined {
  const ev = getEvent(id);
  if (!ev) return undefined;
  ev.status = "cancelled";
  ev.updatedAt = Date.now();
  syncReminders(ev); // drops all scheduler items
  persist();
  return ev;
}

// ── queries ───────────────────────────────────────────────────────────────────

/** Confirmed events overlapping [from, to), soonest first. */
export function listEvents(from: number, to: number, includeCancelled = false): CalendarEvent[] {
  return load()
    .filter((e) => (includeCancelled || e.status === "confirmed") && e.start < to && e.end > from)
    .sort((a, b) => a.start - b.start);
}

export function searchEvents(query: string, limit = 20): CalendarEvent[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return load()
    .filter((e) =>
      [e.id, e.title, e.location, e.notes, ...(e.attendees ?? [])].filter(Boolean).join("\n").toLowerCase().includes(q),
    )
    .sort((a, b) => a.start - b.start)
    .slice(0, limit);
}

/** Confirmed events that overlap the given window (ignoring one id, for reschedules). */
export function findConflicts(start: number, end: number, ignoreId?: string): CalendarEvent[] {
  return listEvents(start, end).filter((e) => e.id !== ignoreId);
}

/**
 * Free slots of at least durationMs between `from` and `to`, constrained to
 * daily working hours. Slots never start in the past.
 */
export function freeSlots(input: {
  from: number;
  to: number;
  durationMs: number;
  dayStartHour?: number;
  dayEndHour?: number;
  maxSlots?: number;
}): Array<{ start: number; end: number }> {
  const dayStart = input.dayStartHour ?? 9;
  const dayEnd = input.dayEndHour ?? 18;
  const max = input.maxSlots ?? 10;
  const now = Date.now();
  const busy = listEvents(input.from, input.to);
  const slots: Array<{ start: number; end: number }> = [];

  const day = new Date(input.from);
  day.setHours(0, 0, 0, 0);
  while (day.getTime() < input.to && slots.length < max) {
    const winStart = Math.max(new Date(day).setHours(dayStart, 0, 0, 0), input.from, now);
    const winEnd = Math.min(new Date(day).setHours(dayEnd, 0, 0, 0), input.to);
    let cursor = winStart;
    for (const ev of busy) {
      if (ev.end <= winStart || ev.start >= winEnd) continue;
      if (ev.start - cursor >= input.durationMs) slots.push({ start: cursor, end: ev.start });
      cursor = Math.max(cursor, ev.end);
      if (slots.length >= max) break;
    }
    if (slots.length < max && winEnd - cursor >= input.durationMs) slots.push({ start: cursor, end: winEnd });
    day.setDate(day.getDate() + 1);
  }
  return slots.slice(0, max);
}

// ── prompt block ──────────────────────────────────────────────────────────────

/** Compact upcoming agenda injected into the system prompt so Sophie always
 *  knows what's on the calendar without a tool call. */
export function calendarForPrompt(): string {
  const now = Date.now();
  const horizon = now + 7 * 24 * 3_600_000;
  const upcoming = listEvents(now - 3_600_000, horizon).slice(0, 12);
  if (!upcoming.length) return "";
  const lines = upcoming.map((e) => {
    const where = e.location ? ` @ ${e.location}` : "";
    const who = e.attendees?.length ? ` (${e.attendees.join(", ")})` : "";
    return `- ${e.id} · ${fmtRange(e.start, e.end)} · ${e.title}${where}${who}`;
  });
  return [
    "# Calendar (next 7 days)",
    "The user's upcoming events. Use the calendar tool to add, reschedule, cancel, search, or find free slots; every event auto-reminds via notification/Telegram before it starts.",
    ...lines,
  ].join("\n");
}
