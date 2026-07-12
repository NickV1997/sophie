import { readFileSync } from "node:fs";
import { performanceRegressions, type PerformanceSummary } from "./performance.ts";

const args = process.argv.slice(2);
const value = (flag: string) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
const currentPath = value("--current"); const baselinePath = value("--baseline");
if (!currentPath || !baselinePath) throw new Error("Usage: performance_gate.ts --current performance.json --baseline performance.json");
const current = JSON.parse(readFileSync(currentPath, "utf8")) as PerformanceSummary;
const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as PerformanceSummary;
const failures = performanceRegressions(current, baseline);
console.log(`Performance gate ${current.model}: median ${(current.durationMs.median / 1000).toFixed(1)}s, p95 ${(current.durationMs.p95 / 1000).toFixed(1)}s, first-token p95 ${(current.firstTokenMs.p95 / 1000).toFixed(1)}s, mean rounds ${current.modelRequests.mean}`);
if (failures.length) { console.error(`Performance regressions:\n- ${failures.join("\n- ")}`); process.exitCode = 1; }
