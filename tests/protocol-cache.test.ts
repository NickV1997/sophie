import { beforeEach, describe, expect, test } from "bun:test";
import { clearProtocolArtifactCache, protocolArtifactCacheSize, protocolArtifacts } from "../src/agent/protocol_cache.ts";
import type { ToolProtocol } from "../src/llm/tool-protocol.ts";
import type { ToolSpec } from "../src/tools/types.ts";

const specs: ToolSpec[] = [{ name: "read_file", description: "read", parameters: { type: "object", properties: {} } }];
let builds = 0; let grammars = 0;
const protocol: ToolProtocol = {
  id: "qwen-json",
  buildToolsBlock: (tools) => { builds++; return tools.map((tool) => tool.name).join(","); },
  createParser: (() => { throw new Error("unused"); }) as any,
  grammar: (names) => { grammars++; return names.join("|"); },
  repair: async () => [], retryInstruction: "retry",
};

beforeEach(() => { builds = 0; grammars = 0; clearProtocolArtifactCache(); });

describe("tool protocol artifact cache", () => {
  test("reuses schema serialization and grammar compilation across rounds", () => {
    expect(protocolArtifacts(protocol, specs, ["read_file"], true).cacheHit).toBe(false);
    expect(protocolArtifacts(protocol, [...specs], ["read_file"], true).cacheHit).toBe(true);
    expect(builds).toBe(1); expect(grammars).toBe(1); expect(protocolArtifactCacheSize()).toBe(1);
  });
  test("invalidates when disclosure, registration, or grammar mode changes", () => {
    protocolArtifacts(protocol, specs, ["read_file"], true);
    protocolArtifacts(protocol, [...specs, { ...specs[0]!, name: "grep" }], ["read_file", "grep"], true);
    protocolArtifacts(protocol, specs, ["read_file"], false);
    expect(builds).toBe(3); expect(grammars).toBe(2);
  });
  test("bounds memory under changing dynamic tool sets", () => {
    for (let i = 0; i < 50; i++) protocolArtifacts(protocol, specs, [`dynamic_${i}`], true);
    expect(protocolArtifactCacheSize()).toBeLessThanOrEqual(32);
  });
});
