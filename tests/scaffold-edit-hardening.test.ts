import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetUndoState } from "../src/system/undo.ts";
import { replaceLines } from "../src/tools/fs.ts";
import { writeProjectMemory } from "../src/tools/scaffold_apps.ts";

const dirs: string[] = [];
const origHome = process.env.SOPHIE_HOME;

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "sophie-hard-"));
  dirs.push(d);
  return d;
}

beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), "sophie-hard-home-"));
  dirs.push(home);
  process.env.SOPHIE_HOME = home;
  resetUndoState();
});

afterEach(() => {
  if (origHome === undefined) delete process.env.SOPHIE_HOME;
  else process.env.SOPHIE_HOME = origHome;
  resetUndoState();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("replace_lines hardening (A)", () => {
  test("refuses a code-file edit without expected_old", async () => {
    const dir = tmp();
    const file = join(dir, "page.tsx");
    writeFileSync(file, "const a = 1;\nconst b = 2;\nconst c = 3;\n");
    const r = await replaceLines.execute(
      { path: file, start_line: 2, end_line: 2, replacement: "const b = 20;" },
      { cwd: dir },
    );
    expect(r.isError).toBe(true);
    expect(r.display).toBe("expected_old required");
  });

  test("allows a code-file edit with a matching expected_old", async () => {
    const dir = tmp();
    const file = join(dir, "page.tsx");
    writeFileSync(file, "const a = 1;\nconst b = 2;\nconst c = 3;\n");
    const r = await replaceLines.execute(
      { path: file, start_line: 2, end_line: 2, replacement: "const b = 20;", expected_old: "const b = 2;" },
      { cwd: dir },
    );
    expect(r.isError).toBeUndefined();
    expect(readFileSync(file, "utf8")).toContain("const b = 20;");
  });

  test("still allows a non-code file edit without expected_old", async () => {
    const dir = tmp();
    const file = join(dir, "notes.txt");
    writeFileSync(file, "one\ntwo\nthree\n");
    const r = await replaceLines.execute(
      { path: file, start_line: 2, end_line: 2, replacement: "TWO" },
      { cwd: dir },
    );
    expect(r.isError).toBeUndefined();
    expect(readFileSync(file, "utf8")).toContain("TWO");
  });
});

describe("project SOPHIE.md on scaffold (C)", () => {
  test("writes SOPHIE.md when absent", () => {
    const dir = tmp();
    writeProjectMemory(dir, "# proj\n\nstack notes");
    expect(existsSync(join(dir, "SOPHIE.md"))).toBe(true);
    expect(readFileSync(join(dir, "SOPHIE.md"), "utf8")).toContain("stack notes");
  });

  test("never overwrites an existing SOPHIE.md", () => {
    const dir = tmp();
    writeFileSync(join(dir, "SOPHIE.md"), "user content");
    writeProjectMemory(dir, "scaffold content");
    expect(readFileSync(join(dir, "SOPHIE.md"), "utf8")).toBe("user content");
  });
});
