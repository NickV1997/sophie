import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addMemory,
  listMemories,
  recallForPrompt,
  recallMemories,
  tokenize,
  upsertMemory,
} from "../src/memory/facts.ts";

// facts.ts resolves its store under SOPHIE_HOME/.sophie when that env var is set,
// so point it at a throwaway dir per test — the real ~/.sophie is never touched.
let home: string;
let cwd: string;
const origHome = process.env.SOPHIE_HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sophie-home-"));
  cwd = mkdtempSync(join(tmpdir(), "sophie-proj-"));
  process.env.SOPHIE_HOME = home;
  // Pre-mark migration done so the legacy import doesn't interfere.
  const dir = join(home, ".sophie");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".memory-migrated"), "test");
});

afterEach(() => {
  if (origHome === undefined) delete process.env.SOPHIE_HOME;
  else process.env.SOPHIE_HOME = origHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe("tokenize", () => {
  test("drops stopwords, short tokens, folds plurals", () => {
    const t = tokenize("The user keeps hitting hydration bugs in Next.js");
    expect(t).toContain("hydration");
    expect(t).toContain("bug"); // "bugs" folded
    expect(t).toContain("next");
    expect(t).not.toContain("the");
    expect(t).not.toContain("in");
  });
});

describe("recall relevance", () => {
  test("a bug query recalls the matching bug fix, not unrelated trivia", () => {
    addMemory("The user likes pizza with pineapple", cwd, { type: "preference" });
    addMemory(
      "Fixed the hydration mismatch by moving the date format into a useEffect on the client",
      cwd,
      { type: "convention" },
    );

    const hits = recallMemories("why is there a hydration mismatch bug", cwd, 4);
    expect(hits.length).toBe(1);
    expect(hits[0]!.text).toContain("hydration");

    const block = recallForPrompt("hydration bug", cwd);
    expect(block).toContain("hydration");
    expect(block).not.toContain("pizza");
  });

  test("an unrelated turn recalls nothing", () => {
    addMemory("The user likes pizza with pineapple", cwd, { type: "preference" });
    expect(recallMemories("compile the rust binary", cwd, 4)).toEqual([]);
    expect(recallForPrompt("compile the rust binary", cwd)).toBe("");
  });
});

describe("dedup + reinforcement", () => {
  test("a near-duplicate fact merges instead of appending", () => {
    const a = addMemory("The user prefers pnpm as the package manager", cwd);
    expect(a.action).toBe("created");
    const b = addMemory("The user prefers pnpm for the package manager", cwd);
    expect(b.action).toBe("merged");
    expect(listMemories("user", cwd).length).toBe(1);
  });

  test("recall bumps useCount on surfaced records", () => {
    addMemory("The deploy command is `flyctl deploy`", cwd);
    recallMemories("how do I deploy", cwd);
    const rec = listMemories("user", cwd).find((r) => r.text.includes("deploy"))!;
    expect(rec.useCount).toBeGreaterThan(0);
  });

  test("upsert by slot keeps a single self-managed record current", () => {
    upsertMemory("location", "Location (approx): Brampton, Ontario", cwd);
    upsertMemory("location", "Location (approx): Toronto, Ontario", cwd);
    const locs = listMemories("user", cwd).filter((r) => r.slot === "location");
    expect(locs.length).toBe(1);
    expect(locs[0]!.text).toContain("Toronto");
  });
});

describe("project scope", () => {
  test("project facts are stored under the project and recalled with user facts", () => {
    addMemory("This project uses Prisma with a Postgres database", cwd, { scope: "project" });
    expect(existsSync(join(cwd, ".sophie", "memory.jsonl"))).toBe(true);
    const hits = recallMemories("what database does this project use", cwd, 4);
    expect(hits.some((h) => h.text.includes("Prisma"))).toBe(true);
  });
});
