import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let completions: string[] = [];
let completionIndex = 0;
let completionPrompts: unknown[] = [];

mock.module("../src/llm/client.ts", () => ({
  getActiveModel: () => "mock",
  completeChat: async (messages: unknown) => {
    completionPrompts.push(messages);
    const reply = completions[completionIndex] ?? "NONE";
    if (completionIndex < completions.length) completionIndex++;
    if (reply === "__THROW__") throw new Error("connection refused");
    return reply;
  },
  streamChat: async function* () {
    yield "Done.";
  },
  ping: async () => ({ ok: true, detail: "mock" }),
  detectContextWindow: async () => ({ nCtx: null, detail: "mock" }),
  detectLoadedModel: async () => ({ id: "mock", source: "mock" }),
}));

const { applyReviewDirectives, memoryReportPath, msUntilNextHour, parseReviewDirectives, runDreamPass, sweepRecords } = await import("../src/memory/dream.ts");
const { deleteEngineMemory, saveEngineMemory, updateEngineMemory } = await import("../src/memory/engine.ts");
const { gateCandidates, parseCandidates } = await import("../src/memory/extraction.ts");
const { pendingObservationCount, recordObservation, restoreObservations, takeObservations } = await import("../src/memory/observations.ts");
const { addMemory, compactFactStore, listMemories, tokenize } = await import("../src/memory/facts.ts");
const { readEngineStore, writeEngineStore } = await import("../src/memory/engine_store.ts");
type EngineMemory = import("../src/memory/engine.ts").EngineMemory;

let home: string;
let cwd: string;
const origHome = process.env.SOPHIE_HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sophie-dream-home-"));
  cwd = mkdtempSync(join(tmpdir(), "sophie-dream-proj-"));
  process.env.SOPHIE_HOME = home;
  mkdirSync(join(home, ".sophie"), { recursive: true });
  writeFileSync(join(home, ".sophie", ".memory-migrated"), "test");
  completions = [];
  completionIndex = 0;
  completionPrompts = [];
});

