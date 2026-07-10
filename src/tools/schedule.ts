import {
  addCron,
  addOnce,
  cancelSchedule,
  getScheduleItem,
  listSchedule,
  nextCronTime,
  setScheduleEnabled,
  setScheduleMirror,
  updateSchedule,
  type ScheduleAction,
  type ScheduleItem,
} from "../agent/scheduler.ts";
import {
  appleRemindersAvailable,
  createAppleReminder,
  deleteAppleReminder,
  updateAppleReminder,
} from "../channels/apple_reminders.ts";
import { sendTelegram, telegramReady } from "../channels/telegram.ts";
import type { Tool } from "./types.ts";

function fmt(ts: number): string {
  return new Date(ts).toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function renderItem(i: ScheduleItem): string {
  const when = i.kind === "cron" ? `cron "${i.cron}" (next ${fmt(i.nextAt)})` : `at ${fmt(i.nextAt)}`;
  const what = i.action === "run" ? `run: ${i.prompt}` : `notify: ${i.message}`;
  const state = i.enabled ? "" : " [done/disabled]";
  return `- ${i.id} · ${i.title} · ${when} · ${what}${state}`;
}

/**
 * Keep the external copies of a notify-reminder in step with the scheduler
 * (which stays the source of truth): a one-off notify item gets a real entry
 * in the macOS Reminders app, and Telegram gets a short confirmation so the
 * reminder is visible on the user's phone right away (the firing itself
 * already reaches Telegram through the notifier). Best-effort by design —
 * returns a short status line for the tool output, never an error.
 */
async function syncMirrors(
  item: ScheduleItem,
  change: "set" | "updated" | "cancelled",
): Promise<string> {
  const notes: string[] = [];
  const isOnceNotify = item.kind === "once" && item.action === "notify";

  if (appleRemindersAvailable()) {
    const appleId = item.mirror?.appleId;
    if (change === "cancelled" || (appleId && !isOnceNotify)) {
      // Item gone (or no longer mirrorable, e.g. converted to cron) — remove the Apple copy.
      if (appleId) {
        notes.push((await deleteAppleReminder(appleId)) ? "removed from Apple Reminders" : "Apple Reminders removal failed");
        if (change !== "cancelled") setScheduleMirror(item.id, {});
      }
    } else if (isOnceNotify && appleId) {
      notes.push(
        (await updateAppleReminder(appleId, { name: item.title, dueMs: item.nextAt }))
          ? "Apple Reminders updated"
          : "Apple Reminders update failed",
      );
    } else if (isOnceNotify) {
      const id = await createAppleReminder(item.title, item.nextAt, item.message);
      if (id) setScheduleMirror(item.id, { ...item.mirror, appleId: id });
      notes.push(id ? "added to Apple Reminders" : "Apple Reminders unavailable (check automation permission)");
    }
  }

  if (item.action === "notify" && telegramReady()) {
    const icon = change === "cancelled" ? "❌" : "⏰";
    const when = item.kind === "cron" ? `recurring (${item.cron})` : fmt(item.nextAt);
    const r = await sendTelegram(`${icon} Reminder ${change}: ${item.title} — ${when}`);
    notes.push(r.ok ? `Telegram ${change === "cancelled" ? "notified" : "confirmation sent"}` : "Telegram send failed");
  }

  return notes.length ? `\nAlso: ${notes.join(" · ")}.` : "";
}

/**
 * Parse a target time for a one-off item. Accepts a relative delay
 * (in_minutes / in_hours) or an absolute time: ISO 8601, "YYYY-MM-DD HH:MM", or
 * a bare "HH:MM" (next occurrence today or tomorrow). Returns epoch ms or null.
 */
function resolveOnceTime(args: Record<string, any>): number | null {
  const now = Date.now();
  if (args.in_minutes != null && Number.isFinite(Number(args.in_minutes))) {
    return now + Math.max(0, Number(args.in_minutes)) * 60_000;
  }
  if (args.in_hours != null && Number.isFinite(Number(args.in_hours))) {
    return now + Math.max(0, Number(args.in_hours)) * 3_600_000;
  }
  const at = typeof args.at === "string" ? args.at.trim() : "";
  if (!at) return null;

  // Bare HH:MM → next occurrence.
  const hm = at.match(/^(\d{1,2}):(\d{2})$/);
  if (hm) {
    const d = new Date();
    d.setHours(Number(hm[1]), Number(hm[2]), 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  // Otherwise let Date parse it (ISO, "2026-07-10 09:30", etc.).
  const parsed = new Date(at.includes("T") || at.includes(" ") ? at : `${at}T09:00`);
  const ts = parsed.getTime();
  return Number.isFinite(ts) ? ts : null;
}

export const schedule: Tool = {
  name: "schedule",
  description:
    "Set reminders, alarms, and recurring cron jobs — the way Sophie remembers to " +
    "do or say something at a specific time without staying busy in the meantime. " +
    "action 'add' schedules a one-off (in_minutes/in_hours or an absolute time in " +
    "'at') or a recurring job (cron, 5-field 'min hour day month weekday'). When it " +
    "fires it either notifies the user (do='notify' with message) or wakes you to " +
    "act (do='run' with a prompt). One-off notify reminders are mirrored into the " +
    "macOS Reminders app and confirmed over Telegram automatically. action 'update' " +
    "(id + any of title/message/prompt/do/time/cron) changes an existing item and " +
    "keeps the mirrors in sync. Also 'list', 'cancel' (id), 'enable'/'disable' (id).",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["add", "update", "list", "cancel", "enable", "disable"], description: "Operation." },
      title: { type: "string", description: "Short label for the schedule (add)." },
      do: {
        type: "string",
        enum: ["notify", "run"],
        description: "On fire: 'notify' the user with a message, or 'run' a task described by prompt. Default notify.",
      },
      message: { type: "string", description: "Message to send when do='notify'." },
      prompt: { type: "string", description: "Instruction for Sophie to carry out when do='run'." },
      in_minutes: { type: "number", description: "One-off: fire this many minutes from now." },
      in_hours: { type: "number", description: "One-off: fire this many hours from now." },
      at: { type: "string", description: "One-off absolute time: ISO, 'YYYY-MM-DD HH:MM', or 'HH:MM' (next occurrence)." },
      cron: { type: "string", description: "Recurring 5-field cron, e.g. '0 9 * * 1-5' = weekdays 9am." },
      voice: { type: "boolean", description: "Deprecated/no-op. Audible speech is only available through the speak tool." },
      id: { type: "string", description: "Target id for update/cancel/enable/disable." },
    },
    required: ["action"],
  },
  summarize: (a) => {
    const action = String(a.action ?? "list");
    if (action === "add") return `${a.cron ? `cron ${a.cron}` : a.at ? `at ${a.at}` : `in ${a.in_minutes ?? a.in_hours ?? "?"}${a.in_hours ? "h" : "m"}`}`;
    return a.id ? `${action} ${a.id}` : action;
  },
  risk: () => "safe",
  async execute(args) {
    const action = String(args.action ?? "list");

    if (action === "list") {
      const list = listSchedule(true);
      return {
        content: list.length ? `Scheduled items:\n${list.map(renderItem).join("\n")}` : "No scheduled items.",
        display: `${list.filter((i) => i.enabled).length} active`,
      };
    }

    if (action === "cancel") {
      const id = String(args.id ?? "").trim();
      if (!id) return { content: "cancel needs an id.", isError: true };
      const item = getScheduleItem(id);
      if (!item || !cancelSchedule(id)) return { content: `No schedule with id ${id}.`, isError: true };
      const mirrored = await syncMirrors(item, "cancelled");
      return { content: `Cancelled schedule ${id}.${mirrored}`, display: `cancelled ${id}` };
    }

    if (action === "update") {
      const id = String(args.id ?? "").trim();
      if (!id) return { content: "update needs an id (from schedule list).", isError: true };
      if (!getScheduleItem(id)) return { content: `No schedule with id ${id}.`, isError: true };

      const patch: Parameters<typeof updateSchedule>[1] = {};
      if (typeof args.title === "string" && args.title.trim()) patch.title = args.title;
      if (typeof args.message === "string" && args.message.trim()) patch.message = args.message;
      if (typeof args.prompt === "string" && args.prompt.trim()) patch.prompt = args.prompt;
      if (args.do === "run" || args.do === "notify") patch.action = args.do;
      if (typeof args.cron === "string" && args.cron.trim()) {
        const cron = args.cron.trim();
        if (nextCronTime(cron, Date.now()) == null) {
          return { content: `Invalid cron "${cron}". Use 5 fields: minute hour day month weekday.`, isError: true };
        }
        patch.cron = cron;
      } else {
        const at = resolveOnceTime(args);
        if (at != null) {
          if (at <= Date.now()) return { content: "That time is in the past.", isError: true };
          patch.nextAt = at;
        }
      }
      if (!Object.keys(patch).length) {
        return { content: "Nothing to update — give any of title, message, prompt, do, a new time, or cron.", isError: true };
      }
      const item = updateSchedule(id, patch);
      if (!item) return { content: `Update failed for ${id}.`, isError: true };
      const mirrored = await syncMirrors(item, "updated");
      return { content: `Updated:\n${renderItem(item)}${mirrored}`, display: `updated ${id}` };
    }

    if (action === "enable" || action === "disable") {
      const id = String(args.id ?? "").trim();
      if (!id) return { content: `${action} needs an id.`, isError: true };
      const item = setScheduleEnabled(id, action === "enable");
      return item
        ? { content: `${action === "enable" ? "Enabled" : "Disabled"} ${id}.`, display: `${action}d ${id}` }
        : { content: `No schedule with id ${id}.`, isError: true };
    }

    if (action !== "add") return { content: `Unknown schedule action "${action}".`, isError: true };

    // ── add ──
    const doAction = (args.do === "run" ? "run" : "notify") as ScheduleAction;
    const title = String(args.title ?? "").trim() || (doAction === "run" ? "scheduled task" : "reminder");
    const message = typeof args.message === "string" ? args.message.trim() : "";
    const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
    const voice = false;

    if (doAction === "notify" && !message) return { content: "A 'notify' schedule needs a message.", isError: true };
    if (doAction === "run" && !prompt) return { content: "A 'run' schedule needs a prompt.", isError: true };

    if (typeof args.cron === "string" && args.cron.trim()) {
      const cron = args.cron.trim();
      if (nextCronTime(cron, Date.now()) == null) {
        return { content: `Invalid cron "${cron}". Use 5 fields: minute hour day month weekday (e.g. "0 9 * * 1-5").`, isError: true };
      }
      const item = addCron({ title, cron, action: doAction, message, prompt, voice });
      const mirrored = await syncMirrors(item, "set");
      return { content: `Recurring job set:\n${renderItem(item)}${mirrored}`, display: `cron ${item.id}` };
    }

    const at = resolveOnceTime(args);
    if (at == null) {
      return { content: "Need a time: in_minutes, in_hours, an absolute 'at', or a 'cron' expression.", isError: true };
    }
    if (at <= Date.now()) return { content: "That time is in the past.", isError: true };
    const item = addOnce({ title, at, action: doAction, message, prompt, voice });
    const mirrored = await syncMirrors(item, "set");
    return { content: `Reminder set:\n${renderItem(item)}${mirrored}`, display: `at ${fmt(at)}` };
  },
};
