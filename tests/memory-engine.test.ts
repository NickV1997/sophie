import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  memoryForPrompt,
  observeUserInputForMemory,
  retrieveEngineMemories,
  saveEngineMemory,
} from "../src/memory/engine.ts";

let home: string;
let cwd: string;
const origHome = process.env.SOPHIE_HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sophie-engine-home-"));
  cwd = mkdtempSync(join(tmpdir(), "sophie-engine-proj-"));
  process.env.SOPHIE_HOME = home;
  mkdirSync(join(home, ".sophie"), { recursive: true });
  writeFileSync(join(home, ".sophie", ".memory-migrated"), "test");
});

afterEach(() => {
  if (origHome === undefined) delete process.env.SOPHIE_HOME;
  else process.env.SOPHIE_HOME = origHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe("context-budgeted memory engine", () => {
  test("short verified project procedure beats long vague global fact", () => {
    saveEngineMemory({
      kind: "fact",
      scope: "global",
      full: "The user has talked about benchmarks in many unrelated contexts and likes efficient software with concise answers.",
      confidence: 0.4,
      utility: 0.2,
    }, cwd);
    saveEngineMemory({
      kind: "procedure",
      scope: "project",
      capsule: "Benchmarks: isolate SOPHIE_HOME per run and verify reports before syncing to SSD.",
      full: "For Sophie benchmark fixes, isolate SOPHIE_HOME under bench-results/<run>/home, verify report output, run tests, then sync_to_ssd.sh.",
      evidence: "verified benchmark run passed",
      source: "verifier",
      confidence: 0.9,
      utility: 0.9,
      successCount: 2,
      tags: ["benchmark", "sophie_home", "sync"],
    }, cwd);

    const hits = retrieveEngineMemories("run the sophie benchmark and sync updates", cwd, { maxTokens: 80 });
    expect(hits[0]!.kind).toBe("procedure");
    expect(hits[0]!.capsule).toContain("SOPHIE_HOME");
    expect(memoryForPrompt("benchmark sync", cwd, { maxTokens: 80 })).toContain("Procedures:");
  });

  test("observes explicit user preference and keeps prompt block compact", () => {
    observeUserInputForMemory("I don't wanna add any MCP, I want built-in Sophie tools instead.", cwd);
    const block = memoryForPrompt("should we add mcp tools", cwd, { maxTokens: 60 });
    expect(block).toContain("built-in Sophie tools");
    expect(block.length).toBeLessThan(420);
  });
});
