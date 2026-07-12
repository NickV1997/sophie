import { getActiveModel } from "./client.ts";
import { toolCallGrammar } from "./grammar.ts";
import {
  buildToolsBlock as buildQwenToolsBlock,
  repairToolCallsViaModel,
  ToolStreamParser,
  type ParsedToolCall,
} from "./qwen.ts";
import type { ToolSpec } from "../tools/types.ts";

export type { ParsedToolCall } from "./qwen.ts";

export type ToolProtocolId = "qwen-json" | "glm47";

export interface ToolProtocol {
  id: ToolProtocolId;
  buildToolsBlock(tools: ToolSpec[]): string;
  createParser(onContent: (delta: string) => void, onThinking: (delta: string) => void): ToolStreamParser;
  grammar(toolNames: string[]): string | undefined;
  repair(raw: string, signal?: AbortSignal): Promise<ParsedToolCall[]>;
  retryInstruction: string;
}

function buildGlmToolsBlock(tools: ToolSpec[]): string {
  const specs = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
  return [
    "# Tools",
    "",
    "You may call one or more functions from <tools>. If none is relevant, answer normally.",
    "<tools>",
    JSON.stringify(specs),
    "</tools>",
    "",
    "Use GLM's native tool-call format exactly:",
    "<tool_call>function_name<arg_key>argument_name</arg_key><arg_value>argument_value</arg_value></tool_call>",
    "Repeat arg_key/arg_value pairs for additional arguments. Encode object and array values as valid JSON.",
    "Do not invent tools or omit required arguments.",
  ].join("\n");
}

const qwen: ToolProtocol = {
  id: "qwen-json",
  buildToolsBlock: buildQwenToolsBlock,
  createParser: (onContent, onThinking) => new ToolStreamParser(onContent, onThinking),
  grammar: (names) => toolCallGrammar(names),
  repair: repairToolCallsViaModel,
  retryInstruction:
    'Retry now using exactly: <tool_call>{"name":"tool_name","arguments":{"arg":"value"}}</tool_call>',
};

const glm: ToolProtocol = {
  id: "glm47",
  buildToolsBlock: buildGlmToolsBlock,
  createParser: (onContent, onThinking) => new ToolStreamParser(onContent, onThinking),
  // The existing lazy grammar describes JSON calls and would fight GLM's
  // native arg tags. Parsing + schema validation are the safe first adapter.
  grammar: () => undefined,
  repair: repairToolCallsViaModel,
  retryInstruction:
    "Retry now using exactly: <tool_call>tool_name<arg_key>arg</arg_key><arg_value>value</arg_value></tool_call>",
};

export function protocolForModel(modelId: string): ToolProtocol {
  return /(?:^|[\\/_\-.])glm(?:[\\/_\-.]|$)/i.test(modelId) ? glm : qwen;
}

export function activeToolProtocol(): ToolProtocol {
  return protocolForModel(getActiveModel());
}
