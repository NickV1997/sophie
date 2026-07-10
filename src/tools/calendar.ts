import {
  addEvent,
  cancelEvent,
  findConflicts,
  fmtDay,
  fmtRange,
  fmtTime,
  freeSlots,
  getEvent,
  listEvents,
  searchEvents,
  updateEvent,
  type CalendarEvent,
} from "../calendar/store.ts";
import { calendarSyncStatus, syncCalendarEvent } from "../calendar/sync.ts";
import type { Tool } from "./types.ts";

function renderEvent(e: CalendarEvent): string {
  const where = e.location ? ` @ ${e.location}` : "";
  const who = e.attendees?.length ? ` with ${e.attendees.join(", ")}` : "";
  const note = e.notes ? ` — ${e.notes.replace(/\s+/g, " ").slice(0, 120)}` : "";
  const state = e.status === "cancelled" ? " [cancelled]" : "";
  const rem = e.reminderLeads.length ? ` (remind ${e.reminderLeads.join("/")}m before)` : "";
  return `- ${e.id} · ${fmtRange(e.start, e.end)} · ${e.title}${who}${where}${rem}${note}${state}`;
}

/**
 * Parse a calendar time. Accepts "HH:MM" (next occurrence), "today HH:MM",
 * "tomorrow[ HH:MM]", "YYYY-MM-DD[ HH:MM]", or full ISO. Date-only strings
 * resolve to 09:00 local. Returns epoch ms or null.
 */
export function parseWhen(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  const now = new Date();

  const rel = s.match(/^(today|tomorrow)(?:\s+(\d{1,2}):(\d{2}))?$/i);
  if (rel) {
    const d = new Date();
    if (rel[1].toLowerCase() === "tomorrow") d.setDate(d.getDate() + 1);
    d.setHours(rel[2] ? Number(rel[2]) : 9, rel[3] ? Number(rel[3]) : 0, 0, 0);
    return d.getTime();
  }
  const hm = s.match(/^(\d{1,2}):(\d{2})$/);
  if (hm) {
    const d = new Date();
    d.setHours(Number(hm[1]), Number(hm[2]), 0, 0);
    if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  const dateOnly = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) {
    // Construct locally — new Date("YYYY-MM-DD") would parse as UTC midnight.
    return new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]), 9, 0, 0, 0).getTime();
  }
  const ts = new Date(s).getTime(); // "YYYY-MM-DD HH:MM" and ISO parse as local
  return Number.isFinite(ts) ? ts : null;
}

/** Resolve a list/find_free window from range|from|to. Defaults to now → +7 days. */
function resolveWindow(args: Record<string, any>): { from: number; to: number; label: string } | null {
  const now = Date.now();
  const dayMs = 24 * 3_600_000;
  const range = typeof args.range === "string" ? args.range.trim().toLowerCase() : "";
  if (range === "today" || range === "tomorrow") {
    const d = new Date();
    if (range === "tomorrow") d.setDate(d.getDate() + 1);
    d.setHours(0, 0, 0, 0);
    return { from: d.getTime(), to: d.getTime() + dayMs, label: range };
  }
  if (range === "week" || !range) {
    const from = args.from ? parseWhen(String(args.from)) : null;
    const to = args.to ? parseWhen(String(args.to)) : null;
    if (args.from && from == null) return null;
    if (args.to && to == null) return null;
    if (from != null || to != null) {
      const f = from ?? now;
      return { from: f, to: to ?? f + 7 * dayMs, label: "range" };
    }
    return { from: now, to: now + 7 * dayMs, label: "next 7 days" };
  }
  // A bare date like "2026-07-10" as range → that whole day.
  const dayStart = parseWhen(range);
  if (dayStart == null) return null;
  const d = new Date(dayStart);
  d.setHours(0, 0, 0, 0);
  return { from: d.getTime(), to: d.getTime() + dayMs, label: fmtDay(d.getTime()) };
}

function conflictNote(start: number, end: number, ignoreId?: string): string {
  const clashes = findConflicts(start, end, ignoreId);
  if (!clashes.length) return "";
  return `\n⚠️ Conflicts with:\n${clashes.map(renderEvent).join("\n")}\nTell the user about the overlap; use find_free to suggest another time if they want to move it.`;
}

function syncNote(results: Awaited<ReturnType<typeof syncCalendarEvent>>): string {
  if (!results.length) return `\nSync: ${calendarSyncStatus()}.`;
  return `\nSync: ${results.map((r) => `${r.provider} ${r.ok ? "ok" : `failed (${r.detail})`}`).join(" · ")}.`;
}

