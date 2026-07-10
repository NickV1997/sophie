/**
 * Scheduler — reminders, alarms, and recurring cron jobs.
 *
 * Two kinds of schedule item:
 *   - "once": fire a single time at a wall-clock moment (an alarm / reminder).
 *   - "cron": fire repeatedly on a 5-field cron expression (min hour dom mon dow).
 *
 * Two actions when an item fires:
 *   - "notify": just push a message to the user (via the notifier).
 *   - "run":    wake Sophie with a prompt so she does something at that time
 *               (e.g. "check if the build finished and message me the result").
 *
 * Items are persisted to ~/.sophie/schedule.json so they survive restarts. A tick
 * loop fires anything due and hands it to the caller-supplied onFire callback,
 * which the TUI turns into a notification or an autonomous turn.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MEMORY_DIR } from "../memory/store.ts";

export type ScheduleKind = "once" | "cron";
export type ScheduleAction = "notify" | "run";

export interface ScheduleItem {
  id: string;
  kind: ScheduleKind;
  action: ScheduleAction;
  title: string;
  /** For action "notify": the message to send. */
  message?: string;
  /** For action "run": the instruction Sophie should carry out when it fires. */
  prompt?: string;
  /** Cron expression for kind "cron". */
  cron?: string;
  /** Next fire time (epoch ms). */
  nextAt: number;
  createdAt: number;
  lastRunAt?: number;
  enabled: boolean;
  /** Also speak the message aloud when it fires. */
  voice?: boolean;
  /** External copies kept in sync (e.g. the macOS Reminders app). */
  mirror?: { appleId?: string };
}

export const SCHEDULE_PATH = join(MEMORY_DIR, "schedule.json");

let items: ScheduleItem[] | null = null;

function ensureDir(): void {
  if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true });
}

function load(): ScheduleItem[] {
  if (items) return items;
  if (!existsSync(SCHEDULE_PATH)) return (items = []);
  try {
    const parsed = JSON.parse(readFileSync(SCHEDULE_PATH, "utf8"));
    const list: unknown[] = Array.isArray(parsed?.items) ? parsed.items : Array.isArray(parsed) ? parsed : [];
    items = list.filter((x): x is ScheduleItem => !!x && typeof (x as any).id === "string");
  } catch {
    items = [];
  }
  return items;
}

function persist(): void {
  ensureDir();
  writeFileSync(SCHEDULE_PATH, `${JSON.stringify({ items: items ?? [] }, null, 2)}\n`);
}