afterEach(() => {
  if (origHome === undefined) delete process.env.SOPHIE_HOME;
  else process.env.SOPHIE_HOME = origHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

const DAY = 86_400_000;
let seq = 0;

function rec(overrides: Partial<EngineMemory> & { capsule: string }): EngineMemory {
  const now = Date.now();
  return {
    id: `em_test${seq++}`,
    kind: "fact",
    scope: "global",
    full: overrides.capsule,
    evidence: "test",
    source: "runtime",
    confidence: 0.65,
    utility: 0.5,
    useCount: 0,
    successCount: 0,
    failureCount: 0,
    keys: tokenize(overrides.capsule),
    tags: [],
    createdAt: now,
    lastUsedAt: now,
    ...overrides,
  };
}

describe("dream sweep (deterministic)", () => {
  test("merges same-kind near-duplicates and folds their history", () => {
    const a = rec({ capsule: "The user drinks oat milk lattes every single morning.", useCount: 3 });
    const b = rec({ capsule: "User drinks an oat milk latte every morning.", useCount: 2, confidence: 0.9 });
    const { records, stats } = sweepRecords([a, b]);
    expect(stats.duplicates).toBe(1);
    expect(records).toHaveLength(1);
    expect(records[0]!.useCount).toBe(5);
    expect(records[0]!.confidence).toBe(0.9); // higher-confidence phrasing won
  });

  test("prunes stale never-recalled runtime records but protects user/verifier sources", () => {
    const old = Date.now() - 60 * DAY;
    const junk = rec({ capsule: "Some speculative runtime note nobody ever recalled.", createdAt: old, confidence: 0.5 });
    const userSaid = rec({ capsule: "User explicitly prefers dark mode terminals always.", createdAt: old, confidence: 0.5, source: "user" });
    const verified = rec({ capsule: "Verified procedure for running benchmark suite locally.", createdAt: old, confidence: 0.5, source: "verifier", kind: "procedure" });
    const { records, stats } = sweepRecords([junk, userSaid, verified]);
    expect(stats.staleJunk).toBe(1);
    expect(records.map((r) => r.source).sort()).toEqual(["user", "verifier"]);
  });

  test("drops expired and unretrievably vague records", () => {
    const expired = rec({ capsule: "Temporary note about a deadline last quarter sometime.", expiresAt: Date.now() - 1 });
    const vague = rec({ capsule: "hm okay then", keys: tokenize("hm okay then") });
    const keep = rec({ capsule: "User works from the Melbourne office on Tuesdays." });
    const { records, stats } = sweepRecords([expired, vague, keep]);
    expect(stats.expired).toBe(1);
    expect(stats.vague).toBe(1);
    expect(records).toHaveLength(1);
  });
});

describe("dream review directives (validated LLM phase)", () => {
  test("parses directive lines and ignores junk", () => {
    const parsed = parseReviewDirectives(
      "Sure! Here you go:\nDROP 3\nREWRITE 1: User prefers concise answers in chat.\nMERGE 2 4: Combined sentence here.\nSUPERSEDES 5 6\nKEEP 7\nblah",
    );
    expect(parsed).toEqual([
      { op: "drop", a: 3 },
      { op: "rewrite", a: 1, text: "User prefers concise answers in chat." },
      { op: "merge", a: 2, b: 4, text: "Combined sentence here." },
      { op: "supersedes", a: 5, b: 6 },
    ]);
  });

  test("never drops user-sourced records and enforces the drop cap", () => {
    const records = [
      rec({ capsule: "User explicitly stated they love espresso machines.", source: "user" }),
      rec({ capsule: "Random runtime note about a temporary directory path." }),
      rec({ capsule: "Another runtime note about some fleeting tool output." }),
      rec({ capsule: "Third runtime note that also looks pretty disposable." }),
    ];
    const { records: kept, stats } = applyReviewDirectives(records, [
      { op: "drop", a: 1 }, // user-sourced: refused
      { op: "drop", a: 2 },
      { op: "drop", a: 3 },
      { op: "drop", a: 4 }, // over the 34% cap (ceil(4*0.34)=2): refused
    ]);
    expect(stats.dropped).toBe(2);
    expect(kept.some((r) => r.source === "user")).toBe(true);
    expect(kept).toHaveLength(2);
  });

  test("rejects rewrites that do not share vocabulary with the original", () => {
    const records = [rec({ capsule: "User runs Qwen3 on a llama.cpp server at home." })];
    const hallucinated = applyReviewDirectives(records, [
      { op: "rewrite", a: 1, text: "User loves skydiving over the weekend in Portugal." },
    ]);
    expect(hallucinated.stats.rewritten).toBe(0);
    expect(hallucinated.records[0]!.capsule).toContain("llama.cpp");

    const grounded = applyReviewDirectives(records, [
      { op: "rewrite", a: 1, text: "User self-hosts Qwen3 via a local llama.cpp server." },
    ]);
    expect(grounded.stats.rewritten).toBe(1);
    expect(grounded.records[0]!.capsule).toContain("self-hosts");
  });

  test("rewrite summarizes an over-long full down to the capsule", () => {
    const longFull = "User self-hosts Qwen3 via a local llama.cpp server. ".repeat(12);
    const records = [rec({ capsule: "User runs Qwen3 on a llama.cpp server at home.", full: longFull })];
    const { records: out } = applyReviewDirectives(records, [
      { op: "rewrite", a: 1, text: "User self-hosts Qwen3 via a local llama.cpp server." },
    ]);
    expect(out[0]!.full).toBe("User self-hosts Qwen3 via a local llama.cpp server.");
  });

  test("merge requires the same kind and folds history; supersede keeps the newer record", () => {
    const older = rec({ capsule: "User lives in Sydney near the harbour somewhere.", createdAt: Date.now() - 90 * DAY, useCount: 4 });
    const newer = rec({ capsule: "User lives in Melbourne after moving from Sydney recently.", useCount: 1 });
    const pref = rec({ capsule: "User prefers tabs over spaces in Python files.", kind: "preference" });

    // cross-kind merge refused
    const crossKind = applyReviewDirectives([older, pref], [{ op: "merge", a: 1, b: 2, text: "User lives in Sydney and prefers tabs over spaces." }]);
    expect(crossKind.stats.merged).toBe(0);

    // supersede: model claims the OLDER one is current — runtime keeps the newer anyway
    const { records: kept, stats } = applyReviewDirectives([older, newer], [{ op: "supersedes", a: 1, b: 2 }]);
    expect(stats.superseded).toBe(1);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.capsule).toContain("Melbourne");
  });
});

describe("extraction candidates (validated LLM proposals)", () => {
  test("parses only the strict MEMORY line format with whitelisted kinds", () => {
    const parsed = parseCandidates(
      "MEMORY kind=preference scope=global: User prefers short answers in the evening.\n" +
        "MEMORY kind=procedure scope=project: Should be rejected, procedures are verifier-only.\n" +
        "MEMORY kind=fact scope=project: The repo uses bun as its runtime.\n" +
        "Some chatty text that is not a directive.",
    );
    expect(parsed).toHaveLength(2);
    expect(parsed[0]!.kind).toBe("preference");
    expect(parsed[1]!.scope).toBe("project");
  });

  test("gates out hallucinated candidates and caps a pass at five", () => {
    const observations = [
      { ts: Date.now(), text: "please always use bun instead of npm for everything in this repo" },
      { ts: Date.now(), text: "my kid's football practice is on thursdays so no long jobs then" },
    ];
    const grounded = { kind: "preference" as const, scope: "global" as const, text: "User always wants bun used instead of npm in this repo." };
    const hallucinated = { kind: "fact" as const, scope: "global" as const, text: "User owns a vineyard in rural France with three dogs." };
    const kept = gateCandidates([grounded, hallucinated], observations);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.text).toContain("bun");

    const many = Array.from({ length: 9 }, (_, i) => ({
      kind: "fact" as const,
      scope: "global" as const,
      text: `User schedules football practice thursdays variant ${i} with the kid group ${i}.`,
    }));
    expect(gateCandidates(many, observations).length).toBeLessThanOrEqual(5);
  });
});

