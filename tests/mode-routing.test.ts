import { describe, expect, test } from "bun:test";
import { thinkDirective } from "../src/llm/qwen.ts";
import { involvesCoding, reasoningForMode, shouldAutoBuild, shouldAutoPlan } from "../src/agent/agent.ts";
import { classifyTurnIntent } from "../src/agent/intent.ts";

const intentFor = (input: string) => classifyTurnIntent(input, { objective: null, tasks: [] });

describe("reasoning levels", () => {
  test("normal = thinking off, plan = medium /think, build = low /think", () => {
    expect(thinkDirective("off")).toBe("/no_think");
    expect(thinkDirective("medium")).toContain("/think");
    expect(thinkDirective("medium").toLowerCase()).toContain("medium");
    expect(thinkDirective("low")).toContain("/think");
    expect(thinkDirective("low").toLowerCase()).toContain("brief");
  });

  test("reasoningForMode: plan medium, build low, normal off", () => {
    expect(reasoningForMode("plan")).toBe("medium");
    expect(reasoningForMode("build")).toBe("low");
    expect(reasoningForMode("normal")).toBe("off");
  });
});

describe("involvesCoding", () => {
  test("true for code-mutating requests", () => {
    expect(involvesCoding("fix the asChild error in app/page.tsx")).toBe(true);
    expect(involvesCoding("build me a nextjs app")).toBe(true);
    expect(involvesCoding("refactor the auth component")).toBe(true);
  });
  test("false for non-coding or read-only requests", () => {
    expect(involvesCoding("what's the weather")).toBe(false);
    expect(involvesCoding("list the files in this folder")).toBe(false);
    expect(involvesCoding("Create a Carter Renovation project, add Jamie as stakeholder, and add a task")).toBe(false);
  });
});

describe("auto-routing (build vs plan)", () => {
  const codingInputs = ["build a shadcn nextjs chat app", "scaffold a python cli tool"];

  test("multi-step coding requests route to BUILD (not standalone plan)", () => {
    for (const input of codingInputs) {
      expect(shouldAutoBuild("normal", intentFor(input), input)).toBe(true);
      expect(shouldAutoPlan("normal", intentFor(input), input)).toBe(false);
    }
  });

  test("focused one-step coding fixes stay in normal mode without auto-build", () => {
    const input = "fix the type error in page.tsx";
    const intent = intentFor(input);
    expect(intent.shouldTrackTasks).toBe(false);
    expect(shouldAutoBuild("normal", intent, input)).toBe(false);
    expect(shouldAutoPlan("normal", intent, input)).toBe(false);
  });

  test("an explicit plan-only coding request enters PLAN without auto-building", () => {
    const input = "Create an implementation plan for a Python CLI, but do not write code yet";
    const intent = intentFor(input);
    expect(shouldAutoBuild("normal", intent, input)).toBe(false);
    expect(shouldAutoPlan("normal", intent, input)).toBe(true);
  });

  test("does not override an explicit plan/build mode", () => {
    expect(shouldAutoBuild("build", intentFor("build an app"), "build an app")).toBe(false);
    expect(shouldAutoBuild("plan", intentFor("build an app"), "build an app")).toBe(false);
    expect(shouldAutoPlan("plan", intentFor("build an app"), "build an app")).toBe(false);
  });

  test("does not re-route a continued job", () => {
    const cont = classifyTurnIntent("continue", { objective: { content: "x", status: "active" }, tasks: [] });
    expect(shouldAutoBuild("normal", cont, "continue")).toBe(false);
    expect(shouldAutoPlan("normal", cont, "continue")).toBe(false);
  });

  test("does not route a greeting / simple chat", () => {
    expect(shouldAutoBuild("normal", intentFor("hey how's it going"), "hey how's it going")).toBe(false);
    expect(shouldAutoPlan("normal", intentFor("hey how's it going"), "hey how's it going")).toBe(false);
  });

  test("an everyday workday plan stays in normal assistant mode", () => {
    const input = "Check my calendar and inbox, then build me a practical workday plan";
    expect(shouldAutoPlan("normal", intentFor(input), input)).toBe(false);
  });
});
