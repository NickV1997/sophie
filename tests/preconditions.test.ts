import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { checkToolPreconditions } from "../src/agent/preconditions.ts";
import type { TurnIntent } from "../src/agent/intent.ts";
import { recoveryHintForFailure } from "../src/agent/recovery.ts";
import { toolSpecs } from "../src/tools/registry.ts";
import type { Tool } from "../src/tools/types.ts";

const intent: TurnIntent = { kind: "new_job", requiresAction: true, shouldTrackTasks: true };
const fakeTool = { name: "fake" } as Tool;

describe("tool preconditions", () => {
  test("blocks editing an existing file before it has been read", () => {
    const root = `/tmp/sophie-preconditions-${Date.now().toString(36)}`;
    mkdirSync(root, { recursive: true });
    writeFileSync(`${root}/app.ts`, "console.log('old')");

    const block = checkToolPreconditions(
      { name: "edit_file", arguments: { path: `${root}/app.ts`, old_string: "old", new_string: "new" }, raw: "" },
      fakeTool,
      { cwd: root, intent, journal: [] },
    );

    expect(block).toContain("existing files must be read");
  });

  test("allows editing after read_file evidence", () => {
    const root = `/tmp/sophie-preconditions-read-${Date.now().toString(36)}`;
    mkdirSync(root, { recursive: true });
    writeFileSync(`${root}/app.ts`, "console.log('old')");

    const block = checkToolPreconditions(
      { name: "edit_file", arguments: { path: `${root}/app.ts`, old_string: "old", new_string: "new" }, raw: "" },
      fakeTool,
      {
        cwd: root,
        intent,
        journal: [{ id: "j1", at: Date.now(), kind: "tool_call", tool: "read_file", summary: `read ${root}/app.ts` }],
      },
    );

    expect(block).toBeNull();
  });

  test("blocks replace_lines without expected_old", () => {
    const block = checkToolPreconditions(
      { name: "replace_lines", arguments: { path: "app.ts", start_line: 1, end_line: 2, replacement: "x" }, raw: "" },
      fakeTool,
      { cwd: process.cwd(), intent, journal: [] },
    );
    expect(block).toContain("expected_old is required");
  });

  test("blocks package command without preflight evidence", () => {
    const block = checkToolPreconditions(
      { name: "bash", arguments: { command: "npm install lucide-react" }, raw: "" },
      fakeTool,
      { cwd: process.cwd(), intent, journal: [] },
    );
    expect(block).toContain("Package/component command precondition failed");
  });

  test("tool specs expose declarative preconditions", () => {
    const specs = toolSpecs();
    expect(specs.find((t) => t.name === "bash")?.preconditions?.join(" ")).toContain("Package add/install");
    expect(specs.find((t) => t.name === "write_file")?.preconditions?.join(" ")).toContain("Read an existing file");
  });

  test("recovery hints provide concrete shadcn next step", () => {
    const hint = recoveryHintForFailure("bash:shadcn", "registry item not found");
    expect(hint).toContain("search @shadcn");
  });
});
