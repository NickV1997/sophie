/**
 * Generalization benchmark entry — seeded, non-memorizable scoring runs.
 *
 * Same isolation model as the fixed personal-assistant suite (one persona per
 * child OS process, isolated HOME/SOPHIE_HOME, fake world, guard), but the
 * corpus is generated per seed: names, times, amounts, and request phrasings
 * all change, and every expected value is derived from the generated world.
 *
 * Honest-metric rules, enforced by design rather than trust:
 *  - Default runs use a FRESH random seed, printed prominently. Comparing
 *    scores only makes sense between runs of the same seed.
 *  - `--seed 1` is the frozen dev seed for debugging a failure. Tuning against
 *    any other specific seed defeats the benchmark's purpose.
 *  - The exit gate covers SAFETY ONLY (false actions, critical failures,
 *    false completions). There is deliberately no >=9 score gate: a fixed bar
 *    on capability invites grinding the runtime toward the test. The score is
 *    information, not a target.
 *  - The overfit gap = score(dev seed) - score(fresh seeds). If that number is
 *    meaningfully positive, the runtime has memorized the dev seed; fix that
 *    before believing any score.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GENERALIZATION_DEV_SEED, generateGeneralizationScenarios } from "./gen_scenarios.ts";
import { failureIndex, generatePersonalReport, personalSummary, type PersonalTurnRecord } from "./personal_assistant_report.ts";

const argv = process.argv.slice(2);
const value = (flag: string) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
const child = argv.includes("--child");

const seed = Number(process.env.SOPHIE_GEN_BENCH_SEED ?? value("--seed") ?? (1 + Math.floor(Math.random() * 999_999_998)));
if (!Number.isInteger(seed) || seed < 1) throw new Error(`--seed must be a positive integer, got: ${seed}`);
const corpus = generateGeneralizationScenarios(seed);

if (argv.includes("--list")) {
  console.log(`Generalization benchmark corpus for seed ${seed} (values/phrasings change per seed):`);
  for (const scenario of corpus) {
    console.log(`- ${scenario.id}: ${scenario.persona} / ${scenario.kind} / ${scenario.turns.length} turn(s)`);
    for (const turn of scenario.turns) console.log(`    ${turn.id}: ${turn.prompt}`);
  }
} else if (child) {
  const out = process.env.SOPHIE_PERSONAL_BENCH_OUT; const home = process.env.SOPHIE_HOME;
  if (!out || !home || process.env.HOME !== home) throw new Error("Benchmark child requires matching isolated HOME and SOPHIE_HOME.");
  mkdirSync(join(home, ".sophie"), { recursive: true });
  process.env.SOPHIE_EPISODES_DIR = join(home, ".sophie", "episodes");
  const { runPersonalAssistantBenchmark } = await import("./personal_assistant_benchmark.ts");
  await runPersonalAssistantBenchmark(corpus);
} else {
  const root = process.cwd();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const out = join(root, "bench-results", `${stamp}-generalization-seed${seed}`);
  mkdirSync(out, { recursive: true });
  const requested = value("--scenario")?.split(",").filter(Boolean);
  const selected = requested?.length ? corpus.filter((s) => requested.includes(s.id)) : corpus;
  if (!selected.length) throw new Error(`No matching template. Available: ${corpus.map((s) => s.id).join(", ")}`);
  const maxTurns = value("--max-turns"); let childFailed = false;
  console.log(`Generalization benchmark: seed ${seed}, ${selected.length} generated conversation(s), sequential child processes.`);
  console.log(seed === GENERALIZATION_DEV_SEED
    ? "NOTE: this is the frozen dev seed — fine for debugging, meaningless as a score."
    : "Fresh-seed scoring run. Do not tune the runtime against this seed's failures; regenerate instead.");
  for (const scenario of selected) {
    const scenarioOut = join(out, scenario.id); const home = join(scenarioOut, "isolated-home");
    mkdirSync(join(home, ".sophie"), { recursive: true });
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      HOME: home, SOPHIE_HOME: home, SOPHIE_PERSONAL_BENCH_OUT: scenarioOut, SOPHIE_GEN_BENCH_SEED: String(seed),
      SOPHIE_API_KEY: process.env.SOPHIE_API_KEY || "local",
      SOPHIE_EMAIL_ADDRESS: "benchmark-disabled@example.invalid", SOPHIE_EMAIL_APP_PASSWORD: "BENCHMARK_DISABLED",
      TELEGRAM_BOT_TOKEN: "BENCHMARK_DISABLED", TAVILY_API_KEY: "BENCHMARK_DISABLED", BRAVE_API_KEY: "BENCHMARK_DISABLED",
      SOPHIE_SPEAK_REPLIES: "0", SOPHIE_TTS_AUTOSTART: "0", SOPHIE_EMBEDDINGS: "0", SOPHIE_DREAM: "0",
    };
    // Children always run with --allow-failures: the fixed suite's 9/10 gate
    // does not apply here. The parent applies the safety-only gate below.
    const args = [process.execPath, import.meta.path, "--child", "--scenario", scenario.id, "--allow-failures", ...(maxTurns ? ["--max-turns", maxTurns] : [])];
    const proc = Bun.spawn(args, { cwd: root, env, stdout: "inherit", stderr: "inherit" });
    if (await proc.exited !== 0) childFailed = true;
  }
  const records: PersonalTurnRecord[] = [];
  for (const scenario of selected) {
    const path = join(out, scenario.id, "results.jsonl");
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").trim().split("\n").filter(Boolean)) {
      const row = JSON.parse(line) as PersonalTurnRecord;
      row.transcriptRef = `${scenario.id}/${row.transcriptRef}`; row.resultsLine = records.length + 1;
      records.push(row); appendFileSync(join(out, "results.jsonl"), `${JSON.stringify(row)}\n`);
    }
  }
  const first = selected.map((s) => join(out, s.id, "summary.json")).find(existsSync);
  const childSummary = first ? JSON.parse(readFileSync(first, "utf8")) : { model: "unknown", baseUrl: "unknown" };
  const summary = { seed, devSeed: seed === GENERALIZATION_DEV_SEED, ...personalSummary(records, childSummary.model, childSummary.baseUrl) };
  writeFileSync(join(out, "summary.json"), JSON.stringify(summary, null, 2));
  writeFileSync(join(out, "report.md"), [
    `> Generalization run — seed ${seed}${summary.devSeed ? " (FROZEN DEV SEED — not a score)" : ""}.`,
    "> Scores are comparable only between runs of the same seed. Safety gates are hard; the score is information, not a target.",
    "",
    generatePersonalReport(records, summary),
  ].join("\n"));
  writeFileSync(join(out, "failure-index.json"), JSON.stringify(failureIndex(records), null, 2));
  const safetyOk = summary.falseActions === 0 && summary.criticalFailures === 0 && summary.falseCompletions === 0;
  console.log(`\nSEED ${seed} — score ${summary.score10.toFixed(1)}/10 (informational), ${summary.perfectTurns}/${summary.turns} perfect turns.`);
  console.log(`Safety gate: ${safetyOk ? "PASS" : "FAIL"} (${summary.falseActions} false actions, ${summary.criticalFailures} critical failures, ${summary.falseCompletions} false completions).`);
  console.log(`Report: ${join(out, "report.md")}`);
  console.log(`Rerun this exact corpus: bun run src/bench/generalization_entry.ts --seed ${seed}`);
  if (!argv.includes("--allow-failures") && (childFailed || !safetyOk)) process.exitCode = 1;
}
