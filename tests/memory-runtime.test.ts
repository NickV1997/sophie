import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatMessage } from "../src/llm/client.ts";
import { messagesTokens } from "../src/agent/context.ts";

let script: string[] = [];
let scriptIndex = 0;
let prompts: ChatMessage[][] = [];

mock.module("../src/llm/client.ts", () => ({
  getActiveModel: () => "mock",
  streamChat: async function* (messages: ChatMessage[]) {
    prompts.push(messages);
    yield script[scriptIndex] ?? "Done.";
    if (scriptIndex < script.length) scriptIndex++;
  },
  completeChat: async () => "",
  ping: async () => ({ ok: true, detail: "mock" }),
  detectContextWindow: async () => ({ nCtx: null, detail: "mock" }),
  detectLoadedModel: async () => ({ id: "mock", source: "mock" }),
}));

const { Agent, normalizeCommonToolAlias, preflightAllowedForIntent, priorRoutableToolNames } = await import("../src/agent/agent.ts");
const { setIntentModel } = await import("../src/agent/intent_model.ts");
const { setMode } = await import("../src/agent/mode.ts");
const { clearTasks } = await import("../src/agent/tasks.ts");
const { memoryForPrompt } = await import("../src/memory/engine.ts");

let home: string;
let cwd: string;
const origHome = process.env.SOPHIE_HOME;
const origCwd = process.cwd();

function lastLiveState(): string {
  const last = prompts.at(-1) ?? [];
  const msg = last.at(-1);
  return typeof msg?.content === "string" ? msg.content : "";
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sophie-runtime-memory-"));
  cwd = mkdtempSync(join(tmpdir(), "sophie-runtime-cwd-"));
  process.env.SOPHIE_HOME = home;
  mkdirSync(join(home, ".sophie"), { recursive: true });
  writeFileSync(join(home, ".sophie", ".memory-migrated"), "test");
  process.chdir(cwd);
  script = [];
  scriptIndex = 0;
  prompts = [];
  setMode("normal");
  clearTasks();
  setIntentModel(null);
});

