import { beforeEach, describe, expect, test } from "bun:test";
import { estimateTokens } from "../src/agent/context.ts";
import { systemPrompt } from "../src/agent/prompt.ts";
import { buildToolsBlock } from "../src/llm/qwen.ts";
import { activateToolGroups, disclosedToolNames, resetToolGroups, toolCatalogBlock } from "../src/tools/groups.ts";
import { toolSpecs } from "../src/tools/registry.ts";

beforeEach(() => resetToolGroups());

function promptTokensFor(mode: "normal" | "plan" | "build", groups: string[] = []): number {
  activateToolGroups(groups);
  const disclosed = disclosedToolNames(toolSpecs().map((s) => s.name));
  const tools = toolSpecs().filter((spec) => disclosed.has(spec.name));
  return estimateTokens(systemPrompt(mode, process.cwd(), buildToolsBlock(tools) + toolCatalogBlock()));
}

describe("system prompt budget", () => {
  test("default normal prompt stays compact with deferred tools", () => {
    expect(promptTokensFor("normal")).toBeLessThan(7200);
  });

  test("build prompt with coding tool groups stays under a practical local-model budget", () => {
    expect(promptTokensFor("build", ["coding", "jobs", "shell"])).toBeLessThan(13500);
  });
});
