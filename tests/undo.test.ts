import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginUndoGroup, recordFileChange, resetUndoState, undoLast, undoStats } from "../src/system/undo.ts";
import { editFile, writeFile } from "../src/tools/fs.ts";

// undo resolves its journal/backups under SOPHIE_HOME/.sophie when set, so a
// throwaway dir per test keeps the real ~/.sophie untouched.
let home: string;
let cwd: string;
const origHome = process.env.SOPHIE_HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sophie-undo-home-"));
  cwd = mkdtempSync(join(tmpdir(), "sophie-undo-proj-"));
  process.env.SOPHIE_HOME = home;
  resetUndoState();
});

afterEach(() => {
  if (origHome === undefined) delete process.env.SOPHIE_HOME;
  else process.env.SOPHIE_HOME = origHome;
  resetUndoState();
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe("undo journal", () => {
  test("nothing to undo on a fresh store", () => {
    const res = undoLast();
    expect(res.ok).toBe(false);
    expect(res.summary).toContain("Nothing to undo");
  });

  test("undo restores a modified file and deletes a created one", () => {
    const modified = join(cwd, "existing.txt");
    const created = join(cwd, "brand-new.txt");
    Bun.write(modified, "original");

    beginUndoGroup("test turn");
    recordFileChange(modified, "original");
    Bun.write(modified, "changed");
    recordFileChange(created, null);
    Bun.write(created, "new content");

    const res = undoLast();
    expect(res.ok).toBe(true);
    expect(readFileSync(modified, "utf8")).toBe("original");
    expect(existsSync(created)).toBe(false);
    // The group is consumed — a second undo finds nothing.
    expect(undoLast().ok).toBe(false);
  });

  test("each turn is its own undo unit, newest first", () => {
    const file = join(cwd, "file.txt");

    beginUndoGroup("turn one");
    recordFileChange(file, null);
    Bun.write(file, "v1");

    beginUndoGroup("turn two");
    recordFileChange(file, "v1");
    Bun.write(file, "v2");

    expect(undoStats().groups).toBe(2);
    const first = undoLast();
    expect(first.summary).toContain("turn two");
    expect(readFileSync(file, "utf8")).toBe("v1");
    const second = undoLast();
    expect(second.summary).toContain("turn one");
    expect(existsSync(file)).toBe(false);
  });
});

describe("undo through the file tools", () => {
  test("write_file + edit_file changes revert with one undo", async () => {
    const path = join(cwd, "note.md");
    beginUndoGroup("make a note");
    await writeFile.execute({ path, content: "hello world\n" }, { cwd });
    await editFile.execute({ path, old_string: "world", new_string: "sophie" }, { cwd });
    expect(readFileSync(path, "utf8")).toBe("hello sophie\n");

    const res = undoLast();
    expect(res.ok).toBe(true);
    // Both entries were one turn: the edit reverts, then the creation deletes.
    expect(existsSync(path)).toBe(false);
  });
});
