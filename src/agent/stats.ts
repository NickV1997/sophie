/**
 * Live turn statistics for the TUI's status line: how full the context window
 * is (so the user can see compaction coming instead of wondering why Sophie
 * "forgot") and the effective generation speed of the local model.
 * Mirrors the mode/tasks observable-store pattern — no React imports here.
 */
import { usableContextWindow } from "./context.ts";

export interface TurnStats {
  /** Estimated prompt tokens of the most recent model request. */
  promptTokens: number;
  /** The usable window those tokens count against. */
  ctxWindow: number;
  /** Characters streamed by the model this turn (thinking + content). */
  genChars: number;
  /** Milliseconds spent streaming this turn (generation only, not tools). */
  genMs: number;
  /** Model requests made this turn, including tool-followup rounds. */
  modelRequests?: number;
  /** Time to first streamed token for the latest successful request. */
  firstTokenMs?: number;
  /** True while a turn is running. */
  busy: boolean;
}

/** Matches context.ts's CHARS_PER_TOKEN estimate. */
const CHARS_PER_TOKEN = 3.5;

let stats: TurnStats = { promptTokens: 0, ctxWindow: usableContextWindow(), genChars: 0, genMs: 0, busy: false };
const listeners = new Set<(s: TurnStats) => void>();

function publish(): void {
  for (const l of listeners) l(stats);
}

export function getTurnStats(): TurnStats {
  return stats;
}

export function subscribeTurnStats(fn: (s: TurnStats) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function beginTurnStats(): void {
  stats = { ...stats, genChars: 0, genMs: 0, modelRequests: 0, firstTokenMs: undefined, busy: true };
  publish();
}

export function recordModelRequest(firstTokenMs?: number): void {
  stats = { ...stats, modelRequests: (stats.modelRequests ?? 0) + 1, ...(firstTokenMs !== undefined ? { firstTokenMs } : {}) };
  publish();
}

export function recordPromptTokens(promptTokens: number): void {
  stats = { ...stats, promptTokens, ctxWindow: usableContextWindow() };
  publish();
}

export function recordGeneration(chars: number, ms: number): void {
  stats = { ...stats, genChars: stats.genChars + chars, genMs: stats.genMs + ms };
  publish();
}

export function endTurnStats(): void {
  stats = { ...stats, busy: false };
  publish();
}

/** Context fill as a 0..1 fraction of the usable window. */
export function contextFraction(s: TurnStats = stats): number {
  return s.ctxWindow > 0 ? Math.min(1, s.promptTokens / s.ctxWindow) : 0;
}

/** Effective output speed in tokens/second, or 0 when unknown. */
export function tokensPerSecond(s: TurnStats = stats): number {
  if (s.genMs < 500 || s.genChars === 0) return 0;
  return s.genChars / CHARS_PER_TOKEN / (s.genMs / 1000);
}
