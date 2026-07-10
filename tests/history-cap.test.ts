import { afterEach, describe, expect, test } from "bun:test";
import { config, setContextWindow } from "../src/config.ts";
import { historyBudget } from "../src/agent/context.ts";

describe("history budget cap (compaction fires regardless of window size)", () => {
  const origWindow = config.contextWindow;
  const origMax = config.maxHistoryTokens;
  afterEach(() => {
    config.contextWindow = origWindow;
    config.maxHistoryTokens = origMax;
    setContextWindow(origWindow);
  });

  test("a 200k window does not let history exceed the cap", () => {
    config.contextWindow = 200_000;
    config.maxHistoryTokens = 24_000;
    setContextWindow(200_000); // simulate a huge server n_ctx
    // Even with an enormous window, the working history is capped so compaction
    // still fires on long chats.
    expect(historyBudget(6000)).toBeLessThanOrEqual(24_000);
    expect(historyBudget(0)).toBeLessThanOrEqual(24_000);
  });

  test("a small window still uses the smaller window-based budget", () => {
    config.contextWindow = 8_000;
    config.maxHistoryTokens = 24_000;
    setContextWindow(8_000);
    // Window budget is far below the cap here, so the cap is not the binding
    // constraint — we never inflate history to the cap when the window is small.
    expect(historyBudget(1000)).toBeLessThan(24_000);
  });
});
