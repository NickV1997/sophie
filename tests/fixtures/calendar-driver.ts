/**
 * Subprocess driver for calendar store tests. MEMORY_DIR is resolved from
 * homedir() at module load, so this must run in a child process whose HOME
 * points at a throwaway dir (see tests/calendar.test.ts). Prints PASS/FAIL
 * lines and exits non-zero on any failure.
 */
import { listSchedule, setScheduleEnabled } from "../../src/agent/scheduler.ts";
import { calendarForPrompt, reconcileCalendarReminders, upsertExternalEvent, searchEvents } from "../../src/calendar/store.ts";
import { calendar } from "../../src/tools/calendar.ts";

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const run = (args: Record<string, any>) => calendar.execute(args, { cwd: "/tmp" });

// Fixed future times so assertions are deterministic. Stay comfortably inside
// calendarForPrompt's 7-day agenda horizon — at exactly +7 days the afternoon
// event falls outside it whenever the suite runs earlier in the day.
const day = new Date();
day.setDate(day.getDate() + 5); // days out, avoids "past" refusals
const ymd = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;

const add1 = await run({
  action: "add",
  title: "Team sync",
  start: `${ymd} 14:00`,
  duration_minutes: 30,
  attendees: ["Dana"],
  location: "Zoom",
  reminders: [30, 5],
});
check("add ok", !add1.isError && add1.content.includes("Team sync"), add1.content);
const id1 = add1.content.match(/cal-[a-z0-9-]+/)?.[0] ?? "";
check("add created 2 scheduler reminders", listSchedule().length === 2);
const brokenReminder = listSchedule()[0];
if (brokenReminder) setScheduleEnabled(brokenReminder.id, false);
const repaired = reconcileCalendarReminders();
check("startup reconciliation repairs missing reminders", repaired.repairedEvents === 1 && listSchedule().filter((i) => i.title.includes("Team sync")).length === 2);

const past = await run({ action: "add", title: "Old", start: "2020-01-01 10:00" });
check("past start refused", past.isError === true);

const add2 = await run({ action: "add", title: "Overlap", start: `${ymd} 14:15`, duration_minutes: 30 });
check("conflict flagged", add2.content.includes("Conflicts with") && add2.content.includes("Team sync"), add2.content);
const id2 = add2.content.match(/cal-[a-z0-9-]+/)?.[0] ?? "";

const list = await run({ action: "list", range: ymd });
check("list day shows both", list.content.includes("Team sync") && list.content.includes("Overlap"), list.content);

const free = await run({ action: "find_free", range: ymd, duration_minutes: 60 });
check("find_free ok", !free.isError && free.content.includes("Free slots"), free.content);
check("find_free excludes the busy block", !free.content.includes("2:00 PM–2:1"), free.content);

const upd = await run({ action: "update", id: id1, start: `${ymd} 16:00` });
check("reschedule ok", !upd.isError && upd.content.includes("4:00"), upd.content);
const remHours = listSchedule()
  .filter((i) => i.title.includes("Team sync"))
  .map((i) => new Date(i.nextAt).getHours());
check("reminders moved with the event", remHours.length === 2 && remHours.every((h) => h === 15), JSON.stringify(remHours));

const before = listSchedule().length;
const cancel = await run({ action: "cancel", id: id1 });
check("cancel ok", !cancel.isError && cancel.content.includes("Cancelled"));
check("cancel removed its reminders", listSchedule().length === before - 2);
const listAfter = await run({ action: "list", range: ymd });
check("cancelled hidden from list", !listAfter.content.includes("Team sync"), listAfter.content);

const search = await run({ action: "search", query: "overlap" });
check("search finds by title", search.content.includes(id2), search.content);

const prompt = calendarForPrompt();
check("prompt agenda includes upcoming event", prompt.includes("Overlap") && prompt.includes("# Calendar"), prompt);

const badTime = await run({ action: "add", title: "X", start: "whenever" });
check("bad start errors cleanly", badTime.isError === true);

upsertExternalEvent({ appleId: "apple-test-1", title: "Imported Apple event", start: day.getTime(), end: day.getTime() + 3_600_000 });
upsertExternalEvent({ appleId: "apple-test-1", title: "Imported Apple event updated", start: day.getTime(), end: day.getTime() + 3_600_000 });
check("Apple import upserts by provider id without duplicates", searchEvents("Imported Apple").length === 1 && searchEvents("updated").length === 1);

process.exit(failures ? 1 : 0);
