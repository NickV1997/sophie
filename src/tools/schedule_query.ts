import { schedule } from "./schedule.ts";
import type { Tool } from "./types.ts";

export const scheduleList: Tool = {
  name: "schedule_list",
  description:
    "Read-only schedule query: list reminders, alarms, and recurring jobs without changing them.",
  parameters: {
    type: "object",
    properties: {},
  },
  summarize: () => "schedule list",
  risk: () => "safe",
  async execute(args, ctx) {
    return schedule.execute({ ...args, action: "list" }, ctx);
  },
};

