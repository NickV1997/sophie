import { describe, expect, test } from "bun:test";
import { buildPerformanceSummary, performanceRegressions, type PerformanceSummary } from "../src/bench/performance.ts";

describe("runtime performance release gate", () => {
  test("summarizes hardware and model-facing latency separately", () => {
    const records: any[] = [
      { durationMs: 1000, timedOut: false, runtime: { firstTokenMs: 100, modelRequests: 1, promptTokens: 2000 } },
      { durationMs: 3000, timedOut: false, runtime: { firstTokenMs: 300, modelRequests: 2, promptTokens: 4000 } },
    ];
    const summary = buildPerformanceSummary(records, "qwen-9b");
    expect(summary.tier).toBe("9b"); expect(summary.durationMs.median).toBe(1000); expect(summary.durationMs.p95).toBe(3000);
    expect(summary.modelRequests.mean).toBe(1.5); expect(summary.firstTokenMs.p95).toBe(300);
  });
  test("fails material latency, prompt, or round regressions", () => {
    const baseline: PerformanceSummary = { model: "qwen-35b", tier: "35b", cases: 10, durationMs: { median: 1000, p95: 2000 }, firstTokenMs: { median: 100, p95: 200 }, modelRequests: { mean: 1, p95: 2 }, promptTokens: { median: 2000, p95: 4000 } };
    const current: PerformanceSummary = { ...baseline, durationMs: { median: 1000, p95: 2600 }, firstTokenMs: { median: 100, p95: 260 }, modelRequests: { mean: 1.6, p95: 3 }, promptTokens: { median: 2000, p95: 4500 } };
    expect(performanceRegressions(current, baseline)).toHaveLength(4);
    expect(performanceRegressions(baseline, baseline)).toHaveLength(0);
  });
});
