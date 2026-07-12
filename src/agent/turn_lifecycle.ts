export type TurnPhase = "initializing" | "planning" | "generating" | "executing" | "awaiting_approval" | "synthesizing" | "completed" | "failed" | "cancelled";
const TERMINAL = new Set<TurnPhase>(["completed", "failed", "cancelled"]);
const ALLOWED: Record<TurnPhase, Set<TurnPhase>> = {
  initializing: new Set(["planning", "generating", "completed", "failed", "cancelled"]),
  planning: new Set(["generating", "executing", "synthesizing", "completed", "failed", "cancelled"]),
  generating: new Set(["generating", "executing", "synthesizing", "completed", "failed", "cancelled"]),
  executing: new Set(["generating", "executing", "awaiting_approval", "synthesizing", "completed", "failed", "cancelled"]),
  awaiting_approval: new Set(["executing", "generating", "failed", "cancelled"]),
  synthesizing: new Set(["generating", "executing", "completed", "failed", "cancelled"]),
  completed: new Set(), failed: new Set(), cancelled: new Set(),
};
export interface TurnTransition { from: TurnPhase; to: TurnPhase; at: number; reason?: string; }
export class TurnLifecycle {
  phase: TurnPhase = "initializing"; readonly transitions: TurnTransition[] = [];
  constructor(private onTransition?: (transition: TurnTransition) => void) {}
  transition(to: TurnPhase, reason?: string): void {
    if (to === this.phase) return;
    if (TERMINAL.has(this.phase) || !ALLOWED[this.phase].has(to)) throw new Error(`invalid turn transition ${this.phase} -> ${to}`);
    const event = { from: this.phase, to, at: Date.now(), reason }; this.phase = to; this.transitions.push(event); this.onTransition?.(event);
  }
  finish(signal?: AbortSignal): void { if (!TERMINAL.has(this.phase)) this.transition(signal?.aborted ? "cancelled" : "completed"); }
  fail(reason: string): void { if (!TERMINAL.has(this.phase)) this.transition("failed", reason); }
}
