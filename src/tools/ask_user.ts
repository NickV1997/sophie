import type { Tool } from "./types.ts";

/**
 * Ask the user 1–4 focused clarifying questions and wait for their reply. Used
 * mainly in build planning to pin down the MVP (stack, key features, scope)
 * before committing to a phased plan. The result ends the turn; the user's next
 * message is treated as the answers.
 */
export const askUser: Tool = {
  name: "ask_user",
  description:
    "Ask the user a small batch of focused questions and end the turn to wait for their answer. " +
    "Use only when the answer changes the action or approval. Ask 1-4 sharp questions at once; don't ask " +
    "what you can infer. Because this tool's result is the final user-facing response, put any requested " +
    "evidence-based comparison, conflict, or recommendation in the preamble before the questions.",
  parameters: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        description: "1-4 concise clarifying questions.",
        items: { type: "string" },
      },
      preamble: {
        type: "string",
        description: "Concise context shown before the questions. Include the relevant evidence and recommendation when the user asked for them.",
      },
    },
    required: ["questions"],
  },
  summarize: (a) => {
    const n = Array.isArray(a.questions) ? a.questions.length : 0;
    return `ask user ${n} question${n === 1 ? "" : "s"}`;
  },
  risk: () => "safe",
  async execute(args) {
    const questions = Array.isArray(args.questions)
      ? args.questions.map((q) => String(q).trim()).filter(Boolean).slice(0, 4)
      : [];
    if (!questions.length) {
      return { content: "ask_user needs at least one question.", isError: true };
    }
    const preamble = typeof args.preamble === "string" && args.preamble.trim() ? `${args.preamble.trim()}\n\n` : "";
    const body = questions.map((q, i) => `${i + 1}. ${q}`).join("\n");
    return {
      content: `${preamble}${body}`,
      display: `asked ${questions.length} question${questions.length === 1 ? "" : "s"}`,
      endTurn: true,
    };
  },
};
