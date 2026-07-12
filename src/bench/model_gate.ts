import { readFileSync } from "node:fs";
import { modelRuntimeProfile, type ModelTier } from "../llm/model-profile.ts";
import type { BenchSummary } from "./summary.ts";

export interface ModelGateResult { model: string; tier: ModelTier; passRate: number; floor: number; falseActions: number; passed: boolean; reasons: string[]; }
const FLOORS: Record<ModelTier, number> = { "9b": 0.9, "14b": 0.92, "35b": 0.95, "70b": 0.96, "100b+": 0.97, unknown: 0.95 };

export function evaluateModelGate(summary: Pick<BenchSummary, "model" | "passRate">, falseActions = 0): ModelGateResult {
  const tier = modelRuntimeProfile(summary.model).tier;
  const floor = FLOORS[tier];
  const reasons: string[] = [];
  if (summary.passRate < floor) reasons.push(`pass rate ${(summary.passRate * 100).toFixed(1)}% is below ${(floor * 100).toFixed(1)}% for ${tier}`);
  if (falseActions > 0) reasons.push(`${falseActions} false action(s); required 0`);
  return { model: summary.model, tier, passRate: summary.passRate, floor, falseActions, passed: reasons.length === 0, reasons };
}

async function main(): Promise<void> {
  const paths = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
  if (!paths.length) throw new Error("Pass one or more benchmark summary.json paths.");
  const results = paths.map((path) => {
    const summary = JSON.parse(readFileSync(path, "utf8")) as BenchSummary & { falseActions?: number };
    return evaluateModelGate(summary, summary.falseActions ?? 0);
  });
  for (const result of results) console.log(`${result.passed ? "PASS" : "FAIL"} ${result.model} (${result.tier}): ${(result.passRate * 100).toFixed(1)}%, floor ${(result.floor * 100).toFixed(1)}%, false actions ${result.falseActions}${result.reasons.length ? ` — ${result.reasons.join("; ")}` : ""}`);
  if (results.some((result) => !result.passed)) process.exitCode = 1;
}
if (import.meta.main) await main();
