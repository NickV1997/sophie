import { afterEach, describe, expect, test } from "bun:test";
import { getMode, setMode } from "../src/agent/mode.ts";
import { clearTasks, getTasks, setTasks, tasksForPrompt } from "../src/agent/tasks.ts";
import { askUser } from "../src/tools/ask_user.ts";
import { updateTasks } from "../src/tools/tasks.ts";

afterEach(() => {
  setMode("normal");
  clearTasks();
});

describe("build mode", () => {
  test("entering build does not create a separate planning phase", () => {
    setMode("build");
    expect(getMode()).toBe("build");

    setMode("normal");
    expect(getMode()).toBe("normal");
  });
});

describe("update_tasks preserves phase; task list renders phase groups", () => {
  test("phase is stored and grouped with progress in the prompt", async () => {
    await updateTasks.execute(
      {
        objective: "Build a chat app",
        tasks: [
          { content: "create next app", status: "completed", phase: "Phase 1: Scaffold" },
          { content: "add sidebar", status: "in_progress", phase: "Phase 2: Core" },
          { content: "add message list", status: "pending", phase: "Phase 2: Core" },
        ],
      },
      { cwd: process.cwd() },
    );
    expect(getTasks()[0]?.phase).toBe("Phase 1: Scaffold");
    const prompt = tasksForPrompt();
    expect(prompt).toContain("## Phase 1: Scaffold — ✓ 1/1");
    expect(prompt).toContain("## Phase 2: Core — ◐ 0/2"); // 0 completed of 2, in progress
  });

  test("a non-phased list still renders flat", () => {
    setTasks([{ content: "do a thing", status: "in_progress" }]);
    expect(tasksForPrompt()).not.toContain("## ");
  });
});

describe("ask_user ends the turn", () => {
  test("returns endTurn with the questions formatted", async () => {
    const r = await askUser.execute({ questions: ["What stack?", "Auth needed?"] }, { cwd: process.cwd() });
    expect(r.endTurn).toBe(true);
    expect(r.content).toContain("1. What stack?");
    expect(r.content).toContain("2. Auth needed?");
  });

  test("schema tells the model that evidence and recommendations belong in the terminal preamble", () => {
    expect(askUser.description).toContain("final user-facing response");
    expect(askUser.parameters.properties?.preamble?.description).toContain("recommendation");
  });

  test("errors with no questions", async () => {
    const r = await askUser.execute({ questions: [] }, { cwd: process.cwd() });
    expect(r.isError).toBe(true);
  });
});
