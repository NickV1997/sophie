import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { REPO_ROOT } from "../config.ts";
import type { BenchSummary, Rollup } from "./summary.ts";

interface GateArgs {
  baseline: string;
  summary?: string;
  scope: "full" | "quick" | "medium" | "long";
  maxDrop: number;
  recordHistory: boolean;
  categoryGates: boolean;
}

function parseArgs(argv: string[]): GateArgs {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  const scope = (get("--scope") ?? "full") as GateArgs["scope"];
  if (!["full", "quick", "medium", "long"].includes(scope)) throw new Error(`Unknown --scope ${scope}`);
  return {
    baseline: resolve(REPO_ROOT, get("--baseline") ?? "src/bench/baselines/full-2026-07-07.json"),
    summary: get("--summary") ? resolve(REPO_ROOT, get("--summary")!) : undefined,
    scope,
    maxDrop: Number(get("--max-drop") ?? "0.02"),
    recordHistory: argv.includes("--record-history"),
    categoryGates: !argv.includes("--no-category-gates"),
  };
}

function latestSummaryPath(): string {
  const latestPath = join(REPO_ROOT, "bench-results", "latest.txt");
  if (!existsSync(latestPath)) throw new Error("No bench-results/latest.txt found. Run bun run bench first.");
  const dir = readFileSync(latestPath, "utf8").trim();
  return join(dir, "summary.json");
}

function readSummary(path: string): BenchSummary {
  return JSON.parse(readFileSync(path, "utf8")) as BenchSummary;
}

function scopedRollup(summary: BenchSummary, scope: GateArgs["scope"]): Rollup {
  if (scope === "full") return summary;
  const rollup = summary.byComplexity?.[scope];
  if (!rollup) throw new Error(`Baseline has no byComplexity.${scope} rollup.`);
  return rollup;
}

function writeHistory(summary: BenchSummary, summaryPath: string, scope: string): void {
  const path = join(REPO_ROOT, "src", "bench", "history", "summary-history.jsonl");
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(
    path,
    JSON.stringify({
      recordedAt: new Date().toISOString(),
      source: summaryPath.replace(`${REPO_ROOT}/`, ""),
      scope,
      model: summary.model,
      baseUrl: summary.baseUrl,
      total: summary.total,
      passed: summary.passed,
      failed: summary.failed,
      passRate: summary.passRate,
      byCategory: summary.byCategory,
      byComplexity: summary.byComplexity,
    }) + "\n",
  );
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const summaryPath = args.summary ?? latestSummaryPath();
  const baseline = readSummary(args.baseline);
  const current = readSummary(summaryPath);
  const baselineRollup = scopedRollup(baseline, args.scope);
  const currentRollup = args.scope === "full" ? current : scopedRollup(current, args.scope);
  const floor = +(baselineRollup.passRate - args.maxDrop).toFixed(3);

  if (args.recordHistory) writeHistory(current, summaryPath, args.scope);

  console.log(
    `Benchmark gate (${args.scope}): current ${(currentRollup.passRate * 100).toFixed(1)}% ` +
      `(${currentRollup.passed}/${currentRollup.total}), baseline ${(baselineRollup.passRate * 100).toFixed(1)}%, ` +
      `floor ${(floor * 100).toFixed(1)}%`,
  );

  if (currentRollup.passRate < floor) {
    console.error(`Benchmark regression: pass-rate dropped more than ${(args.maxDrop * 100).toFixed(1)} points.`);
    process.exitCode = 1;
  }
  if (args.scope === "full" && args.categoryGates) {
    const regressions: string[] = [];
    for (const [category, base] of Object.entries(baseline.byCategory ?? {})) {
      const now = current.byCategory?.[category];
      if (!now) { regressions.push(`${category}: missing`); continue; }
      const categoryFloor = Math.max(0, base.passRate - args.maxDrop);
      if (now.passRate < categoryFloor) regressions.push(`${category}: ${(now.passRate * 100).toFixed(1)}% < ${(categoryFloor * 100).toFixed(1)}%`);
    }
    if (regressions.length) {
      console.error(`Category regressions:\n- ${regressions.join("\n- ")}`);
      process.exitCode = 1;
    }
  }
}

main();
