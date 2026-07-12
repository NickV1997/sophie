import type { CaseRecord } from "./report.ts";
import { modelRuntimeProfile, type ModelTier } from "../llm/model-profile.ts";

export interface PerformanceSummary {
  model: string; tier: ModelTier; cases: number;
  durationMs: { median: number; p95: number };
  firstTokenMs: { median: number; p95: number };
  modelRequests: { mean: number; p95: number };
  promptTokens: { median: number; p95: number };
}
function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
}
const roundedMean = (values: number[]) => values.length ? +(values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2) : 0;

export function buildPerformanceSummary(records: CaseRecord[], model: string): PerformanceSummary {
  const valid = records.filter((record) => !record.timedOut && record.durationMs > 0);
  const ttft = valid.map((record) => record.runtime?.firstTokenMs).filter((value): value is number => value !== undefined);
  const requests = valid.map((record) => record.runtime?.modelRequests ?? 0);
  const prompts = valid.map((record) => record.runtime?.promptTokens ?? 0).filter((value) => value > 0);
  return {
    model, tier: modelRuntimeProfile(model).tier, cases: valid.length,
    durationMs: { median: percentile(valid.map((record) => record.durationMs), .5), p95: percentile(valid.map((record) => record.durationMs), .95) },
    firstTokenMs: { median: percentile(ttft, .5), p95: percentile(ttft, .95) },
    modelRequests: { mean: roundedMean(requests), p95: percentile(requests, .95) },
    promptTokens: { median: percentile(prompts, .5), p95: percentile(prompts, .95) },
  };
}

export function performanceRegressions(current: PerformanceSummary, baseline: PerformanceSummary): string[] {
  const failures: string[] = [];
  if (current.tier !== baseline.tier) failures.push(`model tier changed from ${baseline.tier} to ${current.tier}`);
  if (baseline.durationMs.p95 && current.durationMs.p95 > baseline.durationMs.p95 * 1.25) failures.push(`p95 duration ${current.durationMs.p95}ms exceeds 125% of baseline ${baseline.durationMs.p95}ms`);
  if (baseline.firstTokenMs.p95 && current.firstTokenMs.p95 > baseline.firstTokenMs.p95 * 1.25) failures.push(`p95 first-token ${current.firstTokenMs.p95}ms exceeds 125% of baseline ${baseline.firstTokenMs.p95}ms`);
  if (current.modelRequests.mean > baseline.modelRequests.mean + .5) failures.push(`mean model requests ${current.modelRequests.mean} exceeds baseline ${baseline.modelRequests.mean} + 0.5`);
  if (baseline.promptTokens.p95 && current.promptTokens.p95 > baseline.promptTokens.p95 * 1.1) failures.push(`p95 prompt tokens ${current.promptTokens.p95} exceeds 110% of baseline ${baseline.promptTokens.p95}`);
  return failures;
}
