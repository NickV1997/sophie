import { searchVerifiedEpisodes } from "../agent/episodes.ts";
import type { Tool } from "./types.ts";

export const searchVerifiedMemory: Tool = {
  name: "search_verified_memory",
  description:
    "Search prior job episodes for verified evidence only. Use when previous verified project facts or checks may help the current task without loading whole transcripts.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Keywords for the project, task, command, or verification evidence." },
      limit: { type: "number", description: "Maximum results, default 5." },
    },
    required: ["query"],
  },
  summarize: (a) => `verified memory ${a.query}`,
  risk: () => "safe",
  async execute(args) {
    const results = searchVerifiedEpisodes(String(args.query ?? ""), Number(args.limit ?? 5));
    return {
      content: results.length ? results.join("\n\n") : "No matching verified episode evidence found.",
      display: `${results.length} verified`,
    };
  },
};
