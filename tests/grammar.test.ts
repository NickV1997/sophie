import { describe, expect, test } from "bun:test";
import { toolCallGrammar } from "../src/llm/grammar.ts";

describe("tool-call GBNF grammar", () => {
  test("includes every well-formed tool name as an alternative", () => {
    const g = toolCallGrammar(["read_file", "bash", "mcp__shadcn__search"]);
    expect(g).toContain('"\\"read_file\\""');
    expect(g).toContain('"\\"bash\\""');
    expect(g).toContain('"\\"mcp__shadcn__search\\""');
  });

  test("drops names that would break the grammar", () => {
    const g = toolCallGrammar(["ok_tool", 'evil" ::= tool']);
    expect(g).toContain("ok_tool");
    expect(g).not.toContain("evil");
  });

  test("returns empty for no usable names (caller then sends no grammar)", () => {
    expect(toolCallGrammar([])).toBe("");
    expect(toolCallGrammar(['"broken'])).toBe("");
  });

  test("root starts at the trigger tag and defines full JSON rules", () => {
    const g = toolCallGrammar(["bash"]);
    expect(g).toMatch(/^root ::= call/);
    expect(g).toContain('call ::= "<tool_call>"');
    expect(g).toContain('"</tool_call>"');
    for (const rule of ["object ::=", "member ::=", "array ::=", "value ::=", "string ::=", "number ::=", "ws ::="]) {
      expect(g).toContain(rule);
    }
  });

  test("every referenced nonterminal is defined", () => {
    const g = toolCallGrammar(["bash", "read_file"]);
    const defined = new Set([...g.matchAll(/^([a-z]+) ::=/gm)].map((m) => m[1]));
    // Terminals/rules referenced anywhere on right-hand sides:
    for (const ref of ["call", "toolname", "object", "member", "array", "value", "string", "char", "hex", "number", "ws"]) {
      expect(defined.has(ref), `missing rule: ${ref}`).toBe(true);
    }
  });
});