export const calendar: Tool = {
  name: "calendar",
  description:
    "The user's calendar — meetings, appointments, and events with automatic " +
      "reminders (notification/Telegram before each event). Actions: 'add' an event " +
    "(title + start like '2026-07-10 14:00', 'tomorrow 09:30', or '15:00'; " +
    "duration_minutes or end; optional location/notes/attendees; reminders = " +
    "minutes-before list, default [30, 5]). 'list' events (range 'today'/'tomorrow'/" +
    "'week' or from/to). 'find_free' returns open slots for a duration within " +
    "working hours — use it BEFORE booking a meeting to check availability. " +
    "'update' reschedules or edits by id (reminders move automatically). " +
    "'cancel' (id), 'search' (query), and 'sync' to mirror upcoming events. " +
    "The internal Sophie calendar is the source of truth; when configured, events sync to Apple Calendar on macOS. Adding always confirms conflicts back to you.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["add", "list", "find_free", "update", "cancel", "search", "sync"], description: "Operation." },
      title: { type: "string", description: "Event title (add/update)." },
      start: { type: "string", description: "Start time: 'YYYY-MM-DD HH:MM', ISO, 'tomorrow 14:00', or 'HH:MM' (next occurrence)." },
      end: { type: "string", description: "End time, same formats. Alternative to duration_minutes." },
      duration_minutes: { type: "number", description: "Event length in minutes (default 60; for find_free default 30)." },
      location: { type: "string", description: "Where — a place, address, or meeting link." },
      notes: { type: "string", description: "Free-form details (agenda, phone number, who asked)." },
      attendees: { type: "array", items: { type: "string" }, description: "People involved, e.g. ['Alex', 'dana@co.com']." },
      reminders: { type: "array", items: { type: "number" }, description: "Reminder lead times in minutes before start. Default [30, 5] (heads-up + about-to-start ping). [] = none." },
      range: { type: "string", description: "list/find_free window: 'today', 'tomorrow', 'week', or a date 'YYYY-MM-DD'." },
      from: { type: "string", description: "Window start (alternative to range)." },
      to: { type: "string", description: "Window end." },
      day_start_hour: { type: "number", description: "find_free: earliest hour to offer (default 9)." },
      day_end_hour: { type: "number", description: "find_free: latest hour to offer (default 18)." },
      id: { type: "string", description: "Event id for update/cancel." },
      query: { type: "string", description: "Text to search titles/locations/notes/attendees." },
      include_cancelled: { type: "boolean", description: "list: also show cancelled events." },
    },
    required: ["action"],
  },
  summarize: (a) => {
    const action = String(a.action ?? "list");
    if (action === "add") return `add "${a.title ?? "?"}" ${a.start ?? ""}`;
    if (action === "find_free") return `free ${a.duration_minutes ?? 30}m ${a.range ?? ""}`.trim();
    if (action === "search") return `search "${a.query ?? ""}"`;
    return a.id ? `${action} ${a.id}` : `${action} ${a.range ?? ""}`.trim();
  },
  risk: () => "safe",
  async execute(args) {
    const action = String(args.action ?? "list");

    if (action === "list") {
      const win = resolveWindow(args);
      if (!win) return { content: "Couldn't parse the range. Use 'today', 'tomorrow', 'week', a 'YYYY-MM-DD' date, or from/to.", isError: true };
      const events = listEvents(win.from, win.to, args.include_cancelled === true);
      return {
        content: events.length
          ? `Events (${win.label}):\n${events.map(renderEvent).join("\n")}`
          : `No events ${win.label === "range" ? "in that range" : `for ${win.label}`}.`,
        display: `${events.length} event${events.length === 1 ? "" : "s"}`,
      };
    }

    if (action === "search") {
      const query = String(args.query ?? "").trim();
      if (!query) return { content: "search needs a query.", isError: true };
      const events = searchEvents(query);
      return {
        content: events.length ? `Matches for "${query}":\n${events.map(renderEvent).join("\n")}` : `No events matching "${query}".`,
        display: `${events.length} match${events.length === 1 ? "" : "es"}`,
      };
    }

    if (action === "find_free") {
      const win = resolveWindow(args);
      if (!win) return { content: "Couldn't parse the range for find_free.", isError: true };
      const duration = Math.max(5, Number(args.duration_minutes) || 30);
      const slots = freeSlots({
        from: win.from,
        to: win.to,
        durationMs: duration * 60_000,
        dayStartHour: Number.isFinite(Number(args.day_start_hour)) ? Number(args.day_start_hour) : undefined,
        dayEndHour: Number.isFinite(Number(args.day_end_hour)) ? Number(args.day_end_hour) : undefined,
      });
      if (!slots.length) {
        return { content: `No free ${duration}-minute slots ${win.label === "range" ? "in that range" : `for ${win.label}`} within working hours. Try a wider range or different hours.` };
      }
      const lines = slots.map((s) => `- ${fmtDay(s.start)} ${fmtTime(s.start)}–${fmtTime(s.end)}`);
      return {
        content: `Free slots (≥${duration} min, ${win.label}):\n${lines.join("\n")}\nPick one and calendar(action:'add') to book it.`,
        display: `${slots.length} slots`,
      };
    }

    if (action === "cancel") {
      const id = String(args.id ?? "").trim();
      if (!id) return { content: "cancel needs an event id.", isError: true };
      const ev = cancelEvent(id);
      const synced = ev ? await syncCalendarEvent(ev) : [];
      return ev
        ? { content: `Cancelled (reminders removed):\n${renderEvent(ev)}${syncNote(synced)}`, display: `cancelled ${id}` }
        : { content: `No event with id ${id}. Use action 'list' or 'search' to find it.`, isError: true };
    }

    if (action === "update") {
      const id = String(args.id ?? "").trim();
      if (!id) return { content: "update needs an event id.", isError: true };
      const existing = getEvent(id);
      if (!existing) return { content: `No event with id ${id}. Use action 'list' or 'search' to find it.`, isError: true };

      let start: number | undefined;
      let end: number | undefined;
      if (typeof args.start === "string" && args.start.trim()) {
        const parsed = parseWhen(args.start);
        if (parsed == null) return { content: `Couldn't parse start "${args.start}".`, isError: true };
        start = parsed;
      }
      if (typeof args.end === "string" && args.end.trim()) {
        const parsed = parseWhen(args.end);
        if (parsed == null) return { content: `Couldn't parse end "${args.end}".`, isError: true };
        end = parsed;
      } else if (start != null) {
        const duration = Number(args.duration_minutes) > 0 ? Number(args.duration_minutes) * 60_000 : existing.end - existing.start;
        end = start + duration;
      } else if (Number(args.duration_minutes) > 0) {
        end = existing.start + Number(args.duration_minutes) * 60_000;
      }

      const ev = updateEvent(id, {
        ...(typeof args.title === "string" && args.title.trim() ? { title: args.title } : {}),
        ...(start != null ? { start } : {}),
        ...(end != null ? { end } : {}),
        ...(typeof args.location === "string" ? { location: args.location } : {}),
        ...(typeof args.notes === "string" ? { notes: args.notes } : {}),
        ...(Array.isArray(args.attendees) ? { attendees: args.attendees.map(String) } : {}),
        ...(Array.isArray(args.reminders) ? { reminderLeads: args.reminders.map(Number) } : {}),
      });
      if (!ev) return { content: `No event with id ${id}.`, isError: true };
      const synced = await syncCalendarEvent(ev);
      return {
        content: `Updated (reminders re-synced):\n${renderEvent(ev)}${conflictNote(ev.start, ev.end, ev.id)}${syncNote(synced)}`,
        display: `updated ${id}`,
      };
    }

    if (action === "sync") {
      const win = resolveWindow(args);
      if (!win) return { content: "Couldn't parse the sync range. Use 'today', 'tomorrow', 'week', a 'YYYY-MM-DD' date, or from/to.", isError: true };
      const events = listEvents(win.from, win.to, args.include_cancelled === true);
      const results = [];
      for (const ev of events) results.push(...await syncCalendarEvent(ev));
      const ok = results.filter((r) => r.ok).length;
      const failed = results.length - ok;
      return {
        content: results.length
          ? `Calendar sync (${win.label}): ${ok} ok, ${failed} failed.\n${results.map((r) => `- ${r.provider}: ${r.ok ? "ok" : r.detail}`).join("\n")}`
          : `No events to sync for ${win.label}. ${calendarSyncStatus()}.`,
        display: `${ok} synced${failed ? `, ${failed} failed` : ""}`,
      };
    }

    if (action !== "add") return { content: `Unknown calendar action "${action}".`, isError: true };

    // ── add ──
    const title = String(args.title ?? "").trim();
    if (!title) return { content: "add needs a title.", isError: true };
    const startRaw = String(args.start ?? "").trim();
    if (!startRaw) return { content: "add needs a start time (e.g. '2026-07-10 14:00', 'tomorrow 09:30', '15:00').", isError: true };
    const start = parseWhen(startRaw);
    if (start == null) return { content: `Couldn't parse start "${startRaw}". Use 'YYYY-MM-DD HH:MM', ISO, 'tomorrow HH:MM', or 'HH:MM'.`, isError: true };
    if (start <= Date.now()) return { content: `That start (${fmtRange(start, start)}) is in the past. Double-check the date.`, isError: true };

    let end: number;
    if (typeof args.end === "string" && args.end.trim()) {
      const parsed = parseWhen(args.end);
      if (parsed == null) return { content: `Couldn't parse end "${args.end}".`, isError: true };
      end = parsed;
    } else {
      const duration = Number(args.duration_minutes) > 0 ? Number(args.duration_minutes) : 60;
      end = start + duration * 60_000;
    }
    if (end <= start) return { content: "End must be after start.", isError: true };

    const ev = addEvent({
      title,
      start,
      end,
      location: typeof args.location === "string" ? args.location : undefined,
      notes: typeof args.notes === "string" ? args.notes : undefined,
      attendees: Array.isArray(args.attendees) ? args.attendees.map(String) : undefined,
      reminderLeads: Array.isArray(args.reminders) ? args.reminders.map(Number) : undefined,
    });
    const reminded = ev.reminderIds.length
      ? `Reminders set for ${ev.reminderLeads.join("/")} min before.`
      : "No reminders (all lead times already passed or none requested).";
    const synced = await syncCalendarEvent(ev);
    return {
      content: `Event added:\n${renderEvent(ev)}\n${reminded}${conflictNote(ev.start, ev.end, ev.id)}${syncNote(synced)}`,
      display: `${fmtRange(ev.start, ev.end)}`,
    };
  },
};
