/** Bootstrap each persona in a separate process before Sophie stores load. */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const value = (flag: string) => { const index = argv.indexOf(flag); return index >= 0 ? argv[index + 1] : undefined; };
const child = argv.includes("--child");
const scenarioIds = ["maya-founder-week", "leo-business-week", "priya-executive-week", "omar-builder-week"];

if (child) {
  const out = process.env.SOPHIE_REAL_WORLD_OUT;
  const home = process.env.SOPHIE_HOME;
  if (!out || !home) throw new Error("Child benchmark requires isolated output and SOPHIE_HOME.");
  mkdirSync(join(home, ".sophie"), { recursive: true });
  process.env.SOPHIE_EPISODES_DIR = join(home, ".sophie", "episodes");
  const { runRealWorldBenchmark } = await import("./real_world_benchmark.ts");
  await runRealWorldBenchmark();
} else {
  const root = process.cwd(); const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19); const out = join(root, "bench-results", `${stamp}-real-world`); mkdirSync(out, { recursive: true });
  const requested = value("--scenario")?.split(",").filter(Boolean); const selected = requested?.length ? scenarioIds.filter((id) => requested.includes(id)) : scenarioIds;
  if (!selected.length) throw new Error(`No matching scenario. Available: ${scenarioIds.join(", ")}`);
  const maxTurns = value("--max-turns"); const allowFailures = argv.includes("--allow-failures"); let failed = false;
  for (const id of selected) {
    const scenarioOut = join(out, id); const home = join(scenarioOut, "isolated-home"); mkdirSync(join(home, ".sophie"), { recursive: true });
    const childArgs = [process.execPath, import.meta.path, "--child", "--scenario", id, ...(maxTurns ? ["--max-turns", maxTurns] : []), ...(allowFailures ? ["--allow-failures"] : [])];
    const proc = Bun.spawn(childArgs, { cwd: root, env: { ...process.env, SOPHIE_HOME: home, SOPHIE_REAL_WORLD_OUT: scenarioOut }, stdout: "inherit", stderr: "inherit" });
    if (await proc.exited !== 0) failed = true;
  }
  const summaries = selected.map((id) => { const path = join(out, id, "summary.json"); return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null; }).filter(Boolean);
  const aggregate = { model: summaries[0]?.model ?? "unknown", scenarios: summaries.length, turns: summaries.reduce((sum: number, item: any) => sum + item.turns, 0), perfectTurns: summaries.reduce((sum: number, item: any) => sum + item.perfectTurns, 0), weightedScore: summaries.reduce((sum: number, item: any) => sum + item.weightedScore, 0), possible: summaries.reduce((sum: number, item: any) => sum + item.possible, 0), falseActions: summaries.reduce((sum: number, item: any) => sum + item.falseActions, 0), generatedAt: new Date().toISOString() };
  const passRate = aggregate.weightedScore / Math.max(1, aggregate.possible); writeFileSync(join(out, "summary.json"), JSON.stringify({ ...aggregate, passRate }, null, 2));
  for (const id of selected) { const results = join(out, id, "results.jsonl"); if (existsSync(results)) appendFileSync(join(out, "results.jsonl"), readFileSync(results)); }
  writeFileSync(join(root, "bench-results", "real-world-latest.txt"), out);
  console.log(`\nAGGREGATE: ${(passRate * 100).toFixed(1)}%, ${aggregate.perfectTurns}/${aggregate.turns} perfect turns, ${aggregate.falseActions} false actions`); console.log(`Summary: ${join(out, "summary.json")}`);
  if (!allowFailures && (failed || passRate < .95 || aggregate.falseActions > 0)) process.exitCode = 1;
}
