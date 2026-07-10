import { platform } from "node:os";
import { runOsa } from "../tools/apple.ts";

/**
 * Mirror of Sophie's scheduled reminders into the macOS Reminders app, so a
 * reminder set through the schedule tool also shows up on the user's devices.
 * The scheduler stays the source of truth: it stores the created reminder's id
 * (ScheduleItem.mirror.appleId) and this module keeps the Apple copy in sync on
 * update/cancel and marks it completed when the reminder fires. Everything here
 * is best-effort — a missing Reminders permission must never break scheduling.
 */

export function appleRemindersAvailable(): boolean {
  return platform() === "darwin";
}

/** Create a reminder in the default list; returns its id, or null on failure. */
export async function createAppleReminder(name: string, dueMs: number, notes?: string): Promise<string | null> {
  if (!appleRemindersAvailable()) return null;
  const script =
    "function run(argv){" +
    'const app=Application("Reminders");' +
    "const props={name:argv[0],remindMeDate:new Date(Number(argv[1]))};" +
    "if(argv[2])props.body=argv[2];" +
    "const r=app.Reminder(props);" +
    "app.defaultList().reminders.push(r);" +
    "return r.id();}";
  const res = await runOsa(script, { lang: "JavaScript", args: [name, String(dueMs), notes ?? ""] });
  return res.ok && res.out ? res.out : null;
}

/** Update the mirrored reminder's name and/or due time. */
export async function updateAppleReminder(id: string, patch: { name?: string; dueMs?: number }): Promise<boolean> {
  if (!appleRemindersAvailable()) return false;
  const script =
    "function run(argv){" +
    'const app=Application("Reminders");' +
    "const r=app.reminders.byId(argv[0]);" +
    "if(argv[1])r.name=argv[1];" +
    "if(argv[2])r.remindMeDate=new Date(Number(argv[2]));" +
    "return 'ok';}";
  const res = await runOsa(script, {
    lang: "JavaScript",
    args: [id, patch.name ?? "", patch.dueMs ? String(patch.dueMs) : ""],
  });
  return res.ok;
}

/** Delete the mirrored reminder (used when the schedule item is cancelled). */
export async function deleteAppleReminder(id: string): Promise<boolean> {
  if (!appleRemindersAvailable()) return false;
  const script =
    "function run(argv){" +
    'const app=Application("Reminders");' +
    "app.delete(app.reminders.byId(argv[0]));" +
    "return 'ok';}";
  const res = await runOsa(script, { lang: "JavaScript", args: [id] });
  return res.ok;
}

/** Mark the mirrored reminder done (used when the schedule item fires). */
export async function completeAppleReminder(id: string): Promise<boolean> {
  if (!appleRemindersAvailable()) return false;
  const script =
    "function run(argv){" +
    'const app=Application("Reminders");' +
    "app.reminders.byId(argv[0]).completed=true;" +
    "return 'ok';}";
  const res = await runOsa(script, { lang: "JavaScript", args: [id] });
  return res.ok;
}
