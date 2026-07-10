import type { TurnIntent } from "./intent.ts";

export interface DeterministicToolCall {
  name: string;
  arguments: Record<string, unknown>;
  raw: string;
}

const DETERMINISTIC_TOOLS = new Set(["current_time", "calc", "system_info", "where_am_i", "weather"]);

export function deterministicToolCallForInput(input: string, intent: TurnIntent): DeterministicToolCall | null {
  return deterministicToolCallForMissingInput(input, intent, new Set());
}

export function deterministicToolCallForMissingInput(
  input: string,
  intent: TurnIntent,
  alreadySucceeded: ReadonlySet<string>,
): DeterministicToolCall | null {
  const expected = intent.expectedTools?.find((tool) => DETERMINISTIC_TOOLS.has(tool) && !alreadySucceeded.has(tool));
  if (!expected) return null;
  const text = input.toLowerCase();
  if (expected === "calc") return calcCallForInput(input);
  if (expected === "weather") return call("weather", weatherArgsForInput(input));
  if (expected === "system_info") return call("system_info", {});
  if (expected === "where_am_i") return call("where_am_i", {});
  if (expected === "current_time") return call("current_time", {});
  if (/\b(today|time|date|day|until|now|right now)\b/.test(text)) return call("current_time", {});
  return null;
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
