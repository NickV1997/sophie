import { beforeEach, describe, expect, mock, test } from "bun:test";

/**
 * Regression: the model re-issuing an identical side-effecting tool call must
 * not run it (or prompt for approval) twice — observed live as Sophie sending
 * the same iMessage two times, with two approval prompts.
 *
 * The LLM client is mocked with a scripted stream so the full agent loop runs
 * without a model server. Script exhausted → plain "Done." forever.
 */

let script: string[] = [];
let scriptIndex = 0;

mock.module("../src/llm/client.ts", () => ({
  streamChat: async function* () {
    yield script[scriptIndex] ?? "Done.";
    if (scriptIndex < script.length) scriptIndex++;
  },
  completeChat: async () => "",
  ping: async () => ({ ok: true, detail: "mock" }),
  detectContextWindow: async () => ({ nCtx: null, detail: "mock" }),
  detectLoadedModel: async () => ({ id: "mock", source: "mock" }),
  getActiveModel: () => "mock",
}));

const { Agent } = await import("../src/agent/agent.ts");
const { registerMcpTools } = await import("../src/tools/registry.ts");
const { setMode } = await import("../src/agent/mode.ts");
const { clearTasks } = await import("../src/agent/tasks.ts");

// A caution-risk tool (→ approval-gated in normal mode) that counts executions.
let executions = 0;
registerMcpTools([
  {
    name: "test_send",
    description: "test double for a side-effecting send",
    parameters: { type: "object", properties: {}, required: [] },
    summarize: () => "test send",
    risk: () => "caution",
    async execute() {
      executions++;
      return { content: "Sent!", display: "sent" };
    },
  },
]);

const CALL = '<tool_call>{"name":"test_send","arguments":{"to":"bob","text":"hi"}}</tool_call>';

async function runScripted(lines: string[]): Promise<{ executions: number; approvals: number }> {
  script = lines;
  scriptIndex = 0;
  executions = 0;
  let approvals = 0;
  setMode("normal");
  clearTasks();
  const agent = new Agent();
  await agent.run(
    "hi",
    {
      requestApproval: async () => {
        approvals++;
        return "approve";
      },
    },
    undefined,
  );
  return { executions, approvals };
}

describe("duplicate side-effecting tool calls", () => {
  beforeEach(() => {
    process.env.SOPHIE_EMBEDDINGS = "false"; // no network from recall in tests
  });

  test("two identical calls in ONE response run once with one approval", async () => {
    const res = await runScripted([`Sending now.\n${CALL}\n${CALL}`, "Done."]);
    expect(res.executions).toBe(1);
    expect(res.approvals).toBe(1);
  });

  test("re-issuing the same call on the NEXT round is skipped, not re-sent", async () => {
    const res = await runScripted([CALL, CALL, "Done."]);
    expect(res.executions).toBe(1);
    expect(res.approvals).toBe(1);
  });

  test("a genuinely different call still runs and prompts", async () => {
    const other = '<tool_call>{"name":"test_send","arguments":{"to":"ana","text":"yo"}}</tool_call>';
    const res = await runScripted([CALL, other, "Done."]);
    expect(res.executions).toBe(2);
    expect(res.approvals).toBe(2);
  });

  test("protected folder delete is blocked before approval", async () => {
    const dangerous = '<tool_call>{"name":"bash","arguments":{"command":"rm -rf $HOME"}}</tool_call>';
    const res = await runScripted([dangerous, "Done."]);
    expect(res.executions).toBe(0);
    expect(res.approvals).toBe(0);
  });
});
