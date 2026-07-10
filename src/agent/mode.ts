import type { Mode } from "../config.ts";
import { activeRuntime } from "./runtime.ts";

/**
 * Sophie's operating mode is shared, observable state. Three things touch it:
 *  - the user (Shift+Tab / slash commands in the TUI),
 *  - Sophie herself (the set_mode tool, to plan then execute autonomously),
 *  - the agent loop (reads it each round to set thinking, gating, and prompt).
 * Keeping it in one observable store keeps all three in sync, and lets the
 * header update live when Sophie switches her own mode mid-task.
 */
export function getMode(): Mode {
  return activeRuntime().mode;
}

export function setMode(next: Mode): void {
  const state = activeRuntime();
  if (next === state.mode) return;
  state.mode = next;
  for (const l of state.modeListeners) l(state.mode);
}

export function subscribeMode(fn: (m: Mode) => void): () => void {
  const state = activeRuntime();
  state.modeListeners.add(fn);
  return () => {
    state.modeListeners.delete(fn);
  };
}