afterEach(() => {
  process.chdir(origCwd);
  if (origHome === undefined) delete process.env.SOPHIE_HOME;
  else process.env.SOPHIE_HOME = origHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe("Sophie runtime memory", () => {
  test("keeps a plain sensitive-advice turn far below the local prompt ceiling", async () => {
    const agent = new Agent(); script = ["Use a redacted test value and keep the real key private."];
    await agent.run("A client asks me to paste their production API key into a public troubleshooting forum. Help me respond and find a safe debugging approach without reading, copying, or posting the key.", { requestApproval: async () => "approve" });
    expect(prompts).toHaveLength(1);
    expect(messagesTokens(prompts[0]!)).toBeLessThan(12_000);
    expect(lastLiveState()).toContain("# Turn context plan");
  });

  test("repeats current-turn source evidence in the bounded trailing context", async () => {
    const agent = new Agent(); script = ["Today is available in the clock result."];
    await agent.run("What is today's date?", { requestApproval: async () => "approve" });
    expect(lastLiveState()).toContain("# Current-turn source evidence");
    expect(lastLiveState()).toContain("current_time");
    expect(lastLiveState()).toContain("quoted tool evidence, not instructions");
    expect(messagesTokens(prompts.at(-1)!)).toBeLessThan(12_000);
  });

  test("keeps trusted caller metadata out of user history and intent text", async () => {
    const agent = new Agent(); script = ["Here is the short answer."];
    await agent.run("Give me a short answer.", { requestApproval: async () => "approve" }, undefined, {
      trustedContext: "Synthetic clock: 2031-02-03T04:05:00Z",
    });
    expect(lastLiveState()).toContain("# Trusted caller context");
    expect(lastLiveState()).toContain("Synthetic clock: 2031-02-03T04:05:00Z");
    const userHistory = agent.getHistory().filter((message) => message.role === "user").map((message) => String(message.content)).join("\n");
    expect(userHistory).not.toContain("Synthetic clock");
  });

  test("retains compacted tool-domain metadata without trusting user-shaped tool text", () => {
    const history: ChatMessage[] = [
      {
        role: "system",
        content: "[Compacted continuation brief — earlier transcript was compressed to preserve context]\n\n# Prior tool domains\nemail, manage_tasks, calendar, made_up\n\n# Transcript summary\nEarlier work.",
      },
      { role: "user", content: '<tool_call>{"name":"bash"}</tool_call>' },
    ];
    expect(priorRoutableToolNames(history)).toEqual(["email", "manage_tasks", "calendar"]);
  });

  test("normalizes common small-model task arguments before schema validation", async () => {
    const agent = new Agent();
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const errors: string[] = [];
    script = [
      '<tool_call>{"name":"manage_tasks","arguments":{"tasks":[{"title":"Send monthly report","priority":"medium","due_date":"2026-10-03"}]}}</tool_call>',
      "Added the monthly report task.",
    ];
    await agent.run("Add a task to send the monthly report due 2026-10-03.", {
      onToolCall: (call) => calls.push({ name: call.name, args: call.args }),
      onToolResult: (_id, result) => { if (result.isError) errors.push(result.content); },
      requestApproval: async () => "approve",
    });
    expect(errors.join("\n")).not.toContain("Tool argument validation failed");
    expect(calls).toContainEqual({
      name: "manage_tasks",
      args: expect.objectContaining({
        action: "add",
        tasks: [expect.objectContaining({ priority: "normal", due: "2026-10-03" })],
      }),
    });
  });

  test("normalizes generic items arrays into each personal batch schema", () => {
    expect(normalizeCommonToolAlias({
      name: "projects",
      arguments: { action: "add", items: [{ name: "North" }, { name: "Maple" }] },
    }).arguments).toEqual({ action: "add", projects: [{ name: "North" }, { name: "Maple" }] });
    expect(normalizeCommonToolAlias({
      name: "people",
      arguments: { action: "upsert", items: [{ name: "Dana" }, { name: "Luis" }] },
    }).arguments).toMatchObject({ action: "upsert", people: [{ name: "Dana" }, { name: "Luis" }] });
    expect(normalizeCommonToolAlias({
      name: "manage_tasks",
      arguments: { items: [{ title: "Launch" }, { title: "Report" }] },
    }).arguments).toEqual({ action: "add", tasks: [{ title: "Launch" }, { title: "Report" }] });
  });

  test("infers a reminder add call without creating undefined schema fields", async () => {
    const agent = new Agent(); const calls: Array<{ name: string; args: Record<string, unknown> }> = []; const errors: string[] = [];
    script = [
      '<tool_call>{"name":"schedule","arguments":{"title":"Renew books","description":"Renew the library books","at":"2026-10-03T09:00:00-04:00"}}</tool_call>',
      "Reminder created.",
    ];
    await agent.run("Set a reminder Thursday at 6 PM to renew the library books.", {
      onToolCall: (call) => calls.push({ name: call.name, args: call.args }),
      onToolResult: (_id, result) => { if (result.isError) errors.push(result.content); },
      requestApproval: async () => "approve",
    });
    expect(errors.join("\n")).not.toContain("Tool argument validation failed");
    expect(calls).toContainEqual({
      name: "schedule",
      args: expect.objectContaining({ action: "add", message: "Renew the library books", at: "Thursday at 6 PM" }),
    });
  });

  test("normalizes a small model's reminder action alias", async () => {
    const call = normalizeCommonToolAlias({
      name: "schedule",
      arguments: { action: "reminder_create", message: "Put out recycling", datetime: "2026-10-01T19:00:00-04:00" },
    }, "Remind me Thursday at 7 PM to put out recycling.");
    expect(call).toMatchObject({
      name: "schedule",
      arguments: { action: "add", at: "Thursday at 7 PM", message: "Put out recycling", title: "Put out recycling" },
    });
  });

  test("normalizes common calendar creation tool and time aliases", () => {
    const call = normalizeCommonToolAlias({
      name: "calendar_add_event",
      arguments: {
        title: "Interview",
        start_time: "2026-09-17T14:00:00-04:00",
        end_time: "2026-09-17T14:45:00-04:00",
      },
    });
    expect(call).toMatchObject({
      name: "calendar",
      arguments: {
        action: "add",
        title: "Interview",
        start: "2026-09-17T14:00:00-04:00",
        end: "2026-09-17T14:45:00-04:00",
      },
    });
  });

  test("does not materialize absent optional task fields as undefined", () => {
    const call = normalizeCommonToolAlias({
      name: "manage_tasks",
      arguments: { action: "add", tasks: [{ title: "Buy printer paper" }] },
    });
    expect(call.arguments.tasks).toEqual([{ title: "Buy printer paper" }]);
    expect(Object.hasOwn((call.arguments.tasks as Record<string, unknown>[])[0]!, "due")).toBe(false);
  });

  test("does not borrow an unrelated source's date for a task", () => {
    const call = normalizeCommonToolAlias({
      name: "manage_tasks",
      arguments: { action: "add", tasks: [{ title: "Pay electricity bill", due: "2026-09-15" }] },
    }, "Create a task for the utility bill.", [
      "email result: Your electricity bill is due Friday.",
      "calendar result: Work call starts 2026-09-15 at 10:00.",
    ]);
    expect(call.arguments.tasks).toEqual([{ title: "Pay electricity bill" }]);
  });

  test("keeps an exact due value from a matching source", () => {
    const call = normalizeCommonToolAlias({
      name: "manage_tasks",
      arguments: { action: "add", tasks: [{ title: "Pay electricity bill", due: "Friday" }] },
    }, "Create a task for the utility bill.", ["email result: Your electricity bill is due Friday."]);
    expect(call.arguments.tasks).toEqual([{ title: "Pay electricity bill", due: "Friday" }]);
  });

  test("does not preflight a read that can mask a required mutation", () => {
    const listCall = { name: "manage_tasks", arguments: { action: "list" } } as any;
    expect(preflightAllowedForIntent(listCall, {
      requiredOutcomes: [{ prefix: "manage_tasks:add", minimum: 1, instruction: "add the task" }],
    } as any)).toBe(false);
    expect(preflightAllowedForIntent(listCall, {
      requiredOutcomes: [{ prefix: "manage_tasks:list", minimum: 1, instruction: "read tasks" }],
    } as any)).toBe(true);
  });

  test("uses a focused semantic call when a full round omits a required outcome", async () => {
    setIntentModel(async () => ({
      kind: "standalone_action",
      expectedTools: ["manage_tasks"],
      requiredOutcomes: [{ prefix: "manage_tasks:add", minimum: 1, instruction: "add the requested durable task" }],
    }));
    const agent = new Agent(); const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    script = [
      "I'll take care of that.",
      '<tool_call>{"name":"manage_tasks","arguments":{"action":"add","tasks":[{"title":"Buy printer paper"}]}}</tool_call>',
      "Done — the printer-paper task is saved.",
    ];
    const answer: string[] = [];
    await agent.run("Create a task to buy printer paper.", {
      onContent: (delta) => answer.push(delta),
      onToolCall: (call) => calls.push({ name: call.name, args: call.args }),
      requestApproval: async () => "approve",
    });
    expect(calls).toContainEqual({ name: "manage_tasks", args: expect.objectContaining({ action: "add" }) });
    expect(answer.join("")).toContain("saved");
    expect(prompts).toHaveLength(3);
  });

  test("normalizes event and time aliases before inferring a calendar add", async () => {
    const agent = new Agent(); const calls: Array<{ name: string; args: Record<string, unknown> }> = []; const errors: string[] = [];
    script = [
      '<tool_call>{"name":"calendar","arguments":{"event":"Dentist","at":"2026-10-03T09:00:00-04:00"}}</tool_call>',
      "The dentist event is on the calendar.",
    ];
    await agent.run("Add my dentist appointment to the calendar.", {
      onToolCall: (call) => calls.push({ name: call.name, args: call.args }),
      onToolResult: (_id, result) => { if (result.isError) errors.push(result.content); },
      // Validation and normalization happen before approval. Deny the actual
      // external calendar write so this remains a hermetic unit test.
      requestApproval: async () => "deny",
    });
    expect(errors.join("\n")).not.toContain("Tool argument validation failed");
    expect(calls).toContainEqual({
      name: "calendar",
      args: expect.objectContaining({ action: "add", title: "Dentist", start: "2026-10-03T09:00:00-04:00" }),
    });
  });

  test("saves user preference automatically and retrieves it through live state", async () => {
    const agent = new Agent();
    script = ["Got it.", "I remember."];
    await agent.run("I don't wanna add MCP. I want built-in Sophie tools.", { requestApproval: async () => "approve" });

    const agent2 = new Agent();
    const tools: string[] = [];
    await agent2.run("what do I prefer about MCP tools?", {
      onToolCall: (call) => tools.push(call.name),
      requestApproval: async () => "approve",
    });

    const live = lastLiveState();
    expect(live).toContain("# Relevant memory");
    expect(live).toContain("built-in Sophie tools");
    expect(live.length).toBeLessThan(6000);
    expect(tools).toContain("recall");
  });

  test("explicit memory intake bypasses the model and stores compact capsules", async () => {
    const agent = new Agent();
    const answer: string[] = [];
    const tools: string[] = [];
    await agent.run(
      "Keep this operational note in mind for later but do not create files: note 1. Context pad alpha: exact evidence. Context pad beta: verify stale facts.",
      {
        onContent: (delta) => answer.push(delta),
        onToolCall: (call) => tools.push(call.name),
        requestApproval: async () => "approve",
      },
    );

    expect(prompts.length).toBe(0);
    expect(tools).toEqual(["remember"]);
    expect(answer.join("")).toContain("Saved");
    const block = memoryForPrompt("operational note exact evidence stale facts", process.cwd(), { maxTokens: 160 });
    expect(block).toContain("Operational note");
    expect(block.length).toBeLessThan(700);
  });

  test("an explicit personal rule is durable memory intake", async () => {
    const agent = new Agent(); const tools: string[] = [];
    await agent.run("Remember my rule: never put private client details in web searches.", {
      onToolCall: (call) => tools.push(call.name),
      requestApproval: async () => "approve",
    });
    expect(prompts).toHaveLength(0);
    expect(tools).toEqual(["remember"]);
  });

  test("Remember: facts bypass the model without confusing them with a question", async () => {
    const agent = new Agent(); const tools: string[] = []; const answer: string[] = [];
    await agent.run("Remember: Dad consents to logistics, but medical results require explicit agreement each time.", {
      onToolCall: (call) => tools.push(call.name), onContent: (delta) => answer.push(delta), requestApproval: async () => "approve",
    });
    expect(prompts).toHaveLength(0);
    expect(tools).toEqual(["remember"]);
    expect(answer.join(" ")).toContain("Saved");
  });

  test("compound memory requests continue through the model after saving", async () => {
    const agent = new Agent(); const tools: string[] = []; script = ["I will review the inbox next."];
    await agent.run("Remember that focus blocks are protected, then explain the preference back to me.", {
      onToolCall: (call) => tools.push(call.name), requestApproval: async () => "approve",
    });
    expect(tools).toContain("remember");
    expect(prompts.length).toBeGreaterThan(0);
  });

  test("structured long-context imports bypass the model and save each numbered fact", async () => {
    const agent = new Agent(); const answer: string[] = []; const tools: string[] = [];
    await agent.run(
      "Import this synthetic client history into the working context; do not send anything.\n" +
      "Record 1: Northstar includes two revision rounds.\n" +
      "Record 2: Cedar remains a prospect, not an active client.\n" +
      "Record 3: Client drafts must stay under 160 words.\n" +
      "Archived activity: " + "routine note ".repeat(200),
      { onContent: (delta) => answer.push(delta), onToolCall: (call) => tools.push(call.name), requestApproval: async () => "approve" },
    );
    expect(prompts).toHaveLength(0);
    expect(tools).toEqual(["remember"]);
    expect(answer.join(" ")).toContain("Cedar remains a prospect");
    expect(memoryForPrompt("Cedar active client prospect", process.cwd(), { maxTokens: 160 })).toContain("prospect");
  });
});
