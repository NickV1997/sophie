import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isNewerVersion } from "../src/system/update.ts";
import { textFromAttributedBody } from "../src/tools/apple.ts";
import { beginTurnStats, contextFraction, getTurnStats, recordModelRequest, tokensPerSecond, type TurnStats } from "../src/agent/stats.ts";
import { addMemory } from "../src/memory/facts.ts";
import { smartRecallForPrompt } from "../src/memory/embeddings.ts";
import { reloadConfig } from "../src/config.ts";

describe("update version comparison", () => {
  test("orders semver correctly", () => {
    expect(isNewerVersion("0.1.0", "0.2.0")).toBe(true);
    expect(isNewerVersion("0.1.0", "0.1.1")).toBe(true);
    expect(isNewerVersion("0.1.0", "1.0.0")).toBe(true);
    expect(isNewerVersion("0.2.0", "0.1.9")).toBe(false);
    expect(isNewerVersion("1.0.0", "1.0.0")).toBe(false);
    expect(isNewerVersion("1.0.0", "v1.0.1")).toBe(true);
    expect(isNewerVersion("garbage", "1.0.0")).toBe(false);
  });
});

describe("Messages attributedBody decoding", () => {
  test("extracts the string from the typedstream NSString layout", () => {
    const text = "Hey, dinner tonight?";
    const blob = Buffer.concat([
      Buffer.from("\x04\x0bstreamtyped\x81"),
      Buffer.from("NSString"),
      Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b, text.length]),
      Buffer.from(text, "utf8"),
      Buffer.from([0x86, 0x84]),
    ]);
    expect(textFromAttributedBody(blob)).toBe(text);
  });

  test("handles the 2-byte length marker for long messages", () => {
    const text = "a".repeat(300);
    const blob = Buffer.concat([
      Buffer.from("NSString"),
      Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b, 0x81]),
      (() => {
        const b = Buffer.alloc(2);
        b.writeUInt16LE(text.length);
        return b;
      })(),
      Buffer.from(text, "utf8"),
    ]);
    expect(textFromAttributedBody(blob)).toBe(text);
  });

  test("empty or garbage blobs return empty", () => {
    expect(textFromAttributedBody(null)).toBe("");
    expect(textFromAttributedBody(Buffer.from([0, 1, 2, 3]))).toBe("");
  });
});

describe("turn stats", () => {
  test("context fraction and tok/s derive sensibly", () => {
    const stats: TurnStats = { promptTokens: 8000, ctxWindow: 16_000, genChars: 3500, genMs: 10_000, busy: false };
    expect(contextFraction(stats)).toBeCloseTo(0.5);
    // 3500 chars ≈ 1000 tokens over 10s ≈ 100 tok/s
    expect(tokensPerSecond(stats)).toBeCloseTo(100, 0);
    // Degenerate inputs never divide by zero.
    expect(tokensPerSecond({ ...stats, genMs: 0 })).toBe(0);
    expect(contextFraction({ ...stats, ctxWindow: 0 })).toBe(0);
  });
  test("tracks model rounds and latest first-token latency", () => {
    beginTurnStats();
    recordModelRequest(240);
    recordModelRequest(180);
    expect(getTurnStats().modelRequests).toBe(2);
    expect(getTurnStats().firstTokenMs).toBe(180);
  });
});

describe("smart recall fallback", () => {
  let home: string;
  let cwd: string;
  const origHome = process.env.SOPHIE_HOME;
  const origEmb = process.env.SOPHIE_EMBEDDINGS;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sophie-emb-home-"));
    cwd = mkdtempSync(join(tmpdir(), "sophie-emb-proj-"));
    process.env.SOPHIE_HOME = home;
    process.env.SOPHIE_EMBEDDINGS = "false"; // force the keyword path — no network in tests
    reloadConfig();
    const dir = join(home, ".sophie");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".memory-migrated"), "test");
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.SOPHIE_HOME;
    else process.env.SOPHIE_HOME = origHome;
    if (origEmb === undefined) delete process.env.SOPHIE_EMBEDDINGS;
    else process.env.SOPHIE_EMBEDDINGS = origEmb;
    reloadConfig();
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  test("falls back to keyword recall when embeddings are disabled", async () => {
    addMemory("The user's favorite restaurant is Da Luigi in Naples", cwd);
    const block = await smartRecallForPrompt("what restaurant do I like", cwd);
    expect(block).toContain("Da Luigi");
    // Unrelated queries inject nothing.
    expect(await smartRecallForPrompt("fix the webpack config", cwd)).toBe("");
  });
});
