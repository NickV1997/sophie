import { describe, expect, test } from "bun:test";
import { evaluateModelGate } from "../src/bench/model_gate.ts";

describe("per-model release gates", () => {
  test.each([
    ["qwen-9b", .90, "9b"], ["qwen-14b", .92, "14b"], ["qwen-32b", .95, "35b"],
    ["qwen-72b", .96, "70b"], ["local-122b", .97, "100b+"],
  ] as const)("applies an explicit floor to %s", (model, rate, tier) => {
    const result = evaluateModelGate({ model, passRate: rate });
    expect(result.tier).toBe(tier);
    expect(result.passed).toBe(true);
  });
  test("any false action fails even a perfect model run", () => {
    const result = evaluateModelGate({ model: "local-122b", passRate: 1 }, 1);
    expect(result.passed).toBe(false);
    expect(result.reasons[0]).toContain("false action");
  });
});
