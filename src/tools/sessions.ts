import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getCurrentSessionId } from "../agent/session.ts";
import { displayPath } from "../system/paths.ts";
import type { Tool } from "./types.ts";

const DIR = join(homedir(), ".sophie", "sessions");

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function compact(text: string, query: string, max = 700): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const idx = query ? flat.toLowerCase().indexOf(query.toLowerCase()) : -1;
  if (idx === -1) return flat.slice(0, max);
  const start = Math.max(0, idx - Math.floor(max / 3));
  return `${start > 0 ? "..." : ""}${flat.slice(start, start + max)}${start + max < flat.length ? "..." : ""}`;
}

export const searchSessions: Tool = {
  name: "search_sessions",
  description:
    "Search Sophie's saved past sessions by keyword. Use this when the user asks " +
    "about a previous/latest/last session, recurring failures, or what Sophie did before.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Keyword or phrase to search for. Empty lists recent sessions." },
      limit: { type: "number", description: "Maximum matches to return. Default 5, max 20." },
    },
    required: ["query"],
  },
  summarize: (a) => `search sessions ${a.query ?? ""}`.trim(),
  risk: () => "safe",
  async execute(args) {
    if (!existsSync(DIR)) return { content: "No saved Sophie sessions found.", display: "0 sessions" };
    const query = String(args.query ?? "").trim();
    const limit = Math.min(Math.max(Number(args.limit ?? 5) || 5, 1), 20);
    const currentId = getCurrentSessionId();
    const files = readdirSync(DIR)
      .filter((f) => f.endsWith(".json"))
      .filter((f) => !currentId || !f.startsWith(currentId))
      .map((f) => join(DIR, f))
      .sort((a, b) => {
        try {
          return JSON.parse(readFileSync(b, "utf8")).updatedAt - JSON.parse(readFileSync(a, "utf8")).updatedAt;
        } catch {
          return 0;
        }
      });

    const hits: string[] = [];
    for (const file of files) {
      if (hits.length >= limit) break;
      try {
        const s = JSON.parse(readFileSync(file, "utf8"));
        const body = [
          s.title,
          s.cwd,
          ...(Array.isArray(s.history) ? s.history.map((m: any) => textOf(m.content)) : []),
          ...(Array.isArray(s.journal) ? s.journal.map(textOf) : []),
          ...(Array.isArray(s.blocks) ? s.blocks.map(textOf) : []),
        ].join("\n");
        if (query && !body.toLowerCase().includes(query.toLowerCase())) continue;
        const updated = s.updatedAt ? new Date(s.updatedAt).toLocaleString() : "unknown time";
        hits.push(
          `- ${s.id ?? file.split("/").pop()} | ${updated} | ${s.title ?? "Untitled"}\n  cwd: ${
            s.cwd ? displayPath(s.cwd) : "unknown"
          }\n  excerpt: ${compact(body, query)}`,
        );
      } catch {
        /* skip corrupt sessions */
      }
    }

    return {
      content: hits.length ? hits.join("\n\n") : `No sessions matched "${query}".`,
      display: `${hits.length} match${hits.length === 1 ? "" : "es"}`,
    };
  },
};
