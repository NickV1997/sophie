import { describe, expect, test } from "bun:test";
import { TurnLifecycle } from "../src/agent/turn_lifecycle.ts";
describe("typed turn lifecycle", () => {
  test("records valid work and terminal transitions", () => { const x = new TurnLifecycle(); x.transition("planning"); x.transition("generating"); x.transition("executing"); x.transition("awaiting_approval"); x.transition("executing"); x.finish(); expect(x.phase).toBe("completed"); expect(x.transitions).toHaveLength(6); });
  test("rejects impossible transitions and terminal mutation", () => { const x = new TurnLifecycle(); expect(() => x.transition("executing")).toThrow(); x.finish(); expect(() => x.transition("generating")).toThrow(); });
  test("marks an aborted turn cancelled", () => { const c = new AbortController(); c.abort(); const x = new TurnLifecycle(); x.finish(c.signal); expect(x.phase).toBe("cancelled"); });
});
