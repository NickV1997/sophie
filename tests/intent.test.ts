import { beforeEach, describe, expect, test } from "bun:test";
import { classifyTurnIntent, heuristicTurnIntent } from "../src/agent/intent.ts";
import { setIntentModel } from "../src/agent/intent_model.ts";
import type { Objective, Task } from "../src/agent/tasks.ts";

// Tests exercise the offline heuristic fallback unless a test installs its
// own stub — never a live model server.
beforeEach(() => setIntentModel(null));

const staleObjective: Objective = {
  content: "Create Desktop/test folder, scaffold a Next.js project with latest shadcn/ui, install AI chat components, and replace page.tsx with a ChatGPT-like chatbot UI.",
  status: "active",
};

const staleTasks: Task[] = [
  { content: "Install shadcn/ui CLI and initialize with Tailwind", status: "in_progress" },
  { content: "Install new chat components", status: "pending" },
];

const noState = { objective: null, tasks: [] };

describe("turn intent routing", () => {
  test("content containing hello is not mistaken for a greeting", async () => {
    const got = await classifyTurnIntent("Create a file called hello.txt containing the text 'Hello Sophie'.", noState);
    expect(got.requiresAction).toBe(true);
    expect(got.expectedTools).toContain("write_file");
  });

  test("quick Desktop folder check resets stale project work", async () => {
    const intent = await classifyTurnIntent("is there a folder called test on yhe desktop", {
      objective: staleObjective,
      tasks: staleTasks,
    });
    expect(intent.kind).toBe("quick_check");
    expect(intent.shouldTrackTasks).toBe(false);
    expect(intent.resetReason).toContain("standalone local action");
  });

  test("delete folder is standalone action and resets stale project work", async () => {
    const intent = await classifyTurnIntent("please delete the folder called test in the desktop", {
      objective: staleObjective,
      tasks: staleTasks,
    });
    expect(intent.kind).toBe("standalone_action");
    expect(intent.shouldTrackTasks).toBe(false);
    expect(intent.resetReason).toContain("standalone local action");
  });

  test("fresh app build does not inherit unrelated active objective", async () => {
    const intent = await classifyTurnIntent("build a one page Next.js app with shadcn", {
      objective: staleObjective,
      tasks: staleTasks,
    });
    expect(intent.kind).toBe("new_job");
    expect(intent.shouldTrackTasks).toBe(true);
    expect(intent.resetReason).toContain("fresh complex objective");
  });

  test("focused coding fix is a standalone action without a task ledger", async () => {
    const intent = await classifyTurnIntent("fix the typo in src/app/page.tsx", noState);
    expect(intent.kind).toBe("standalone_action");
    expect(intent.requiresAction).toBe(true);
    expect(intent.shouldTrackTasks).toBe(false);
  });

  test("multiple requested actions use a task ledger", async () => {
    const intent = await classifyTurnIntent("fix the web app connection issue and add a delete button for conversations", noState);
    expect(intent.kind).toBe("new_job");
    expect(intent.shouldTrackTasks).toBe(true);
  });

  test("explicit continue keeps old work", async () => {
    const intent = await classifyTurnIntent("continue where you left off", {
      objective: staleObjective,
      tasks: staleTasks,
    });
    expect(intent.kind).toBe("continue_job");
    expect(intent.shouldTrackTasks).toBe(true);
    expect(intent.resetReason).toBeUndefined();
  });

  test("correction resets stale work without starting a job", async () => {
    const intent = await classifyTurnIntent("what? thats not what i asked for", {
      objective: staleObjective,
      tasks: staleTasks,
    });
    expect(intent.kind).toBe("correction");
    expect(intent.requiresAction).toBe(false);
    expect(intent.resetReason).toContain("off track");
  });
});

