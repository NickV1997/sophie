import type { TurnIntent } from "./intent.ts";

export interface DeterministicToolCall {
  name: string;
  arguments: Record<string, unknown>;
  raw: string;
}

/**
 * Deterministic EXECUTION of routing the intent model already decided.
 * Nothing here chooses whether a tool is relevant — that judgment lives in
 * intent classification. This module only builds safe default arguments for
 * an expected read-type tool (plus exact argument parsing for lossless
 * operations like calc and write_file) so obvious source reads don't each
 * cost a full model generation.
 */
const DETERMINISTIC_TOOLS = new Set(["current_time", "calc", "system_info", "where_am_i", "weather", "schedule_list", "calendar_list", "email", "apple", "activity", "recall", "manage_tasks", "projects", "people", "delegate", "write_file"]);

export function deterministicToolCallForInput(input: string, intent: TurnIntent): DeterministicToolCall | null {
  return deterministicToolCallForMissingInput(input, intent, new Set());
}

/** All independently useful deterministic calls still missing for this turn.
 * The agent can execute these before asking the model, avoiding one expensive
 * generation per inbox/calendar/weather source. */
export function deterministicToolCallsForMissingInput(
  input: string,
  intent: TurnIntent,
  alreadySucceeded: ReadonlySet<string>,
): DeterministicToolCall[] {
  const pending = new Set(alreadySucceeded);
  const calls: DeterministicToolCall[] = [];
  while (calls.length < DETERMINISTIC_TOOLS.size) {
    const next = deterministicToolCallForMissingInput(input, intent, pending);
    if (!next || calls.some((item) => item.raw === next.raw)) break;
    calls.push(next);
    pending.add(next.name);
    const action = String(next.arguments.action ?? "").trim();
    if (action) pending.add(`${next.name}:${action}`);
  }
  return calls;
}

export function deterministicToolCallForMissingInput(
  input: string,
  intent: TurnIntent,
  alreadySucceeded: ReadonlySet<string>,
): DeterministicToolCall | null {
  const text = input.toLowerCase();
  const expected = intent.expectedTools?.find((tool) =>
    DETERMINISTIC_TOOLS.has(tool) && deterministicReadStillNeeded(tool, intent, alreadySucceeded)
  );
  if (!expected) return null;
  if (expected === "calc") return calcCallForInput(input);
  if (expected === "weather") return call("weather", weatherArgsForInput(input));
  if (expected === "system_info") return call("system_info", {});
  if (expected === "where_am_i") return call("where_am_i", {});
  if (expected === "current_time") return call("current_time", {});
  if (expected === "schedule_list") return call("schedule_list", {});
  if (expected === "calendar_list") {
    const namedWeekday = /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(text);
    return call("calendar_list", { range: /\btomorrow\b/.test(text) ? "tomorrow" : /\bweek\b/.test(text) || namedWeekday ? "week" : "today" });
  }
  if (expected === "email") {
    const requiredReads = ["email:list_unread", "email:draft_list"]
      .filter((prefix) => intent.requiredOutcomes?.some((outcome) => outcome.prefix === prefix));
    const missing = requiredReads.find((prefix) => !alreadySucceeded.has(prefix));
    if (missing === "email:draft_list") return call("email", { action: "draft_list" });
    return call("email", { action: "list_unread", limit: 20 });
  }
  if (expected === "apple") return call("apple", { action: "messages_recent", limit: 20 });
  if (expected === "activity") return call("activity", { limit: 50, status: "all" });
  if (expected === "recall") return call("recall", { query: input.slice(-800), limit: 8 });
  if (expected === "manage_tasks") return call("manage_tasks", { action: "list", status: "all", limit: 50 });
  if (expected === "projects") return call("projects", { action: "list", status: "all" });
  if (expected === "people") return call("people", { action: "list" });
  if (expected === "delegate") return call("delegate", { action: "list" });
  if (expected === "write_file") return writeFileCallForInput(input);
  return null;
}

function deterministicReadStillNeeded(tool: string, intent: TurnIntent, alreadySucceeded: ReadonlySet<string>): boolean {
  if (tool !== "email") return !alreadySucceeded.has(tool);
  const requiredReads = ["email:list_unread", "email:draft_list"]
    .filter((prefix) => intent.requiredOutcomes?.some((outcome) => outcome.prefix === prefix));
  return requiredReads.length
    ? requiredReads.some((prefix) => !alreadySucceeded.has(prefix))
    : !alreadySucceeded.has(tool);
}

function writeFileCallForInput(input: string): DeterministicToolCall | null {
  const match = /(?:create|write|make)\s+(?:a\s+)?file(?:\s+called|\s+named)?\s+[`"']?([^\s`"']+)[`"']?\s+(?:containing(?:\s+the)?\s+(?:text|content)|with(?:\s+the)?\s+(?:text|content))\s+[`"']([\s\S]*?)[`"']\.?$/i.exec(input.trim());
  if (!match) return null;
  return call("write_file", { path: match[1], content: match[2] });
}

function call(name: string, args: Record<string, unknown>): DeterministicToolCall {
  return { name, arguments: args, raw: JSON.stringify({ name, arguments: args }) };
}

/** Exact argument extraction for common math idioms; anything less explicit
 *  returns null and the model writes the expression itself. */
function calcCallForInput(input: string): DeterministicToolCall | null {
  const percent = /(\d+(?:\.\d+)?)\s*%\s+of\s+(\d+(?:\.\d+)?)/i.exec(input);
  if (percent) {
    return call("calc", { expression: `${Number(percent[1]) / 100}*${percent[2]}` });
  }

  const fahrenheit = /(-?\d+(?:\.\d+)?)\s*(?:degrees?\s*)?f(?:ahrenheit)?\b/i.exec(input);
  if (fahrenheit && /\bcelsius|centigrade\b/i.test(input)) {
    return call("calc", { expression: `(${fahrenheit[1]}-32)*5/9` });
  }

  if (/\bstandard deviation|stddev|stdev\b/i.test(input)) {
    const nums = input.match(/-?\d+(?:\.\d+)?/g);
    if (nums?.length) return call("calc", { expression: `stddev(${nums.join(",")})` });
  }

  const sqrt = /\bsquare root of\s+(-?\d+(?:\.\d+)?)/i.exec(input);
  if (sqrt) return call("calc", { expression: `sqrt(${sqrt[1]})` });

  const expression = input.match(/[-+*/^().\d\s]{3,}/)?.[0]?.trim();
  if (expression && /\d/.test(expression) && /[-+*/^]/.test(expression)) {
    return call("calc", { expression });
  }

  return null;
}

function weatherArgsForInput(input: string): Record<string, unknown> {
  const location =
    /\b(?:in|for|at)\s+([A-Z][A-Za-z .'-]+(?:,\s*[A-Z][A-Za-z .'-]+)?)/.exec(input)?.[1]?.trim()
      .replace(/\b(tomorrow|today|tonight|this week)\b.*$/i, "")
      .trim();
  return location ? { location } : {};
}
