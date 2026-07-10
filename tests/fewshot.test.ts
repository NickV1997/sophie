import { describe, expect, test } from "bun:test";
import { fewShotForTurn } from "../src/agent/fewshot.ts";
import type { TurnIntent } from "../src/agent/intent.ts";

function intent(kind: TurnIntent["kind"]): TurnIntent {
  return { kind, requiresAction: true, shouldTrackTasks: false, confidence: 0.8, restrictTools: false };
}

describe("per-intent few-shot selection", () => {
  test("chat gets no example (zero tokens)", () => {
    expect(fewShotForTurn(intent("chat"), "normal")).toBe("");
    expect(fewShotForTurn(intent("correction"), "normal")).toBe("");
  });

  test("quick checks get the single-read example", () => {
    const shot = fewShotForTurn(intent("quick_check"), "normal");
    expect(shot).toContain("list_dir");
    expect(shot).toContain("No task list");
  });

  test("coding jobs get the locate→edit→verify example", () => {
    const shot = fewShotForTurn(intent("new_job"), "normal");
    expect(shot).toContain("edit_file");
    expect(shot).toContain("tsc --noEmit");
  });

  test("build mode uses the edit/verify example", () => {
    expect(fewShotForTurn(intent("continue_job"), "build")).toContain("edit_file");
  });

  test("examples are valid tool-call JSON the parser would accept", async () => {
    const { safeParseCall } = await import("../src/llm/qwen.ts");
    for (const kind of ["quick_check", "new_job"] as const) {
      const shot = fewShotForTurn(intent(kind), "normal");
      const bodies = [...shot.matchAll(/<tool_call>([\s\S]*?)<\/tool_call>/g)].map((m) => m[1]);
      expect(bodies.length).toBeGreaterThan(0);
      for (const body of bodies) {
        expect(safeParseCall(body), `unparseable example: ${body}`).not.toBeNull();
      }
    }
  });

  test("examples stay compact (they ride in every first round)", () => {
    for (const mode of ["normal", "plan", "build"]) {
      const shot = fewShotForTurn(intent("new_job"), mode);
      expect(shot.length).toBeLessThan(1600);
    }
  });
});