describe("observation buffer", () => {
  test("buffers substantive turns, skips trivia and repeats, round-trips take/restore", () => {
    recordObservation("hi");
    recordObservation("/help");
    recordObservation("I always want you to write commit messages in present tense.");
    recordObservation("I always want you to write commit messages in present tense.");
    expect(pendingObservationCount()).toBe(1);

    const taken = takeObservations();
    expect(taken).toHaveLength(1);
    expect(pendingObservationCount()).toBe(0);
    restoreObservations(taken);
    expect(pendingObservationCount()).toBe(1);
  });
});

describe("full dream pass", () => {
  test("applies validated review, compacts legacy facts, writes the audit mirror", async () => {
    const now = Date.now();
    writeEngineStore("global", cwd, [
      // useCount 1 so the deterministic sweep keeps it — the CONTRADICTION is
      // the model review's to find, not the sweep's.
      rec({ capsule: "User's favorite editor is vim for all coding work.", createdAt: now - 90 * DAY, lastUsedAt: now - 90 * DAY, useCount: 1 }),
      rec({ capsule: "User's favorite editor is neovim since switching recently.", createdAt: now - 2 * DAY, lastUsedAt: now - 2 * DAY }),
      rec({ capsule: "One-off note about pizza topping order from that day.", createdAt: now - DAY, lastUsedAt: now - DAY }),
    ]);
    addMemory("The user takes coffee with oat milk in the mornings.", cwd, { scope: "user" });
    addMemory("User takes their coffee with oat milk each morning.", cwd, { scope: "user" });

    completions = ["SUPERSEDES 2 1\nDROP 3"];
    const report = await runDreamPass(cwd);

    expect(report.llmReviewed).toBe(true);
    expect(report.review.superseded).toBe(1);
    expect(report.review.dropped).toBe(1);
    const remaining = readEngineStore("global", cwd);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.capsule).toContain("neovim");

    // legacy near-duplicates folded (addMemory's save-time dedup may already
    // merge them; either way exactly one survives)
    expect(listMemories("user", cwd)).toHaveLength(1);

    const mirror = readFileSync(memoryReportPath(), "utf8");
    expect(mirror).toContain("Sophie memory report");
    expect(mirror).toContain("neovim");
    expect(existsSync(join(home, ".sophie", "dream.state.json"))).toBe(true);
  });

  test("a dead model server degrades to the deterministic phases", async () => {
    completions = ["__THROW__", "__THROW__"];
    const now = Date.now();
    writeEngineStore("global", cwd, [
      rec({ capsule: "The user drinks oat milk lattes every single morning.", useCount: 1 }),
      rec({ capsule: "User drinks an oat milk latte every morning.", useCount: 1 }),
      rec({ capsule: "Some speculative runtime note nobody ever recalled.", createdAt: now - 60 * DAY, confidence: 0.5 }),
      rec({ capsule: "User keeps external backups on the silver SSD drive.", useCount: 2 }),
    ]);
    const report = await runDreamPass(cwd);
    expect(report.llmReviewed).toBe(false);
    expect(report.sweep.duplicates).toBe(1);
    expect(report.sweep.staleJunk).toBe(1);
    expect(readEngineStore("global", cwd)).toHaveLength(2);
  });
});

