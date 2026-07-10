import { calendar } from "./calendar.ts";
import type { Tool } from "./types.ts";

const WINDOW_FIELDS = {
  range: { type: "string", description: "Window: 'today', 'tomorrow', 'week', or a date 'YYYY-MM-DD'." },
  from: { type: "string", description: "Window start (alternative to range)." },
  to: { type: "string", description: "Window end." },
};

export const calendarList: Tool = {
  name: "calendar_list",
  description:
    "Read-only calendar query: list events in a time window. Use this in plan mode or when you only need to inspect the calendar.",
  parameters: {
    type: "object",
    properties: {
      ...WINDOW_FIELDS,
      include_cancelled: { type: "boolean", description: "Also show cancelled events." },
    },
  },
  summarize: (a) => `calendar list ${a.range ?? a.from ?? "week"}`,
  risk: () => "safe",
  async execute(args, ctx) {
    return calendar.execute({ ...args, action: "list" }, ctx);
  },
};

export const calendarSearch: Tool = {
  name: "calendar_search",
  description:
    "Read-only calendar query: search event titles, locations, notes, attendees, and ids.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Text to search for." },
    },
    required: ["query"],
  },
  summarize: (a) => `calendar search ${String(a.query ?? "").slice(0, 40)}`,
  risk: () => "safe",
  async execute(args, ctx) {
    return calendar.execute({ ...args, action: "search" }, ctx);
  },
};

export const calendarFindFree: Tool = {
  name: "calendar_find_free",
  description:
    "Read-only calendar query: find open time slots for a duration within working hours. Use before booking meetings.",
  parameters: {
    type: "object",
    properties: {
      ...WINDOW_FIELDS,
      duration_minutes: { type: "number", description: "Minimum slot length in minutes (default 30)." },
      day_start_hour: { type: "number", description: "Earliest hour to offer (default 9)." },
      day_end_hour: { type: "number", description: "Latest hour to offer (default 18)." },
    },
  },
  summarize: (a) => `calendar free ${a.duration_minutes ?? 30}m ${a.range ?? ""}`.trim(),
  risk: () => "safe",
  async execute(args, ctx) {
    return calendar.execute({ ...args, action: "find_free" }, ctx);
  },
};

