import { describe, expect, test } from "bun:test";
import { classifyTurnIntent } from "../src/agent/intent.ts";
import type { Objective, Task } from "../src/agent/tasks.ts";

const chatAppObjective: Objective = {
  content: "Create Desktop/test folder, scaffold a Next.js project with latest shadcn/ui, install AI chat components, and replace page.tsx with a ChatGPT-like chatbot UI.",
  status: "active",
};

const chatAppTasks: Task[] = [
  { content: "Install shadcn/ui CLI and initialize with Tailwind", status: "in_progress" },
  { content: "Install new chat components: message-scroller, message, bubble, attachment, marker", status: "pending" },
  { content: "Verify the app runs and renders correctly in the browser", status: "pending" },
];

describe("bad session replay router checks", () => {
  test.each([
    "is there a folder called test on yhe desktop",
    "please delete the test folder in the desktop",
    "what? thats not what i asked for",
  ])("does not allow stale shadcn app task to hijack: %s", (input) => {
    const intent = classifyTurnIntent(input, { objective: chatAppObjective, tasks: chatAppTasks });
    expect(intent.kind).not.toBe("continue_job");
    expect(intent.shouldTrackTasks).toBe(false);
    expect(intent.resetReason).toBeTruthy();
  });
});
