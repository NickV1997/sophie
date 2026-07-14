import { describe, expect, test } from "bun:test";
import { heuristicTurnIntent } from "../src/agent/intent.ts";
import { QUESTIONS } from "../src/bench/questions.ts";
import { RUNTIME_GAUNTLET_CHATS } from "../src/bench/runtime_gauntlet.ts";
import { USEFULNESS_SCENARIOS } from "../src/bench/usefulness_suite.ts";
import { getTool, toolSpecs } from "../src/tools/registry.ts";

describe("one-page app runtime benchmark prerequisites", () => {
  test("one-page Next app request routes as a fresh coding job", () => {
    const intent = heuristicTurnIntent("build a one page Next.js UI app with shadcn and verify it runs");
    expect(intent.kind).toBe("new_job");
    expect(intent.shouldTrackTasks).toBe(true);
    expect(intent.requiresAction).toBe(true);
  });

  test("runtime exposes scaffold and verifier tools needed for app benchmark", () => {
    const names = new Set(toolSpecs().map((t) => t.name));
    expect(names.has("scaffold_next_shadcn_project")).toBe(true);
    expect(names.has("verify_next_app")).toBe(true);
    expect(names.has("browser_check")).toBe(true);
    expect(names.has("update_tasks")).toBe(true);
    expect(names.has("manage_tasks")).toBe(true);
  });

  test("domain verifier tools are registered", () => {
    expect(getTool("verify_next_app")).toBeTruthy();
    expect(getTool("verify_python_project")).toBeTruthy();
    expect(getTool("verify_static_site")).toBeTruthy();
  });

  test("coding benchmark cases assert concrete generated artifacts", () => {
    const cases = QUESTIONS.filter((q) => q.category.startsWith("coding-"));
    expect(cases.map((q) => q.id)).toEqual(["code-webapp-01", "code-portfolio-01", "code-algo-tool-01"]);
    for (const q of cases) {
      expect(q.mode).toBe("build");
      expect(q.expectAny?.some((name) => name.startsWith("verify_"))).toBe(true);
      expect(q.artifacts?.length).toBeGreaterThanOrEqual(3);
    }
  });

  test("usefulness benchmark covers assistant breadth", () => {
    expect(USEFULNESS_SCENARIOS.map((s) => s.id)).toEqual(["daily", "research", "coder", "local", "continuity"]);
    const turns = USEFULNESS_SCENARIOS.flatMap((s) => s.turns);
    expect(turns.some((t) => t.expectAny?.includes("weather"))).toBe(true);
    expect(turns.some((t) => t.expectAny?.includes("web_search"))).toBe(true);
    expect(turns.some((t) => t.mode === "build")).toBe(true);
    expect(turns.some((t) => t.ban?.includes("bash"))).toBe(true);
    expect(turns.some((t) => t.artifacts?.length)).toBe(true);
  });

  test("runtime gauntlet covers live-runtime edge cases sequentially", () => {
    expect(RUNTIME_GAUNTLET_CHATS.map((c) => c.id)).toEqual([
      "memory-depth",
      "modes",
      "tool-routing",
      "long-running",
      "loop-recovery",
      "marathon-coder",
    ]);
    const turns = RUNTIME_GAUNTLET_CHATS.flatMap((c) => c.turns);
    expect(turns.some((t) => t.expectMemory?.includes("built-in Sophie tools"))).toBe(true);
    expect(turns.some((t) => t.expectCompaction)).toBe(true);
    expect(turns.some((t) => t.expectModeAfter === "build")).toBe(true);
    expect(turns.some((t) => t.expectAll?.includes("run_background") && t.expectAll?.includes("wait_for"))).toBe(true);
    expect(turns.some((t) => t.expectLoopRecovery)).toBe(true);
    expect(turns.some((t) => t.ban?.includes("bash"))).toBe(true);
    expect(turns.some((t) => t.mode === "build" && t.artifacts?.length)).toBe(true);
  });
});
