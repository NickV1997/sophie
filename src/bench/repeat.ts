import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../config.ts";

export interface RepeatedStats { runs: number; meanPassRate: number; minPassRate: number; maxPassRate: number; standardDeviation: number; falseActions: number; }
export function repeatedStats(passRates: number[], falseActions = 0): RepeatedStats {
  const mean = passRates.reduce((a, b) => a + b, 0) / Math.max(1, passRates.length);
  const variance = passRates.reduce((n, x) => n + (x - mean) ** 2, 0) / Math.max(1, passRates.length);
  return { runs: passRates.length, meanPassRate: mean, minPassRate: Math.min(...passRates), maxPassRate: Math.max(...passRates), standardDeviation: Math.sqrt(variance), falseActions };
}
function dirs(): Set<string> { try { return new Set(readdirSync(join(REPO_ROOT, "bench-results"))); } catch { return new Set(); } }
async function main(): Promise<void> {
  const args = process.argv.slice(2); const runs = Math.max(2, Number(args[args.indexOf("--runs") + 1]) || 3); const ids = args.includes("--ids") ? args[args.indexOf("--ids") + 1] : undefined;
  const rates: number[] = []; let falseActions = 0;
  for (let i = 0; i < runs; i++) { const before = dirs(); const cmd = ["bun", "run", "src/bench/sophie_benchmark.ts", "--allow-failures", ...(ids ? ["--ids", ids] : ["--quick"])]; const p = Bun.spawn(cmd, { cwd: REPO_ROOT, stdout: "inherit", stderr: "inherit" }); if (await p.exited !== 0) throw new Error(`benchmark run ${i + 1} failed`); const created = [...dirs()].filter((x) => !before.has(x)).sort().at(-1); if (!created) throw new Error("benchmark produced no result directory"); const summary = JSON.parse(readFileSync(join(REPO_ROOT, "bench-results", created, "summary.json"), "utf8")); rates.push(summary.passRate); const lines = readFileSync(join(REPO_ROOT, "bench-results", created, "results.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); falseActions += lines.filter((x: any) => x.falseAction === true).length; }
  const stats = repeatedStats(rates, falseActions); const out = join(REPO_ROOT, "bench-results", "repeated-summary.json"); writeFileSync(out, JSON.stringify(stats, null, 2)); console.log(`Repeated benchmark: mean ${(stats.meanPassRate * 100).toFixed(1)}%, min ${(stats.minPassRate * 100).toFixed(1)}%, σ ${(stats.standardDeviation * 100).toFixed(2)}%, false actions ${stats.falseActions}`);
  if (stats.minPassRate < 0.95 || stats.falseActions > 0) process.exitCode = 1;
}
if (import.meta.main) await main();
