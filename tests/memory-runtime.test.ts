import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatMessage } from "../src/llm/client.ts";

let script: string[] = [];
let scriptIndex = 0;
let prompts: ChatMessage[][] = [];

mock.module("../src/llm/client.ts", () => ({
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

const { Agent } = await import("../src/agent/agent.ts");
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
});

afterEach(() => {
  process.chdir(origCwd);
  if (origHome === undefined) delete process.env.SOPHIE_HOME;
  else process.env.SOPHIE_HOME = origHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe("Sophie runtime memory", () => {
  test("saves user preference automatically and retrieves it through live state", async () => {
    const agent = new Agent();
    script = ["Got it.", "I remember."];
    await agent.run("I don't wanna add MCP. I want built-in Sophie tools.", { requestApproval: async () => "approve" });

    const agent2 = new Agent();
    await agent2.run("what do I prefer about MCP tools?", { requestApproval: async () => "approve" });

    const live = lastLiveState();
    expect(live).toContain("# Relevant memory");
    expect(live).toContain("built-in Sophie tools");
    expect(live.length).toBeLessThan(6000);
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
});
