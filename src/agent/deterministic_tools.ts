import type { TurnIntent } from "./intent.ts";

export interface DeterministicToolCall {
  name: string;
  arguments: Record<string, unknown>;
  raw: string;
}

const DETERMINISTIC_TOOLS = new Set(["current_time", "calc", "system_info", "where_am_i", "weather", "schedule_list", "calendar_list", "email", "apple", "write_file"]);

export function deterministicToolCallForInput(input: string, intent: TurnIntent): DeterministicToolCall | null {
  return deterministicToolCallForMissingInput(input, intent, new Set());
}

export function deterministicToolCallForMissingInput(
  input: string,
  intent: TurnIntent,
  alreadySucceeded: ReadonlySet<string>,
): DeterministicToolCall | null {
  const text = input.toLowerCase();
  const expected = intent.expectedTools?.find((tool) => DETERMINISTIC_TOOLS.has(tool) && !alreadySucceeded.has(tool) && deterministicApplicable(tool, text));
  if (!expected) return null;
  if (expected === "calc") return calcCallForInput(input);
  if (expected === "weather") return call("weather", weatherArgsForInput(input));
  if (expected === "system_info") return call("system_info", {});
  if (expected === "where_am_i") return call("where_am_i", {});
  if (expected === "current_time") return call("current_time", {});
  if (expected === "schedule_list") return call("schedule_list", {});
  if (expected === "calendar_list") return call("calendar_list", { range: /\btomorrow\b/.test(text) ? "tomorrow" : /\bweek\b/.test(text) ? "week" : "today" });
  if (expected === "email") return call("email", { action: "list_unread", limit: 20 });
  if (expected === "apple") return call("apple", { action: "messages_recent", limit: 20 });
  if (expected === "write_file") return writeFileCallForInput(input);
  if (/\b(today|time|date|day|until|now|right now)\b/.test(text)) return call("current_time", {});
  return null;
}

function deterministicApplicable(tool: string, text: string): boolean {
  if (tool === "email") return /\b(unread|inbox|mailbox|check (?:my )?(?:email|mail)|review (?:my )?(?:email|mail)|read (?:my )?(?:email|mail))\b/.test(text);
  if (tool === "apple") return /\b(recent messages?|check (?:my )?(?:messages|texts)|review (?:my )?(?:messages|texts)|read (?:my )?(?:messages|texts))\b/.test(text);
  return true;
}

function writeFileCallForInput(input: string): DeterministicToolCall | null {
  const match = /(?:create|write|make)\s+(?:a\s+)?file(?:\s+called|\s+named)?\s+[`"']?([^\s`"']+)[`"']?\s+(?:containing(?:\s+the)?\s+(?:text|content)|with(?:\s+the)?\s+(?:text|content))\s+[`"']([\s\S]*?)[`"']\.?$/i.exec(input.trim());
  if (!match) return null;
  return call("write_file", { path: match[1], content: match[2] });
}

function call(name: string, args: Record<string, unknown>): DeterministicToolCall {
  return { name, arguments: args, raw: JSON.stringify({ name, arguments: args }) };
}

function calcCallForInput(input: string): DeterministicToolCall | null {
  const text = input.toLowerCase();

  const percent = /(\d+(?:\.\d+)?)\s*%\s+of\s+(\d+(?:\.\d+)?)/i.exec(input);
  if (percent) {
    return call("calc", { expression: `${Number(percent[1]) / 100}*${percent[2]}` });
  }

  const fahrenheit = /(-?\d+(?:\.\d+)?)\s*(?:degrees?\s*)?f(?:ahrenheit)?\b/i.exec(input);
  if (fahrenheit && /\bcelsius|centigrade\b/i.test(input)) {
    return call("calc", { expression: `(${fahrenheit[1]}-32)*5/9` });
  }

  if (/\bseconds?\b.*\bweek\b/.test(text)) {
    return call("calc", { expression: "7*24*60*60" });
  }

  const compound = /(?:invest|principal|deposit)\D+(\d+(?:\.\d+)?).+?(\d+(?:\.\d+)?)\s*%.+?(\d+(?:\.\d+)?)\s*years?/i.exec(input);
  if (compound) {
    return call("calc", { expression: `${compound[1]}*(1+${Number(compound[2]) / 100})^${compound[3]}` });
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
