import { afterEach, describe, expect, test } from "bun:test";
import { config, getContextWindow, setContextWindow } from "../src/config.ts";
import { fitPromptMessages, historyBudget, MAX_WORKING_CONTEXT_TOKENS, promptTokenBudget, safeMaxTokens, usableContextWindow } from "../src/agent/context.ts";

// Restore the effective window after each test (mutates a module global).
afterEach(() => setContextWindow(config.contextWindow));

describe("effective context window", () => {
  test("caps to the server's real n_ctx, never above the configured ceiling", () => {
    setContextWindow(8192);
    expect(getContextWindow()).toBe(8192);

    setContextWindow(config.contextWindow * 4); // server claims more than configured
    expect(getContextWindow()).toBe(config.contextWindow); // stays at the ceiling
  });

  test("ignores non-positive / non-finite values", () => {
    setContextWindow(16384);
    setContextWindow(0);
    setContextWindow(Number.NaN);
    expect(getContextWindow()).toBe(16384);
  });
});

describe("budgeting buffer", () => {
  test("usable window keeps a buffer below the true window", () => {
    setContextWindow(16384);
    expect(usableContextWindow()).toBeLessThan(16384);
    expect(usableContextWindow()).toBeGreaterThan(16384 * 0.85);
  });

  test("history budget shrinks when the window shrinks", () => {
    setContextWindow(32768);
    const big = historyBudget(2000);
    setContextWindow(8192);
    const small = historyBudget(2000);
    expect(small).toBeLessThan(big);
  });

  test("safeMaxTokens keeps prompt + reply within the usable window", () => {
    setContextWindow(8192);
    for (const promptTokens of [500, 3000, 6000, 7000]) {
      const reply = safeMaxTokens(promptTokens);
      // Reply is positive and (for realistic prompts) prompt+reply stays under
      // the true window thanks to the safety buffer.
      expect(reply).toBeGreaterThanOrEqual(256);
      expect(promptTokens + reply).toBeLessThanOrEqual(getContextWindow());
    }
  });

  test("never requests more completion tokens than configured maxTokens", () => {
    setContextWindow(config.contextWindow);
    expect(safeMaxTokens(10)).toBeLessThanOrEqual(config.maxTokens);
  });

  test("never uses the server's full huge window as the working context", () => {
    const original = config.contextWindow;
    config.contextWindow = 200_000;
    setContextWindow(200_000);
    expect(usableContextWindow()).toBe(MAX_WORKING_CONTEXT_TOKENS);
    config.contextWindow = original;
  });

  test("fits prompts by dropping old verbatim chat but keeps the current turn", () => {
    const old = Array.from({ length: 8 }, (_, index) => ({ role: index % 2 ? "assistant" as const : "user" as const, content: `old-${index} ${"x".repeat(1800)}` }));
    const current = { role: "user" as const, content: "CURRENT REQUEST must survive" };
    const tool = { role: "tool" as const, content: "CURRENT TOOL RESULT must survive" };
    const fitted = fitPromptMessages(
      { role: "system", content: "system rules" },
      [...old, current, tool],
      { role: "user", content: "live state" },
      promptTokenBudget(3_000),
    );
    expect(JSON.stringify(fitted.messages)).toContain("CURRENT REQUEST");
    expect(JSON.stringify(fitted.messages)).toContain("CURRENT TOOL RESULT");
    expect(fitted.droppedHistoryMessages).toBeGreaterThan(0);
    expect(fitted.messages.reduce((total, message) => total + (typeof message.content === "string" ? Math.ceil(message.content.length / 3.5) + 4 : 804), 0)).toBeLessThanOrEqual(3_000);
  });
});
