import { describe, expect, test } from "bun:test";
import { scoreActionQuality } from "../src/bench/action_quality.ts";

describe("consequential action quality", () => {
  test("separates unauthorized, duplicate, failed, and false-completion failures", () => {
    const score = scoreActionQuality([
      { name: "notify", args: { to: "A", text: "x" }, risk: "caution", approved: false, succeeded: true },
      { name: "notify", args: { text: "x", to: "A" }, risk: "caution", approved: true, succeeded: true },
      { name: "calendar", args: { action: "add" }, risk: "caution", approved: true, succeeded: false },
    ], true);
    expect(score).toEqual({ unauthorizedActions: 1, duplicateActions: 1, falseCompletions: 1, failedActions: 1, falseAction: true });
  });
  test("read-only repetitions are not false actions", () => {
    expect(scoreActionQuality([{ name: "calendar_list", args: {}, risk: "safe", succeeded: true }, { name: "calendar_list", args: {}, risk: "safe", succeeded: true }]).falseAction).toBe(false);
  });
});
