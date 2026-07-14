import { config, getContextWindow } from "../config.ts";
import type { ChatContent, ChatMessage } from "../llm/client.ts";

/**
 * Fraction of the true window we allow ourselves to fill. Our token count is a
 * cheap ~4-chars/token estimate that under-counts dense JSON/code, so we keep an
 * ~8% buffer below the server's real n_ctx to absorb that error and avoid
 * "exceeded context" errors.
 */
const WINDOW_SAFETY = 0.92;

/** Sophie deliberately does not use a local server's entire context window.
 * Quality falls before the transport limit on current 9B–122B local models;
 * 28k leaves room below the observed ~32k degradation point. */
export const MAX_WORKING_CONTEXT_TOKENS = 28_000;

/**
 * Context-window accounting for long runs. A small model with a fixed window
 * (e.g. 32k) cannot run for hours unless we (a) cap how much any single tool
 * output adds to history and (b) compact old history once we approach the
 * budget. Without this the history overflows and the server silently drops the
 * front — taking the system prompt and task list with it, so Sophie "forgets".
 */

/**
 * Token estimate from character count. We deliberately use a conservative
 * ratio (3.5 chars/token, not the ~4 English average) because the agent's
 * content is dense JSON tool calls, code, and command output that tokenize
 * closer to ~3 chars/token. Over-counting slightly is safe — it triggers
 * compaction and clamps replies a little early rather than overflowing.
 */
const CHARS_PER_TOKEN = 3.5;

export function estimateTokens(content: ChatContent): number {
  if (typeof content === "string") return Math.ceil(content.length / CHARS_PER_TOKEN);
  let n = 0;
  for (const part of content) {
    if (part.type === "text") n += Math.ceil(part.text.length / CHARS_PER_TOKEN);
    else n += 800; // images carry a flat, conservative budget
  }
  return n;
}

export function messagesTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const m of messages) total += estimateTokens(m.content) + 4; // +role overhead
  return total;
}

/**
 * Truncate a large tool output before it is *stored in history*. The full
 * output is still shown to the user in the TUI; only the persisted copy is
 * clipped. `favor` picks which end carries the signal: "head" for reads and
 * listings (the answer is usually at the top), "tail" for command/build/test
 * output (the error and verdict are usually at the bottom).
 */
export function clipForHistory(content: string, maxChars = 4000, favor: "head" | "tail" = "head"): string {
  if (content.length <= maxChars) return content;
  const headShare = favor === "head" ? 0.75 : 0.15;
  const tailShare = favor === "head" ? 0.15 : 0.75;
  const head = content.slice(0, Math.floor(maxChars * headShare));
  const tail = content.slice(content.length - Math.floor(maxChars * tailShare));
  const dropped = content.length - head.length - tail.length;
  return `${head}\n…[${dropped} characters truncated to conserve context; re-read a specific range if you need more]…\n${tail}`;
}

/** Usable window after the safety buffer — the real ceiling for any one request. */
export function usableContextWindow(): number {
  return Math.min(MAX_WORKING_CONTEXT_TOKENS, Math.floor(getContextWindow() * WINDOW_SAFETY));
}

/** Preferred prompt ceiling for one model tier, always leaving synthesis room. */
export function promptTokenBudget(recommendedPromptTokens: number, completionReserve = 512): number {
  return Math.max(2_000, Math.min(recommendedPromptTokens, usableContextWindow() - completionReserve));
}

/** Tokens reserved for the model's reply. Scaled so it never dominates a small
 *  window (e.g. an 8k server shouldn't reserve the full maxTokens for output). */
export function replyReserve(): number {
  return Math.max(512, Math.min(config.maxTokens, Math.floor(getContextWindow() * 0.25)));
}

/** Tokens of history we can afford, given the fixed system-prompt cost. */
export function historyBudget(systemTokens: number, modelHistoryCap = config.maxHistoryTokens): number {
  const windowBudget = Math.max(2000, usableContextWindow() - systemTokens - replyReserve());
  // A large context window (e.g. 200k) does NOT mean a small model stays
  // coherent using all of it — long uncompacted history makes it slower and
  // dumber. Cap the working history to a size it reasons well over, so
  // compaction always fires on long chats no matter how big the raw window is.
  return Math.min(windowBudget, Math.max(4000, Math.min(config.maxHistoryTokens, modelHistoryCap)));
}

/**
 * Completion-token cap for one request: never ask for more than the room left
 * in the usable window after the prompt. Guarantees prompt + reply ≤ window, so
 * the server can't reject the request for exceeding context.
 */
export function safeMaxTokens(promptTokens: number): number {
  return Math.max(256, Math.min(config.maxTokens, usableContextWindow() - promptTokens));
}

export interface FittedPrompt {
  messages: ChatMessage[];
  droppedHistoryMessages: number;
}

/** Last-mile prompt fitting. Preserve the base system prompt, the current user
 * request, every tool result from this turn, and the trailing live-state block.
 * Older verbatim chat is optional because compaction/memory/task state already
 * carries its useful facts. */
export function fitPromptMessages(
  system: ChatMessage,
  history: ChatMessage[],
  liveState: ChatMessage,
  maxPromptTokens: number,
  preserveFromIndex?: number,
): FittedPrompt {
  const currentUser = preserveFromIndex !== undefined && preserveFromIndex >= 0
    ? preserveFromIndex
    : history.findLastIndex((message) => message.role === "user");
  const required = currentUser >= 0 ? history.slice(currentUser) : [];
  const older = currentUser >= 0 ? history.slice(0, currentUser) : history;
  const keptOlder: ChatMessage[] = [];
  let messages = [system, ...required, liveState];
  for (let index = older.length - 1; index >= 0; index--) {
    const candidate = [system, older[index]!, ...keptOlder, ...required, liveState];
    if (messagesTokens(candidate) > maxPromptTokens) break;
    keptOlder.unshift(older[index]!);
    messages = candidate;
  }
  return { messages, droppedHistoryMessages: older.length - keptOlder.length };
}

/** Strip a model's <think> trace from a one-shot result (e.g. a summary). */
export function stripThink(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}
