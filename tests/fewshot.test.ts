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

  test("non-coding jobs do not receive a misleading code-edit example", () => {
    expect(fewShotForTurn(intent("new_job"), "normal")).toBe("");
  });

  test("personal multi-record jobs get the compact batch example", () => {
    const personal = { ...intent("standalone_action"), expectedTools: ["projects", "people", "manage_tasks"] };
    const shot = fewShotForTurn(personal, "normal");
    expect(shot).toContain('"projects"');
    expect(shot).toContain('"people"');
    expect(shot).toContain('"tasks"');
  });

  test("build mode uses the edit/verify example", () => {
    expect(fewShotForTurn(intent("continue_job"), "build")).toContain("edit_file");
  });

  test("examples are valid tool-call JSON the parser would accept", async () => {
    const { safeParseCall } = await import("../src/llm/qwen.ts");
    const examples = [
      fewShotForTurn(intent("quick_check"), "normal"),
      fewShotForTurn({ ...intent("standalone_action"), expectedTools: ["projects", "people", "manage_tasks"] }, "normal"),
      fewShotForTurn(intent("continue_job"), "build"),
    ];
    for (const shot of examples) {
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
