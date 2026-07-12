import { describe, expect, test } from "bun:test";
import { ToolStreamParser } from "../src/llm/qwen.ts";
import { protocolForModel } from "../src/llm/tool-protocol.ts";
import { NativeToolCallAccumulator } from "../src/llm/client.ts";

function parse(raw: string) {
  let visible = "";
  const parser = new ToolStreamParser((delta) => (visible += delta), () => {});
  for (let i = 0; i < raw.length; i += 7) parser.push(raw.slice(i, i + 7));
  return { calls: parser.finalize(), visible };
}

describe("model tool protocol selection", () => {
  test("selects GLM for paths and aliases", () => {
    expect(protocolForModel("/models/GLM-4.7-Flash-Q8_0.gguf").id).toBe("glm47");
    expect(protocolForModel("zai-org/glm-4.7-flash").id).toBe("glm47");
  });

  test("keeps Qwen/Hermes as the compatibility fallback", () => {
    expect(protocolForModel("Qwen3.5-35B-A3B-Q8_0.gguf").id).toBe("qwen-json");
    expect(protocolForModel("gemma-4-12b").id).toBe("qwen-json");
    expect(protocolForModel("gpt-oss-20b").id).toBe("qwen-json");
    expect(protocolForModel("unknown-community-model").id).toBe("qwen-json");
  });

  test("GLM disables the incompatible Qwen JSON grammar", () => {
    expect(protocolForModel("GLM-4.7").grammar(["read_file"])).toBeUndefined();
    expect(protocolForModel("Qwen3").grammar(["read_file"])).toContain("<tool_call>");
  });
});

describe("GLM native tool calls", () => {
  test("parses arg tags and hides them from visible content", () => {
    const { calls, visible } = parse(
      "I'll inspect it.\n<tool_call>read_file" +
        "<arg_key>path</arg_key><arg_value>src/index.ts</arg_value></tool_call>",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("read_file");
    expect(calls[0].arguments).toEqual({ path: "src/index.ts" });
    expect(visible).toContain("I'll inspect it.");
    expect(visible).not.toContain("arg_key");
  });

  test("parses multiple and structured arguments", () => {
    const { calls } = parse(
      "<tool_call>apply_edits" +
        "<arg_key>path</arg_key><arg_value>a.ts</arg_value>" +
        '<arg_key>edits</arg_key><arg_value>[{"line":1,"text":"hello"}]</arg_value>' +
        "<arg_key>dry_run</arg_key><arg_value>true</arg_value>" +
        "</tool_call>",
    );
    expect(calls[0].arguments.path).toBe("a.ts");
    expect(calls[0].arguments.edits).toEqual([{ line: 1, text: "hello" }]);
    expect(calls[0].arguments.dry_run).toBe(true);
  });

  test("ignores native calls inside reasoning", () => {
    const { calls } = parse(
      "<think><tool_call>bash<arg_key>command</arg_key><arg_value>bad</arg_value></tool_call></think>" +
        "<tool_call>read_file<arg_key>path</arg_key><arg_value>safe</arg_value></tool_call>",
    );
    expect(calls.map((call) => call.name)).toEqual(["read_file"]);
  });
});

describe("OpenAI native streamed tool-call bridge", () => {
  test("joins fragmented function arguments into canonical calls", () => {
    const native = new NativeToolCallAccumulator();
    native.push([{ index: 0, function: { name: "read_file", arguments: '{"pa' } }]);
    native.push([{ index: 0, function: { arguments: 'th":"README.md"}' } }]);
    const { calls } = parse(native.render());
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: "read_file", arguments: { path: "README.md" } });
  });

  test("accepts arguments returned as an object", () => {
    const native = new NativeToolCallAccumulator();
    native.push([{ index: 0, function: { name: "grep", arguments: { pattern: "TODO", path: "." } } }]);
    const { calls } = parse(native.render());
    expect(calls[0]).toMatchObject({ name: "grep", arguments: { pattern: "TODO", path: "." } });
  });

  test("preserves the order of parallel calls", () => {
    const native = new NativeToolCallAccumulator();
    native.push([
      { index: 1, function: { name: "read_file", arguments: '{"path":"b"}' } },
      { index: 0, function: { name: "read_file", arguments: '{"path":"a"}' } },
    ]);
    const { calls } = parse(native.render());
    expect(calls.map((call) => call.arguments.path)).toEqual(["a", "b"]);
  });
});
