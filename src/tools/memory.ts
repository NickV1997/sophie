import { listMemories, type MemoryScope, type MemoryType } from "../memory/facts.ts";
import { saveExplicitMemory } from "../memory/engine.ts";
import { smartRecall } from "../memory/embeddings.ts";
import type { Tool } from "./types.ts";

/**
 * Save a durable fact to Sophie's structured memory. Facts are NOT reloaded
 * wholesale each session — they are retrieved by keyword only when relevant, so
 * the model's context stays lean. Near-duplicates are merged, not appended.
 */
export const remember: Tool = {
  name: "remember",
  description:
    "Save a durable fact to long-term memory, retrieved later only when relevant to the message. " +
    "Use for the user's name, preferences, recurring context, project conventions, decisions. " +
    "Don't save trivia or one-off conversation details. scope 'user' (default) = facts about the " +
    "user; 'project' = facts about the current folder. type: 'preference' | 'convention' | 'fact'.",
  parameters: {
    type: "object",
    properties: {
      fact: { type: "string", description: "The fact to remember, as one clear sentence." },
      content: { type: "string", description: "Alias for fact; accepted for recovery from small-model argument slips." },
      text: { type: "string", description: "Alias for fact; accepted for recovery from small-model argument slips." },
      scope: {
        type: "string",
        enum: ["user", "project"],
        description: "Where to save it (default 'user').",
      },
      type: {
        type: "string",
        enum: ["fact", "preference", "convention"],
        description: "Kind of memory (default 'fact').",
      },
    },
    required: [],
  },
  summarize: (a) => `"${String(a.fact ?? "").slice(0, 48)}"`,
  risk: () => "safe",
  async execute(args, ctx) {
    const fact = String(args.fact ?? args.content ?? args.text ?? "").trim();
    if (!fact) return { content: "Nothing to remember (empty fact).", isError: true };
    const scope: MemoryScope = args.scope === "project" ? "project" : "user";
    const type: MemoryType = args.type === "preference" || args.type === "convention" ? args.type : "fact";
    const { action } = saveExplicitMemory(fact, ctx.cwd, { scope, type });
    return {
      content: action === "merged" ? `Updated an existing ${scope} memory.` : `Saved to ${scope} memory.`,
      display: `${scope} memory`,
    };
  },
};

/**
 * Explicit keyword search of long-term memory — for when Sophie wants to dig
 * deeper mid-task than the automatic per-turn recall surfaced.
 */
export const recall: Tool = {
  name: "recall",
  description:
    "Search your long-term memory and get back matching saved facts, preferences, and conventions. " +
    "Semantic when an embeddings endpoint is available (finds 'the Italian place' for 'that restaurant'), " +
    "keyword otherwise. The most relevant memories for the user's message are already surfaced automatically; " +
    "use this to look for something specific that wasn't (e.g. 'how do I usually deploy', 'the user's city').",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Keywords describing what to recall." },
      limit: { type: "number", description: "Maximum results, default 6." },
    },
    required: ["query"],
  },
  summarize: (a) => `recall ${String(a.query ?? "")}`,
  risk: () => "safe",
  async execute(args, ctx) {
    const query = String(args.query ?? "").trim();
    if (!query) return { content: "Provide a query to recall.", isError: true };
    const hits = await smartRecall(query, ctx.cwd, Number(args.limit ?? 6));
    if (!hits.length) {
      // Fall back to reporting the store size so the model knows it's empty vs. no match.
      const total = listMemories("user", ctx.cwd).length + listMemories("project", ctx.cwd).length;
      return {
        content: total
          ? `No memories matched "${query}" (${total} stored).`
          : "No memories stored yet.",
        display: "0 recalled",
      };
    }
    return {
      content: hits.map((h) => `- ${h.text}`).join("\n"),
      display: `${hits.length} recalled`,
    };
  },
};
