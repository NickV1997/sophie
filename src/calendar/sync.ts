import { platform } from "node:os";
import { runOsa } from "../tools/apple.ts";
import {
  getEvent,
  listEvents,
  setEventExternal,
  upsertExternalEvent,
  type CalendarEvent,
} from "./store.ts";

export interface CalendarSyncResult {
  provider: "apple";
  ok: boolean;
  detail: string;
  externalId?: string;
}

function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function appleCalendarName(): string {
  return (process.env.SOPHIE_APPLE_CALENDAR_NAME ?? "Sophie").trim() || "Sophie";
}

function appleCalendarSyncEnabled(): boolean {
  const raw = process.env.SOPHIE_APPLE_CALENDAR_SYNC;
  if (raw === undefined || raw.trim() === "") return true;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

export function appleCalendarAvailable(): boolean {
  return platform() === "darwin" && appleCalendarSyncEnabled();
}

function eventDescription(ev: CalendarEvent): string {
  const parts = [
    ev.notes ?? "",
    ev.attendees?.length ? `Attendees: ${ev.attendees.join(", ")}` : "",
    `Sophie event id: ${ev.id}`,
  ].filter(Boolean);
  return parts.join("\n\n");
}

async function syncAppleEvent(ev: CalendarEvent): Promise<CalendarSyncResult> {
  if (!appleCalendarAvailable()) return { provider: "apple", ok: false, detail: "Apple Calendar is only available on macOS" };
  const calendar = appleCalendarName();
  const args = [
    calendar,
    ev.external?.appleId ?? "",
    ev.title,
    String(ev.start),
    String(ev.end),
    ev.location ?? "",
    eventDescription(ev),
    JSON.stringify(ev.reminderLeads),
    ev.status,
  ];
  const script =
    "function run(argv){" +
    'const app=Application("Calendar");' +
    "let calName=argv[0], id=argv[1], title=argv[2], start=new Date(Number(argv[3])), end=new Date(Number(argv[4]));" +
    "let loc=argv[5], desc=argv[6], leads=JSON.parse(argv[7]||'[]'), status=argv[8];" +
    "let cal;" +
    "try{cal=app.calendars.byName(calName);cal.name();}catch(e){cal=app.Calendar({name:calName});app.calendars.push(cal);}" +
    "function clearAlarms(ev){try{const as=ev.soundAlarms();for(let i=as.length-1;i>=0;i--)app.delete(as[i]);}catch(e){}}" +
    "function apply(ev){ev.summary=title;ev.startDate=start;ev.endDate=end;ev.location=loc;ev.description=desc;clearAlarms(ev);for(const m of leads){try{ev.soundAlarms.push(app.SoundAlarm({triggerInterval:-Number(m)}));}catch(e){}}return ev.id();}" +
    "if(status==='cancelled'){" +
    " if(id){try{app.delete(app.events.byId(id));return 'deleted:'+id;}catch(e){return 'missing:'+id;}}" +
    " return 'none';" +
    "}" +
    "if(id){try{return apply(app.events.byId(id));}catch(e){}}" +
    "const ev=app.Event({summary:title,startDate:start,endDate:end,location:loc,description:desc});cal.events.push(ev);return apply(ev);" +
    "}";
  const res = await runOsa(script, { lang: "JavaScript", args });
  if (!res.ok) return { provider: "apple", ok: false, detail: res.err || "Apple Calendar sync failed" };
  const out = res.out.trim();
  if (out.startsWith("deleted:") || out.startsWith("missing:") || out === "none") {
    setEventExternal(ev.id, { appleId: undefined, lastSyncedAt: Date.now(), lastSyncError: undefined });
    return { provider: "apple", ok: true, detail: out.startsWith("missing:") ? "Apple Calendar event was already gone" : "Apple Calendar event removed" };
  }
  setEventExternal(ev.id, { appleId: out, lastSyncedAt: Date.now(), lastSyncError: undefined });
  return { provider: "apple", ok: true, detail: "Apple Calendar synced", externalId: out };
}

export async function syncCalendarEvent(idOrEvent: string | CalendarEvent): Promise<CalendarSyncResult[]> {
  const ev = typeof idOrEvent === "string" ? getEvent(idOrEvent) : idOrEvent;
  if (!ev) return [];
  const results: CalendarSyncResult[] = [];
  if (appleCalendarAvailable()) results.push(await syncAppleEvent(ev));
  return results;
}

export async function syncUpcomingCalendarEvents(days = 90): Promise<CalendarSyncResult[]> {
  const now = Date.now();
  const events = listEvents(now - 24 * 3_600_000, now + days * 24 * 3_600_000, true);
  const out: CalendarSyncResult[] = [];
  for (const ev of events) out.push(...await syncCalendarEvent(ev));
  return out;
}

export async function reconcileFromAppleCalendar(from = Date.now() - 7 * 86_400_000, to = Date.now() + 90 * 86_400_000): Promise<CalendarSyncResult> {
  if (!appleCalendarAvailable()) return { provider: "apple", ok: true, detail: "Using built-in calendar fallback" };
  const script = "function run(argv){const app=Application('Calendar');const from=new Date(Number(argv[0])),to=new Date(Number(argv[1]));const rows=[];for(const cal of app.calendars()){let es=[];try{es=cal.events.whose({startDate:{_lessThan:to},endDate:{_greaterThan:from}})();}catch(e){continue;}for(const ev of es){try{rows.push({id:ev.id(),title:ev.summary()||'Untitled event',start:ev.startDate().getTime(),end:ev.endDate().getTime(),location:ev.location()||'',notes:ev.description()||'',calendar:cal.name()});}catch(e){}}}return JSON.stringify(rows);}";
  const res = await runOsa(script, { lang: "JavaScript", args: [String(from), String(to)] });
  if (!res.ok) return { provider: "apple", ok: false, detail: res.err || "Apple Calendar import failed" };
  try {
    const rows = JSON.parse(res.out || "[]") as Array<{ id: string; title: string; start: number; end: number; location?: string; notes?: string }>;
    for (const row of rows) if (row.id && Number.isFinite(row.start) && Number.isFinite(row.end)) upsertExternalEvent({ appleId: row.id, title: row.title, start: row.start, end: row.end, location: row.location, notes: row.notes });
    return { provider: "apple", ok: true, detail: `Imported ${rows.length} Apple Calendar event${rows.length === 1 ? "" : "s"}` };
  } catch { return { provider: "apple", ok: false, detail: "Apple Calendar returned invalid event data" }; }
}

export function calendarSyncStatus(): string {
  const parts = [
    appleCalendarAvailable() ? `Apple Calendar "${appleCalendarName()}"` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" + ") : "No external calendar sync configured";
}