function newId(): string {
  return `sch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function listSchedule(includeDisabled = false): ScheduleItem[] {
  return load()
    .filter((i) => includeDisabled || i.enabled)
    .sort((a, b) => a.nextAt - b.nextAt);
}

export function getScheduleItem(id: string): ScheduleItem | undefined {
  return load().find((i) => i.id === id);
}

/** Schedule a one-off reminder/alarm/task at an absolute epoch-ms time. */
export function addOnce(input: {
  title: string;
  at: number;
  action: ScheduleAction;
  message?: string;
  prompt?: string;
  voice?: boolean;
}): ScheduleItem {
  const list = load();
  const item: ScheduleItem = {
    id: newId(),
    kind: "once",
    action: input.action,
    title: input.title.trim(),
    message: input.message?.trim(),
    prompt: input.prompt?.trim(),
    nextAt: input.at,
    createdAt: Date.now(),
    enabled: true,
    voice: input.voice,
  };
  list.push(item);
  persist();
  return item;
}

/** Schedule a recurring job on a cron expression. */
export function addCron(input: {
  title: string;
  cron: string;
  action: ScheduleAction;
  message?: string;
  prompt?: string;
  voice?: boolean;
}): ScheduleItem {
  const next = nextCronTime(input.cron, Date.now());
  if (next == null) throw new Error(`invalid cron expression: "${input.cron}"`);
  const list = load();
  const item: ScheduleItem = {
    id: newId(),
    kind: "cron",
    action: input.action,
    title: input.title.trim(),
    message: input.message?.trim(),
    prompt: input.prompt?.trim(),
    cron: input.cron.trim(),
    nextAt: next,
    createdAt: Date.now(),
    enabled: true,
    voice: input.voice,
  };
  list.push(item);
  persist();
  return item;
}

/**
 * Update an existing item in place. A new time (nextAt or cron) re-enables a
 * fired one-off; giving `cron` converts the item to recurring, giving `nextAt`
 * (without cron) converts it to a one-off. Returns the updated item, or
 * undefined for an unknown id / invalid cron.
 */
export function updateSchedule(
  id: string,
  patch: {
    title?: string;
    message?: string;
    prompt?: string;
    action?: ScheduleAction;
    nextAt?: number;
    cron?: string;
  },
): ScheduleItem | undefined {
  const item = getScheduleItem(id);
  if (!item) return undefined;
  if (patch.cron !== undefined) {
    const next = nextCronTime(patch.cron, Date.now());
    if (next == null) return undefined;
    item.kind = "cron";
    item.cron = patch.cron.trim();
    item.nextAt = next;
    item.enabled = true;
  } else if (patch.nextAt !== undefined) {
    item.kind = "once";
    delete item.cron;
    item.nextAt = patch.nextAt;
    item.enabled = true;
  }
  if (patch.title !== undefined) item.title = patch.title.trim();
  if (patch.message !== undefined) item.message = patch.message.trim();
  if (patch.prompt !== undefined) item.prompt = patch.prompt.trim();
  if (patch.action !== undefined) item.action = patch.action;
  persist();
  return item;
}

/** Attach/replace external mirror info (e.g. the Apple Reminders id). */
export function setScheduleMirror(id: string, mirror: ScheduleItem["mirror"]): void {
  const item = getScheduleItem(id);
  if (!item) return;
  item.mirror = mirror;
  persist();
}

export function cancelSchedule(id: string): boolean {
  const list = load();
  const i = list.findIndex((x) => x.id === id);
  if (i === -1) return false;
  list.splice(i, 1);
  persist();
  return true;
}

export function setScheduleEnabled(id: string, enabled: boolean): ScheduleItem | undefined {
  const item = getScheduleItem(id);
  if (!item) return undefined;
  item.enabled = enabled;
  persist();
  return item;
}

/**
 * Start the tick loop. Every `tickMs` any enabled item whose time has arrived is
 * fired via onFire; a cron item is then rescheduled to its next time, and a
 * one-off is disabled (kept for history but won't fire again). onFire may be
 * async; failures are swallowed so one bad item can't stop the clock.
 */
export function startScheduler(onFire: (item: ScheduleItem) => void | Promise<void>, tickMs = 20_000): () => void {
  const tick = () => {
    const now = Date.now();
    for (const item of load()) {
      if (!item.enabled || item.nextAt > now) continue;
      item.lastRunAt = now;
      if (item.kind === "cron" && item.cron) {
        const next = nextCronTime(item.cron, now + 1000);
        if (next != null) item.nextAt = next;
        else item.enabled = false;
      } else {
        item.enabled = false; // one-off: fired, done
      }
      persist();
      try {
        void onFire(item);
      } catch {
        /* keep ticking */
      }
    }
  };
  const timer = setInterval(tick, tickMs);
  (timer as any).unref?.();
  tick(); // catch anything already overdue at startup (e.g. after a restart)
  return () => clearInterval(timer);
}

// ── cron parsing (5 fields: minute hour day-of-month month day-of-week) ───────

interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

function parseField(field: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    let range = part;
    let step = 1;
    const slash = part.indexOf("/");
    if (slash !== -1) {
      range = part.slice(0, slash);
      step = Number(part.slice(slash + 1));
      if (!Number.isInteger(step) || step <= 0) return null;
    }
    let lo = min;
    let hi = max;
    if (range !== "*" && range !== "") {
      const dash = range.indexOf("-");
      if (dash !== -1) {
        lo = Number(range.slice(0, dash));
        hi = Number(range.slice(dash + 1));
      } else {
        lo = hi = Number(range);
      }
      if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) return null;
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out.size ? out : null;
}

/** Parse a 5-field cron expression, or null if malformed. */
export function parseCron(expr: string): CronFields | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const minute = parseField(parts[0], 0, 59);
  const hour = parseField(parts[1], 0, 23);
  const dom = parseField(parts[2], 1, 31);
  const month = parseField(parts[3], 1, 12);
  const dow = parseField(parts[4].replace(/7/g, "0"), 0, 6);
  if (!minute || !hour || !dom || !month || !dow) return null;
  return {
    minute,
    hour,
    dom,
    month,
    dow,
    domRestricted: parts[2] !== "*",
    dowRestricted: parts[4] !== "*",
  };
}

/**
 * Next time (epoch ms) at/after `from` that the cron expression matches, or null
 * for a bad expression. Standard cron semantics: when both day-of-month and
 * day-of-week are restricted, either matching is enough. Searches up to ~2 years.
 */
export function nextCronTime(expr: string, from: number): number | null {
  const f = parseCron(expr);
  if (!f) return null;
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1); // strictly after `from`
  const limit = 366 * 2 * 24 * 60; // minutes in ~2 years
  for (let i = 0; i < limit; i++) {
    if (
      f.minute.has(d.getMinutes()) &&
      f.hour.has(d.getHours()) &&
      f.month.has(d.getMonth() + 1) &&
      dayMatches(f, d)
    ) {
      return d.getTime();
    }
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

function dayMatches(f: CronFields, d: Date): boolean {
  const domOk = f.dom.has(d.getDate());
  const dowOk = f.dow.has(d.getDay());
  if (f.domRestricted && f.dowRestricted) return domOk || dowOk;
  if (f.domRestricted) return domOk;
  if (f.dowRestricted) return dowOk;
  return true;
}
