import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetUndoState } from "../src/system/undo.ts";
import { applyEdits } from "../src/tools/edit_block.ts";

let home: string;
const origHome = process.env.SOPHIE_HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sophie-apply-home-"));
  process.env.SOPHIE_HOME = home;
  resetUndoState();
});

afterEach(() => {
  if (origHome === undefined) delete process.env.SOPHIE_HOME;
  else process.env.SOPHIE_HOME = origHome;
  resetUndoState();
  rmSync(home, { recursive: true, force: true });
});

function scratch(name: string, content: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "apply-edits-"));
  writeFileSync(join(dir, name), content);
  return { dir, path: join(dir, name) };
}

describe("apply_edits", () => {
  test("exact single edit", async () => {
    const { dir, path } = scratch("a.txt", "one\ntwo\nthree\n");
    const r = await applyEdits.execute({ path: "a.txt", edits: [{ search: "two", replace: "TWO" }] }, { cwd: dir });
    expect(r.isError).toBeFalsy();
    expect(readFileSync(path, "utf8")).toBe("one\nTWO\nthree\n");
  });

  test("multiple edits applied atomically in one call", async () => {
    const { dir, path } = scratch("b.txt", "alpha\nbeta\ngamma\n");
    const r = await applyEdits.execute(
      { path: "b.txt", edits: [{ search: "alpha", replace: "A" }, { search: "gamma", replace: "G" }] },
      { cwd: dir },
    );
    expect(r.isError).toBeFalsy();
    expect(readFileSync(path, "utf8")).toBe("A\nbeta\nG\n");
  });

  test("tolerates trailing whitespace / CRLF differences in search", async () => {
    const { dir, path } = scratch("c.txt", "foo  \r\nbar\r\n");
    const r = await applyEdits.execute({ path: "c.txt", edits: [{ search: "foo\nbar", replace: "baz\nqux" }] }, { cwd: dir });
    expect(r.isError).toBeFalsy();
    expect(readFileSync(path, "utf8")).toContain("baz");
    expect(readFileSync(path, "utf8")).toContain("qux");
  });

  test("re-indents when the search block is flush-left but the file is indented", async () => {
    const { dir, path } = scratch("d.py", "def f():\n    return 1\n");
    const r = await applyEdits.execute(
      { path: "d.py", edits: [{ search: "return 1", replace: "return 2" }] },
      { cwd: dir },
    );
    expect(r.isError).toBeFalsy();
    // The replacement keeps the file's 4-space indent.
    expect(readFileSync(path, "utf8")).toBe("def f():\n    return 2\n");
  });

  test("ambiguous search fails clearly instead of guessing", async () => {
    const { dir } = scratch("e.txt", "x\nx\nx\n");
    const r = await applyEdits.execute({ path: "e.txt", edits: [{ search: "x", replace: "y" }] }, { cwd: dir });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/matches \d+ places/);
  });

  test("miss returns the closest region for a targeted retry", async () => {
    const { dir } = scratch("f.ts", "const value = 1;\nconst other = 2;\n");
    const r = await applyEdits.execute({ path: "f.ts", edits: [{ search: "const value = 99;", replace: "const value = 3;" }] }, { cwd: dir });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/Closest region|not found/);
  });

  test("rejects invalid TS syntax and leaves the file untouched", async () => {
    const { dir, path } = scratch("g.ts", "export const n = 1;\n");
    const before = readFileSync(path, "utf8");
    const r = await applyEdits.execute({ path: "g.ts", edits: [{ search: "export const n = 1;", replace: "export const n = ;" }] }, { cwd: dir });
    expect(r.isError).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("accepts raw Aider-format diff blocks", async () => {
    const { dir, path } = scratch("h.txt", "hello world\n");
    const diff = "<<<<<<< SEARCH\nhello world\n=======\ngoodbye world\n>>>>>>> REPLACE\n";
    const r = await applyEdits.execute({ path: "h.txt", diff }, { cwd: dir });
    expect(r.isError).toBeFalsy();
    expect(readFileSync(path, "utf8")).toBe("goodbye world\n");
  });

  test("no-op replacement is reported, not silently written", async () => {
    const { dir } = scratch("i.txt", "same\n");
    const r = await applyEdits.execute({ path: "i.txt", edits: [{ search: "same", replace: "same" }] }, { cwd: dir });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/No change/);
  });

  test("missing file guides to write_file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "apply-edits-"));
    const r = await applyEdits.execute({ path: "nope.txt", edits: [{ search: "a", replace: "b" }] }, { cwd: dir });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/write_file/);
  });
});
