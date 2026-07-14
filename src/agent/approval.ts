import { createHash } from "node:crypto";

const SECRET_KEY = /authorization|cookie|password|passwd|secret|token|api[-_]?key|private[-_]?key/i;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
}

function displayValue(value: unknown, key = "", depth = 0): unknown {
  if (SECRET_KEY.test(key)) return "[REDACTED — secret field]";
  if (depth > 6) return "[nested value omitted]";
  if (Array.isArray(value)) return value.map((item) => displayValue(item, key, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [childKey, displayValue(child, childKey, depth + 1)]));
}

export function approvalArgumentHash(args: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(canonical(args))).digest("hex");
}

export function approvalDetails(args: Record<string, unknown>, maxChars = 8_000): string {
  const hash = approvalArgumentHash(args);
  const rendered = JSON.stringify(displayValue(args), null, 2);
  const clipped = rendered.length > maxChars ? `${rendered.slice(0, maxChars)}\n… (${rendered.length - maxChars} characters omitted)` : rendered;
  return `Exact call arguments (secret fields redacted):\n${clipped}\nArguments SHA-256: ${hash}`;
}
