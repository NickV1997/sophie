import { describe, expect, test } from "bun:test";
import { validateToolArguments } from "../src/tools/schema.ts";
import { getTool } from "../src/tools/registry.ts";

function validate(name: string, args: Record<string, unknown>) {
  const tool = getTool(name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return validateToolArguments(name, tool.parameters, args);
}

describe("tool argument schema validation", () => {
  test("accepts valid arguments and ignores harmless extra fields", () => {
    const result = validate("read_file", { path: "src/index.tsx", extra: "ignored" });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("rejects missing required top-level fields", () => {
    const result = validate("read_file", {});
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("read_file.path is required");
  });

  test("rejects wrong primitive types", () => {
    const result = validate("bash", { command: 123 });
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("bash.command must be string");
  });

  test("rejects invalid enum values", () => {
    const result = validate("set_mode", { mode: "fast" });
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain('"normal"');
  });

  test("validates nested array item schemas", () => {
    const result = validate("update_tasks", {
      tasks: [{ content: "Inspect", status: "doing" }],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("update_tasks.tasks[0].status");
  });
});

