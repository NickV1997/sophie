import type { Tool } from "./types.ts";

/**
 * Returns the real current date/time on demand. Sophie's system prompt is only
 * stamped once per turn, so this gives her a live, precise clock — handy for
 * judging whether web results are fresh or stale, and for anything scheduled.
 */
export const currentTime: Tool = {
  name: "current_time",
  description:
    "Get the current date and time (local and UTC, with timezone and weekday). " +
    "Call this before reasoning about how recent or stale information is, or " +
    "whenever the user asks about the date, time, or 'now'.",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
  summarize: () => "now",
  risk: () => "safe",
  async execute() {
    const now = new Date();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "local";
    const local = now.toLocaleString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "short",
    });
    const lines = [
      `Local:   ${local} (${tz})`,
      `UTC:     ${now.toUTCString()}`,
      `ISO8601: ${now.toISOString()}`,
      `Unix:    ${Math.floor(now.getTime() / 1000)}`,
    ];
    return { content: lines.join("\n"), display: now.toISOString().slice(0, 16).replace("T", " ") };
  },
};