describe("model-backed classification", () => {
  test("a valid model classification supplies kind, tools, and outcomes", async () => {
    setIntentModel(async () => ({
      kind: "standalone_action",
      expectedTools: ["email", "calendar_list"],
      requiredOutcomes: [{ prefix: "schedule:add", minimum: 1, instruction: "create the requested reminder with schedule(action:'add')" }],
    }));
    const intent = await classifyTurnIntent("Look over my mail and my day, and set that dentist reminder.", noState);
    expect(intent.kind).toBe("standalone_action");
    expect(intent.expectedTools).toEqual(["email", "calendar_list"]);
    expect(intent.requiredOutcomes?.map((r) => r.prefix)).toEqual(["schedule:add"]);
    expect(intent.shouldTrackTasks).toBe(false);
  });

  test("a conversational label cannot suppress a semantically selected live source", async () => {
    setIntentModel(async () => ({ kind: "chat", expectedTools: ["web_search"], requiredOutcomes: [] }));
    const got = await classifyTurnIntent("Look up a current safety guide and explain it simply.", noState);
    expect(got.kind).toBe("chat");
    expect(got.requiresAction).toBe(true);
  });

  test("multi-step personal operations use semantic contracts instead of a software task ledger", async () => {
    setIntentModel(async () => ({
      kind: "new_job",
      expectedTools: ["projects", "manage_tasks", "calendar"],
      requiredOutcomes: [
        { prefix: "projects:add", minimum: 1, instruction: "add a project" },
        { prefix: "manage_tasks:add", minimum: 3, instruction: "add tasks" },
      ],
    }));
    const got = await classifyTurnIntent("Set up my application tracker and follow-up tasks.", noState);
    expect(got.kind).toBe("new_job");
    expect(got.shouldTrackTasks).toBe(false);
  });

  test("explicitly contracted research and file delivery do not add a second task ledger", async () => {
    setIntentModel(async () => ({
      kind: "new_job",
      expectedTools: ["web_search", "write_file"],
      requiredOutcomes: [
        { prefix: "web_search", minimum: 1, instruction: "research" },
        { prefix: "write_file", minimum: 1, instruction: "write file" },
      ],
    }));
    const got = await classifyTurnIntent("Research interview stories and create a worksheet file.", noState);
    expect(got.shouldTrackTasks).toBe(false);
  });

  test("a failed model call falls back to generic heuristics", async () => {
    setIntentModel(async () => null);
    const intent = await classifyTurnIntent("What is 18% of 249.99?", noState);
    expect(intent.expectedTools).toContain("calc");
  });

  test("fast-path shapes never call the model", async () => {
    let called = false;
    setIntentModel(async () => {
      called = true;
      return null;
    });
    expect((await classifyTurnIntent("hey!", noState)).kind).toBe("chat");
    expect((await classifyTurnIntent("continue where you left off", noState)).kind).toBe("continue_job");
    expect(called).toBe(false);
  });

  test("model reset reasons still apply over stale open work", async () => {
    setIntentModel(async () => ({ kind: "standalone_action", expectedTools: ["weather"], requiredOutcomes: [] }));
    const intent = await classifyTurnIntent("what's the weather like", { objective: staleObjective, tasks: staleTasks });
    expect(intent.resetReason).toContain("standalone local action");
  });
});

describe("intent confidence gating", () => {
  test("a concrete quick check is high-confidence and restricts tools", () => {
    const intent = heuristicTurnIntent("what is in /tmp/demo/test");
    expect(intent.kind).toBe("quick_check");
    expect(intent.confidence).toBeGreaterThanOrEqual(0.7);
    expect(intent.restrictTools).toBe(true);
  });

  test("a vague quick check is low-confidence and does NOT restrict tools", () => {
    const intent = heuristicTurnIntent(
      "can you check what the current state of the project is and which parts look most relevant to what i mentioned",
    );
    expect(intent.kind).toBe("quick_check");
    expect(intent.confidence).toBeLessThan(0.7);
    expect(intent.restrictTools).toBe(false);
  });

  test("non-restrictive kinds never restrict tools", () => {
    const action = heuristicTurnIntent("please delete the folder called test in the desktop");
    expect(action.kind).toBe("standalone_action");
    expect(action.restrictTools).toBe(false);

    const chat = heuristicTurnIntent("explain how a hashmap works");
    expect(chat.restrictTools).toBe(false);
  });

  test("local-world facts get generic tool hints without a model", () => {
    expect(heuristicTurnIntent("What is today's date and day of the week?").expectedTools).toContain("current_time");
    expect(heuristicTurnIntent("What operating system and shell am I running?").expectedTools).toContain("system_info");
    expect(heuristicTurnIntent("What is 18% of 249.99?").expectedTools).toContain("calc");
    expect(heuristicTurnIntent("Remember that I prefer concise answers.").expectedTools).toContain("remember");
    expect(heuristicTurnIntent("What scheduled jobs or reminders do I currently have?").expectedTools).toContain("schedule_list");
  });
});