describe("nightly schedule timing", () => {
  test("msUntilNextHour targets the next local 3 AM", () => {
    const at = (h, m = 0) => new Date(2026, 6, 12, h, m);
    expect(msUntilNextHour(3, at(2))).toBe(3600_000);
    expect(msUntilNextHour(3, at(3))).toBe(24 * 3600_000); // exactly 3:00 → tomorrow
    expect(msUntilNextHour(3, at(4))).toBe(23 * 3600_000);
    expect(msUntilNextHour(3, at(23, 30))).toBe(3.5 * 3600_000);
  });
});

describe("memory page edits", () => {
  test("updateEngineMemory rewrites text, re-keys, and marks the record user-owned", () => {
    const { record } = saveEngineMemory({ kind: "fact", scope: "global", full: "The user lives in Sydney near the harbour." }, cwd);
    const updated = updateEngineMemory(record.id, "The user lives in Melbourne now, in the inner north.", cwd);
    expect(updated).not.toBeNull();
    expect(updated!.capsule).toContain("Melbourne");
    expect(updated!.source).toBe("user");
    expect(updated!.confidence).toBeGreaterThanOrEqual(0.9);
    // stale keys are replaced: the old topic no longer recalls it
    expect(updated!.keys).not.toContain("sydney");
    expect(updated!.keys).toContain("melbourne");
  });

  test("updateEngineMemory rejects vague rewrites; deleteEngineMemory removes by id", () => {
    const { record: keep } = saveEngineMemory({ kind: "fact", scope: "project", full: "Project uses bun for tests and scripts." }, cwd);
    expect(updateEngineMemory(keep.id, "ok then", cwd)).toBeNull();
    expect(updateEngineMemory("em_missing", "A perfectly fine memory about the build system.", cwd)).toBeNull();
    expect(deleteEngineMemory(keep.id, cwd)).toBe(true);
    expect(deleteEngineMemory(keep.id, cwd)).toBe(false);
    expect(readEngineStore("project", cwd)).toHaveLength(0);
  });
});

describe("legacy fact compaction", () => {
  test("compactFactStore folds drifted near-duplicates", () => {
    // Write records directly so save-time dedup can't pre-merge them.
    const a = addMemory("Nick runs the benchmark suite before syncing to the SSD.", cwd, { scope: "user" });
    expect(a.action).toBe("created");
    const path = join(home, ".sophie", "memory.jsonl");
    const drifted = { ...a.record, id: "m_drifted", text: "Nick always runs the benchmark suite before he syncs to the SSD.", keys: tokenize("Nick always runs the benchmark suite before he syncs to the SSD.") };
    writeFileSync(path, `${readFileSync(path, "utf8")}${JSON.stringify(drifted)}\n`);
    expect(listMemories("user", cwd)).toHaveLength(2);
    const removed = compactFactStore(cwd);
    expect(removed).toBe(1);
    expect(listMemories("user", cwd)).toHaveLength(1);
  });
});
