import { beforeEach, describe, expect, test } from "bun:test";
import {
  activateToolGroups,
  activeToolGroups,
  autoActivateForInput,
  CORE_TOOLS,
  disclosedToolNames,
  groupOfTool,
  loadTools,
  registerDynamicGroup,
  resetToolGroups,
  TOOL_GROUPS,
  toolCatalogBlock,
} from "../src/tools/groups.ts";
import { getTool, toolSpecs } from "../src/tools/registry.ts";

const allNames = () => toolSpecs().map((s) => s.name);

beforeEach(() => resetToolGroups());

describe("progressive tool disclosure", () => {
  test("every registered tool is either core or in exactly one group", () => {
    for (const name of allNames()) {
      const grouped = groupOfTool(name) !== undefined;
      const core = CORE_TOOLS.has(name);
      expect(core || grouped, `${name} is neither core nor grouped`).toBe(true);
      expect(core && grouped, `${name} is both core and grouped`).toBe(false);
    }
  });

  test("group tool names all exist in the registry", () => {
    for (const g of TOOL_GROUPS) {
      for (const t of g.tools) {
        expect(getTool(t), `group ${g.name} lists unknown tool ${t}`).toBeDefined();
      }
    }
  });

  test("default disclosure is core-only and small", () => {
    const disclosed = disclosedToolNames(allNames());
    expect(disclosed.size).toBeLessThanOrEqual(CORE_TOOLS.size);
    expect(disclosed.has("read_file")).toBe(true);
    expect(disclosed.has("verify_next_app")).toBe(false);
    expect(disclosed.has("notify")).toBe(false);
  });

  test("activation discloses the group's tools and shrinks the catalog", () => {
    const before = toolCatalogBlock();
    expect(before).toContain("coding");
    activateToolGroups(["coding"]);
    const disclosed = disclosedToolNames(allNames());
    expect(disclosed.has("verify_next_app")).toBe(true);
    expect(disclosed.has("scaffold_project")).toBe(true);
    const after = toolCatalogBlock();
    expect(after).not.toContain("- coding:");
    expect(after).toContain("- assistant:");
  });

  test("ungrouped tools are never hidden", () => {
    const disclosed = disclosedToolNames([...allNames(), "totally_new_tool"]);
    expect(disclosed.has("totally_new_tool")).toBe(true);
  });

  test("keyword auto-activation routes assistant and vision requests", () => {
    autoActivateForInput("remind me at 3pm to call mum");
    expect(activeToolGroups().has("assistant")).toBe(true);
    autoActivateForInput("what's in this screenshot on my screen?");
    expect(activeToolGroups().has("vision")).toBe(true);
    expect(activeToolGroups().has("coding")).toBe(false);
  });

  test("plain chat activates nothing", () => {
    autoActivateForInput("hey how are you today");
    expect(activeToolGroups().size).toBe(0);
  });

  test("load_tools activates and returns full schemas", async () => {
    const result = await loadTools.execute({ group: "jobs" }, { cwd: process.cwd() });
    expect(result.isError).toBeUndefined();
    expect(activeToolGroups().has("jobs")).toBe(true);
    expect(result.content).toContain('"run_background"');
    expect(result.content).toContain('"parameters"');
  });

  test("load_tools rejects unknown groups with the available list", async () => {
    const result = await loadTools.execute({ group: "nope" }, { cwd: process.cwd() });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("coding");
  });

  test("dynamic (MCP) groups defer and disclose like built-ins", () => {
    registerDynamicGroup("mcp", "external tools", ["mcp__x__do"]);
    expect(disclosedToolNames([...allNames(), "mcp__x__do"]).has("mcp__x__do")).toBe(false);
    activateToolGroups(["mcp"]);
    expect(disclosedToolNames([...allNames(), "mcp__x__do"]).has("mcp__x__do")).toBe(true);
  });
});
