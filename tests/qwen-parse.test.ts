import { describe, expect, test } from "bun:test";
import { QwenStreamParser } from "../src/llm/qwen.ts";

function parse(raw: string) {
  const p = new QwenStreamParser(
    () => {},
    () => {},
  );
  p.push(raw);
  return p.finalize();
}

describe("QwenStreamParser tool-call parsing", () => {
  test("parses clean tool calls", () => {
    const calls = parse('<tool_call>{"name": "bash", "arguments": {"command": "ls"}}</tool_call>');
    expect(calls.map((c) => c.name)).toEqual(["bash"]);
    expect(calls[0].arguments.command).toBe("ls");
  });

  test("parses multiple tool calls in one buffer", () => {
    const calls = parse(
      '<tool_call>{"name":"read_file","arguments":{"path":"a"}}</tool_call>' +
        '<tool_call>{"name":"read_file","arguments":{"path":"b"}}</tool_call>',
    );
    expect(calls.length).toBe(2);
  });

  // Repairs for the malformed JSON small models routinely emit. Each of these
  // previously dropped the tool call entirely (no tool ran).
  test("repairs `\"name\"=` key assignment", () => {
    const calls = parse('<tool_call>{"name"="bash", "arguments": {"command":"ls"}}</tool_call>');
    expect(calls.map((c) => c.name)).toEqual(["bash"]);
  });

  test("repairs unquoted name key", () => {
    const calls = parse('<tool_call>{name: "bash", "arguments": {"command":"ls"}}</tool_call>');
    expect(calls.map((c) => c.name)).toEqual(["bash"]);
  });

  test("repairs dropped quote on arguments key", () => {
    const calls = parse('<tool_call>{"name":"edit_file",arguments":{"path":"a"}}</tool_call>');
    expect(calls.map((c) => c.name)).toEqual(["edit_file"]);
  });

  test("repairs trailing commas", () => {
    const calls = parse('<tool_call>\n{"name": "read_file", "arguments": {"path": "a.ts",}}\n</tool_call>');
    expect(calls.map((c) => c.name)).toEqual(["read_file"]);
    expect(calls[0].arguments.path).toBe("a.ts");
  });

  test("repairs single-quoted JSON", () => {
    const calls = parse("<tool_call>{'name': 'bash', 'arguments': {'command': 'ls'}}</tool_call>");
    expect(calls.map((c) => c.name)).toEqual(["bash"]);
    expect(calls[0].arguments.command).toBe("ls");
  });

  test("ignores a malformed block that cannot be repaired", () => {
    const calls = parse("<tool_call>this is not json at all</tool_call>");
    expect(calls.length).toBe(0);
  });

  test("hides tool-call XML from visible content", () => {
    let content = "";
    const p = new QwenStreamParser((d) => (content += d), () => {});
    p.push('Sure.<tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call>');
    p.finalize();
    expect(content).toContain("Sure.");
    expect(content).not.toContain("tool_call");
  });

  // Qwen-agent explicitly filters tool calls inside <think> blocks — small
  // models hallucinate <tool_call> tags mid-thought and those must not run.
  test("ignores tool calls hallucinated inside a think block", () => {
    const raw =
      "<think>\nLet me consider calling bash here...\n" +
      '<tool_call>{"name":"bash","arguments":{"command":"rm -rf /"}}</tool_call>\n' +
      "</think>\n" +
      '<tool_call>{"name":"read_file","arguments":{"path":"a.ts"}}</tool_call>';
    const calls = parse(raw);
    // Only the real call outside think should be returned.
    expect(calls.length).toBe(1);
    expect(calls[0].name).toBe("read_file");
  });

  test("hasStartedToolCall ignores tool tags inside think blocks", () => {
    const p = new QwenStreamParser(() => {}, () => {});
    p.push(
      "<think>\nmaybe call <tool_call>something</tool_call>\n</think>\nActual answer here.",
    );
    // The think block's pseudo-call should not trigger repair/retry logic.
    expect(p.hasStartedToolCall()).toBe(false);
  });

  test("ignores tool calls inside an unclosed think block", () => {
    const raw =
      "<think>\nI might call a tool while thinking.\n" +
      '<tool_call>{"name":"bash","arguments":{"command":"echo should-not-run"}}</tool_call>';
    const calls = parse(raw);
    expect(calls).toEqual([]);
  });

  test("ignores tool calls inside an unclosed scratch_pad block", () => {
    const raw =
      "<scratch_pad>\nDrafting a tool call here.\n" +
      '<tool_call>{"name":"bash","arguments":{"command":"echo should-not-run"}}</tool_call>';
    const calls = parse(raw);
    expect(calls).toEqual([]);
  });

  test("real tool call after think block is detected", () => {
    const p = new QwenStreamParser(() => {}, () => {});
    p.push(
      '<think>planning...</think>\n<tool_call>{"name":"bash","arguments":{"command":"ls"}}',
    );
    // An unclosed real call after the think block should still be detected.
    expect(p.hasStartedToolCall()).toBe(true);
  });
});
