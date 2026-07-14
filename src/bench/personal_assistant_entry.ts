/** Parent bootstrap: runs exactly one persona conversation per child process. */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PERSONAL_ASSISTANT_SCENARIOS } from "./personal_assistant_scenarios.ts";
import { failureIndex, generatePersonalReport, passesNineGate, personalSummary, type PersonalTurnRecord } from "./personal_assistant_report.ts";

const argv = process.argv.slice(2); const value = (flag: string) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; }; const child = argv.includes("--child");
if (argv.includes("--list")) {
  console.log("Personal Assistant 9/10 benchmark corpus (strictly sequential):");
  for (const scenario of PERSONAL_ASSISTANT_SCENARIOS) console.log(`- ${scenario.id}: ${scenario.persona} / ${scenario.kind} / ${scenario.turns.length} turns${scenario.turns.some((t) => t.longContext) ? " / long-context" : ""}`);
  const turns = PERSONAL_ASSISTANT_SCENARIOS.reduce((n, s) => n + s.turns.length, 0); console.log(`Total: ${PERSONAL_ASSISTANT_SCENARIOS.length} conversations, ${turns} turns. Expected local-model wall time: roughly 3–7 hours (hardware/model dependent).`);
} else if (child) {
  const out = process.env.SOPHIE_PERSONAL_BENCH_OUT; const home = process.env.SOPHIE_HOME; if (!out || !home || process.env.HOME !== home) throw new Error("Benchmark child requires matching isolated HOME and SOPHIE_HOME.");
  mkdirSync(join(home, ".sophie"), { recursive: true }); process.env.SOPHIE_EPISODES_DIR = join(home, ".sophie", "episodes");
  const { runPersonalAssistantBenchmark } = await import("./personal_assistant_benchmark.ts"); await runPersonalAssistantBenchmark();
} else {
  const root = process.cwd(); const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19); const out = process.env.SOPHIE_PERSONAL_BENCH_OUT ?? join(root, "bench-results", `${stamp}-personal-assistant`); mkdirSync(out, { recursive: true });
  const requested = value("--scenario")?.split(",").filter(Boolean); const selected = requested?.length ? PERSONAL_ASSISTANT_SCENARIOS.filter((s) => requested.includes(s.id)) : PERSONAL_ASSISTANT_SCENARIOS; if (!selected.length) throw new Error(`No matching persona. Available: ${PERSONAL_ASSISTANT_SCENARIOS.map((s) => s.id).join(", ")}`);
  const maxTurns = value("--max-turns"); const allowFailures = argv.includes("--allow-failures"); let childFailed = false;
  console.log(`Running ${selected.length} persona conversations sequentially. No two conversations run at the same time.`);
  for (const scenario of selected) {
    const scenarioOut = join(out, scenario.id); const home = join(scenarioOut, "isolated-home"); mkdirSync(join(home, ".sophie"), { recursive: true });
    const env: Record<string, string> = { ...process.env as Record<string, string>, HOME: home, SOPHIE_HOME: home, SOPHIE_PERSONAL_BENCH_OUT: scenarioOut, SOPHIE_API_KEY: process.env.SOPHIE_API_KEY || "local", SOPHIE_EMAIL_ADDRESS: "benchmark-disabled@example.invalid", SOPHIE_EMAIL_APP_PASSWORD: "BENCHMARK_DISABLED", TELEGRAM_BOT_TOKEN: "BENCHMARK_DISABLED", TAVILY_API_KEY: "BENCHMARK_DISABLED", BRAVE_API_KEY: "BENCHMARK_DISABLED", SOPHIE_SPEAK_REPLIES: "0", SOPHIE_TTS_AUTOSTART: "0", SOPHIE_EMBEDDINGS: "0", SOPHIE_DREAM: "0", ...(scenario.kind === "limited_hardware" ? { SOPHIE_RESOURCE_PROFILE: "small", SOPHIE_MAX_HISTORY_TOKENS: "8000", SOPHIE_MAX_TOKENS: "2048" } : {}) };
    const args = [process.execPath, import.meta.path, "--child", "--scenario", scenario.id, ...(maxTurns ? ["--max-turns", maxTurns] : []), ...(allowFailures ? ["--allow-failures"] : [])];
    const proc = Bun.spawn(args, { cwd: root, env, stdout: "inherit", stderr: "inherit" }); if (await proc.exited !== 0) childFailed = true;
  }
  const records: PersonalTurnRecord[] = []; for (const scenario of selected) { const path = join(out, scenario.id, "results.jsonl"); if (!existsSync(path)) continue; const rows = readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as PersonalTurnRecord); for (const row of rows) { row.transcriptRef = `${scenario.id}/${row.transcriptRef}`; row.resultsLine = records.length + 1; records.push(row); appendFileSync(join(out, "results.jsonl"), `${JSON.stringify(row)}\n`); } }
  const first = selected.map((s) => join(out, s.id, "summary.json")).find(existsSync); const childSummary = first ? JSON.parse(readFileSync(first, "utf8")) : { model: "unknown", baseUrl: "unknown" }; const summary = personalSummary(records, childSummary.model, childSummary.baseUrl);
  writeFileSync(join(out, "summary.json"), JSON.stringify(summary, null, 2)); writeFileSync(join(out, "report.md"), generatePersonalReport(records, summary)); writeFileSync(join(out, "failure-index.json"), JSON.stringify(failureIndex(records), null, 2)); writeFileSync(join(root, "bench-results", "personal-assistant-latest.txt"), out);
  console.log(`\nAGGREGATE ${summary.score10.toFixed(1)}/10; minimum field ${summary.minimumFieldScore10.toFixed(1)}/10; ${summary.perfectTurns}/${summary.turns} perfect; ${summary.falseActions} false actions.`); console.log(`Report: ${join(out, "report.md")}`);
  if (!allowFailures && (childFailed || !passesNineGate(summary))) process.exitCode = 1;
}
