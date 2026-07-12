import { describe, expect, test } from "bun:test";
import { classifyTurnIntent } from "../src/agent/intent.ts";
import type { Objective, Task } from "../src/agent/tasks.ts";

const staleObjective: Objective = {
  content: "Create Desktop/test folder, scaffold a Next.js project with latest shadcn/ui, install AI chat components, and replace page.tsx with a ChatGPT-like chatbot UI.",
  status: "active",
};

const staleTasks: Task[] = [
  { content: "Install shadcn/ui CLI and initialize with Tailwind", status: "in_progress" },
  { content: "Install new chat components", status: "pending" },
];

describe("turn intent routing", () => {
  test("content containing hello is not mistaken for a greeting", () => {
    const got = classifyTurnIntent("Create a file called hello.txt containing the text 'Hello Sophie'.", { objective: null, tasks: [] });
    expect(got.requiresAction).toBe(true);
    expect(got.expectedTools).toContain("write_file");
  });
  test("quick Desktop folder check resets stale project work", () => {
    const intent = classifyTurnIntent("is there a folder called test on yhe desktop", {
      objective: staleObjective,
      tasks: staleTasks,
    });
    expect(intent.kind).toBe("quick_check");
    expect(intent.shouldTrackTasks).toBe(false);
    expect(intent.resetReason).toContain("standalone local action");
  });

  test("delete folder is standalone action and resets stale project work", () => {
    const intent = classifyTurnIntent("please delete the folder called test in the desktop", {
      objective: staleObjective,
      tasks: staleTasks,
    });
    expect(intent.kind).toBe("standalone_action");
    expect(intent.shouldTrackTasks).toBe(false);
    expect(intent.resetReason).toContain("standalone local action");
  });

  test("fresh app build does not inherit unrelated active objective", () => {
    const intent = classifyTurnIntent("build a one page Next.js app with shadcn", {
      objective: staleObjective,
      tasks: staleTasks,
    });
    expect(intent.kind).toBe("new_job");
    expect(intent.shouldTrackTasks).toBe(true);
    expect(intent.resetReason).toContain("fresh complex objective");
  });

  test("focused coding fix is a standalone action without a task ledger", () => {
    const intent = classifyTurnIntent("fix the typo in src/app/page.tsx", noState);
    expect(intent.kind).toBe("standalone_action");
    expect(intent.requiresAction).toBe(true);
    expect(intent.shouldTrackTasks).toBe(false);
  });

  test("multiple requested actions use a task ledger", () => {
    const intent = classifyTurnIntent("fix the web app connection issue and add a delete button for conversations", noState);
    expect(intent.kind).toBe("new_job");
    expect(intent.shouldTrackTasks).toBe(true);
  });

  test("multi-step jobs retain concrete tool hints", () => {
    const intent = classifyTurnIntent("Check today's calendar, unread email, and recent messages, then build a practical workday plan.", { objective: null, tasks: [] });
    expect(intent.kind).toBe("new_job");
    expect(intent.expectedTools).toEqual(expect.arrayContaining(["calendar_list", "email", "apple"]));
  });

  test("explicit continue keeps old work", () => {
    const intent = classifyTurnIntent("continue where you left off", {
      objective: staleObjective,
      tasks: staleTasks,
    });
    expect(intent.kind).toBe("continue_job");
    expect(intent.shouldTrackTasks).toBe(true);
    expect(intent.resetReason).toBeUndefined();
  });

  test("correction resets stale work without starting a job", () => {
    const intent = classifyTurnIntent("what? thats not what i asked for", {
      objective: staleObjective,
      tasks: staleTasks,
    });
    expect(intent.kind).toBe("correction");
    expect(intent.requiresAction).toBe(false);
    expect(intent.resetReason).toContain("off track");
  });
});

const noState = { objective: null, tasks: [] };

describe("intent confidence gating", () => {
  test("a concrete quick check is high-confidence and restricts tools", () => {
    const intent = classifyTurnIntent("what is in /tmp/demo/test", noState);
    expect(intent.kind).toBe("quick_check");
    expect(intent.confidence).toBeGreaterThanOrEqual(0.7);
    expect(intent.restrictTools).toBe(true);
  });

  test("a vague quick check is low-confidence and does NOT restrict tools", () => {
    const intent = classifyTurnIntent(
      "can you check what the current state of the project is and which parts look most relevant to what i mentioned",
      noState,
    );
    expect(intent.kind).toBe("quick_check");
    expect(intent.confidence).toBeLessThan(0.7);
    expect(intent.restrictTools).toBe(false);
  });

  test("non-restrictive kinds never restrict tools", () => {
    const action = classifyTurnIntent("please delete the folder called test in the desktop", noState);
    expect(action.kind).toBe("standalone_action");
    expect(action.restrictTools).toBe(false);

    const chat = classifyTurnIntent("explain how a hashmap works", noState);
    expect(chat.restrictTools).toBe(false);
  });

  test("local-world facts are action turns with concrete tool hints", () => {
    expect(classifyTurnIntent("What is today's date and day of the week?", noState).expectedTools).toContain("current_time");
    expect(classifyTurnIntent("What operating system and shell am I running?", noState).expectedTools).toContain("system_info");
    expect(classifyTurnIntent("What is 18% of 249.99?", noState).expectedTools).toContain("calc");
    expect(classifyTurnIntent("Remember that I prefer concise answers.", noState).expectedTools).toContain("remember");
    expect(classifyTurnIntent("Book me a flight, but ask me for destination first.", noState).expectedTools).toContain("ask_user");
    expect(classifyTurnIntent("Review my unread email and recent messages.", noState).expectedTools).toEqual(expect.arrayContaining(["email", "apple"]));
    expect(classifyTurnIntent("Find a conflict-free meeting slot.", noState).expectedTools).toContain("calendar_find_free");
    expect(classifyTurnIntent("Create a Carter project, add Jamie as stakeholder, and add a high-priority task.", noState).expectedTools).toEqual(expect.arrayContaining(["people", "projects", "manage_tasks"]));
  });
});
