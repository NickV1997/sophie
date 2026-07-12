/**
 * Sophie end-to-end benchmark.
 *
 * Drives real conversations through the live Agent runtime (talking to the
 * configured local model), exercises every tool group through a safety guard
 * that keeps side effects off the real world, records everything that happens,
 * and writes a failure-analysis report that maps problems back to source files.
 *
 *   bun run src/bench/sophie_benchmark.ts                # run all 110
 *   bun run src/bench/sophie_benchmark.ts --limit 20     # first 20
 *   bun run src/bench/sophie_benchmark.ts --ids chat-01,bash-01
 *   bun run src/bench/sophie_benchmark.ts --category web,calc
 *   bun run src/bench/sophie_benchmark.ts --quick        # quick cases only
 *
 * Output goes to <repo>/bench-results/<timestamp>/ : results.jsonl (raw),
 * report.md (analysis), and summary.json. results.jsonl is appended per case so
 * a partial run still yields a report.
 */

import { existsSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Agent, type ApprovalDecision, type ToolCallEvent } from "../agent/agent.ts";
import { setMode } from "../agent/mode.ts";
import { clearTasks } from "../agent/tasks.ts";
import { config, REPO_ROOT } from "../config.ts";
import type { ToolResult } from "../tools/types.ts";
import { installGuard, type GuardEvent } from "./guard.ts";
import { QUESTIONS, type ArtifactCheck, type BenchQuestion, type Complexity } from "./questions.ts";
import { generateReport, type CaseRecord } from "./report.ts";
import { buildBenchSummary } from "./summary.ts";
import { scoreActionQuality, type ActionObservation } from "./action_quality.ts";
import { getTurnStats } from "../agent/stats.ts";
import { buildPerformanceSummary } from "./performance.ts";

const TIMEOUT_MS: Record<Complexity, number> = {
  quick: 90_000,
  medium: 200_000,
  long: 420_000,
};

function parseArgs(argv: string[]) {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  return {
    limit: get("--limit") ? Number(get("--limit")) : undefined,
    ids: get("--ids")?.split(",").map((s) => s.trim()),
    categories: get("--category")?.split(",").map((s) => s.trim()),
    quick: argv.includes("--quick"),
    noReport: argv.includes("--no-report"),
    allowFailures: argv.includes("--allow-failures"),
  };
}

function selectQuestions(): BenchQuestion[] {
  const args = parseArgs(process.argv.slice(2));
  let qs = [...QUESTIONS];
  if (args.ids) qs = qs.filter((q) => args.ids!.includes(q.id));
  if (args.categories) qs = qs.filter((q) => args.categories!.includes(q.category));
  if (args.quick) qs = qs.filter((q) => q.complexity === "quick");
  if (args.limit) qs = qs.slice(0, args.limit);
  return qs;
}

/** Seed the sandbox with files the read/edit prompts reference. */
function seedSandbox(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "notes.txt"), "Project notes\n- TODO: finish the benchmark harness\n- reviewed the tool registry\nThis file exists so read/grep prompts have something to find.\n");
  writeFileSync(join(dir, "sample.ts"), "// sample TypeScript file\nexport function add(a: number, b: number): number {\n  return a + b; // TODO: handle overflow\n}\n");
  writeFileSync(
    join(dir, "README.md"),
    "# Sandbox Project\n\nSophie is a local-first terminal AI assistant agent — a mini Claude Code powered by a local model.\n\nThis sandbox exists purely for the benchmark.\n",
  );
  writeFileSync(join(dir, "data.txt"), "42\n");
}

async function runCase(q: BenchQuestion, sandbox: string, guardEvents: GuardEvent[]): Promise<CaseRecord> {
  process.chdir(sandbox);
  setMode(q.mode ?? "normal");
  clearTasks();
  guardEvents.length = 0;

  const agent = new Agent();
  agent.reset();
  setMode(q.mode ?? "normal");

  const tools: string[] = [];
  const toolCalls: { name: string; args: Record<string, unknown>; summary: string }[] = [];
  const toolErrors: { tool: string; message: string }[] = [];
  const agentErrors: string[] = [];
  const toolNameById = new Map<string, string>();
  const actionById = new Map<string, ActionObservation>();
  let answer = "";
  let toolRounds = 0;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS[q.complexity]);
  let timedOut = false;
  controller.signal.addEventListener("abort", () => (timedOut = true), { once: true });

  const started = Date.now();
  try {
    await agent.run(
      q.prompt,
      {
        onContent(delta: string) {
          answer += delta;
        },
        onToolCall(call: ToolCallEvent) {
          tools.push(call.name);
          toolCalls.push({ name: call.name, args: call.args, summary: call.summary });
          toolNameById.set(call.id, call.name);
          actionById.set(call.id, { name: call.name, args: call.args, risk: call.risk, approved: call.risk === "safe" });
          toolRounds++;
        },
        onToolResult(id: string, result: ToolResult) {
          const observation = actionById.get(id);
          if (observation) observation.succeeded = !result.isError;
          if (result.isError) {
            toolErrors.push({ tool: toolNameById.get(id) ?? "?", message: (result.display ?? result.content ?? "").slice(0, 300) });
          }
        },
        requestApproval: async (event): Promise<ApprovalDecision> => {
          const observation = actionById.get(event.id);
          if (observation) observation.approved = true;
          return "approve";
        },
        onError(message: string) {
          agentErrors.push(message.slice(0, 500));
        },
      },
      controller.signal,
    );
  } catch (e: any) {
    agentErrors.push(`threw: ${e?.message ?? e}`);
  } finally {
    clearTimeout(timeout);
  }
  const durationMs = Date.now() - started;

  const checks = scoreCase(q, sandbox, { tools, toolErrors, agentErrors, answer, guardEvents, timedOut });
  const ok = checks.every((c) => c.pass);
  const actionQuality = scoreActionQuality([...actionById.values()], /(?:completed|done|finished|successfully)/i.test(answer));
  const runtime = getTurnStats();

  return {
    id: q.id,
    category: q.category,
    complexity: q.complexity,
    prompt: q.prompt,
    mode: q.mode ?? "normal",
    ok,
    durationMs,
    timedOut,
    tools,
    toolCalls,
    toolRounds,
    toolErrors,
    agentErrors,
    guard: guardEvents.filter((e) => e.action !== "allow").map((e) => ({ tool: e.tool, action: e.action, reason: e.reason })),
    checks,
    answerChars: answer.replace(/\s+/g, " ").trim().length,
    answerPreview: answer.replace(/\s+/g, " ").trim().slice(0, 400),
    falseAction: actionQuality.falseAction,
    actionQuality: { unauthorizedActions: actionQuality.unauthorizedActions, duplicateActions: actionQuality.duplicateActions, falseCompletions: actionQuality.falseCompletions, failedActions: actionQuality.failedActions },
    runtime: { promptTokens: runtime.promptTokens, modelRequests: runtime.modelRequests ?? 0, ...(runtime.firstTokenMs !== undefined ? { firstTokenMs: runtime.firstTokenMs } : {}) },
  };
}

function scoreCase(
  q: BenchQuestion,
  sandbox: string,
  ctx: { tools: string[]; toolErrors: { tool: string; message: string }[]; agentErrors: string[]; answer: string; guardEvents: GuardEvent[]; timedOut: boolean },
): { name: string; pass: boolean; detail: string }[] {
  const checks: { name: string; pass: boolean; detail: string }[] = [];
  const answerText = ctx.answer.replace(/\s+/g, " ").trim();

  if (q.expectAny?.length) {
    const hit = q.expectAny.filter((t) => ctx.tools.includes(t));
    checks.push({
      name: "expected-tool",
      pass: hit.length > 0,
      detail: hit.length ? `used ${hit.join(", ")}` : `used none of [${q.expectAny.join(", ")}]; called [${[...new Set(ctx.tools)].join(", ") || "none"}]`,
    });
  }
  if (q.ban?.length) {
    const used = q.ban.filter((t) => ctx.tools.includes(t));
    checks.push({ name: "no-banned-tool", pass: used.length === 0, detail: used.length ? `used banned ${used.join(", ")}` : "clean" });
  }
  if (q.mustAnswer !== false) {
    checks.push({ name: "produced-answer", pass: answerText.length > 0, detail: answerText.length ? `${answerText.length} chars` : "empty final answer" });
  }
  checks.push({ name: "no-agent-error", pass: ctx.agentErrors.length === 0, detail: ctx.agentErrors[0] ?? "clean" });
  checks.push({ name: "no-timeout", pass: !ctx.timedOut, detail: ctx.timedOut ? `timed out (${TIMEOUT_MS[q.complexity] / 1000}s)` : "within budget" });
  // Every tool error is a signal, but not always a case failure (e.g. reading a
  // missing file is expected). Track separately: fail only if the tool erroring
  // was one the case expected to succeed.
  const expectedUsed = (q.expectAny ?? []).filter((tool) => ctx.tools.includes(tool));
  const errorsByTool = new Map<string, { tool: string; message: string }[]>();
  for (const error of ctx.toolErrors) {
    errorsByTool.set(error.tool, [...(errorsByTool.get(error.tool) ?? []), error]);
  }
  const successfulExpected = expectedUsed.filter((tool) => ctx.tools.filter((t) => t === tool).length > (errorsByTool.get(tool)?.length ?? 0));
  const failedExpected = expectedUsed.filter((tool) => !successfulExpected.includes(tool) && errorsByTool.has(tool));
  const firstFailed = failedExpected.length ? errorsByTool.get(failedExpected[0]!)?.[0] : undefined;
  checks.push({
    name: "expected-tool-succeeded",
    pass: expectedUsed.length === 0 || successfulExpected.length > 0,
    detail: successfulExpected.length
      ? `succeeded ${successfulExpected.join(", ")}`
      : firstFailed
        ? `${firstFailed.tool}: ${firstFailed.message}`
        : "ok",
  });
  for (const artifact of q.artifacts ?? []) checks.push(scoreArtifact(sandbox, artifact));
  return checks;
}

function scoreArtifact(sandbox: string, artifact: ArtifactCheck): { name: string; pass: boolean; detail: string } {
  const candidates = [artifact.path, ...(artifact.alternatives ?? [])];
  const rel = candidates.find((candidate) => existsSync(join(sandbox, candidate)));
  if (!rel) {
    return {
      name: "artifact",
      pass: false,
      detail: candidates.length === 1 ? `missing ${artifact.path}` : `missing any of [${candidates.join(", ")}]`,
    };
  }
  const path = join(sandbox, rel);
  const stat = statSync(path);
  if (artifact.kind === "file" && !stat.isFile()) return { name: "artifact", pass: false, detail: `${rel} is not a file` };
  if (artifact.kind === "dir" && !stat.isDirectory()) return { name: "artifact", pass: false, detail: `${rel} is not a directory` };

  const failures: string[] = [];
  if (artifact.contains?.length) {
    if (!stat.isFile()) {
      failures.push("content check requires a file");
    } else {
      const text = readFileSync(path, "utf8").toLowerCase();
      const missing = artifact.contains.filter((s) => !text.includes(s.toLowerCase()));
      if (missing.length) failures.push(`missing text: ${missing.join(", ")}`);
    }
  }
  if (artifact.packageScripts?.length) {
    if (!stat.isFile()) {
      failures.push("package script check requires a file");
    } else {
      try {
        const pkg = JSON.parse(readFileSync(path, "utf8")) as { scripts?: Record<string, string> };
        const missing = artifact.packageScripts.filter((script) => !pkg.scripts?.[script]);
        if (missing.length) failures.push(`missing package script(s): ${missing.join(", ")}`);
      } catch (e: any) {
        failures.push(`invalid package.json: ${e?.message ?? e}`);
      }
    }
  }
  return {
    name: "artifact",
    pass: failures.length === 0,
    detail: failures.length ? `${rel}: ${failures.join("; ")}` : `${rel} ok`,
  };
}

function loadRecords(dir: string): CaseRecord[] {
  const fs = require("node:fs");
  return fs.readFileSync(join(dir, "results.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l: string) => JSON.parse(l)) as CaseRecord[];
}

/** Merge a re-run's records over a base run (by case id), then write a fresh
 *  merged dir with results.jsonl, summary.json and report.md. */
function merge(baseDir: string, rerunDir: string): void {
  const fs = require("node:fs");
  const base = loadRecords(baseDir);
  const rerun = new Map(loadRecords(rerunDir).map((r) => [r.id, r]));
  const merged = base.map((r) => rerun.get(r.id) ?? r);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outDir = join(REPO_ROOT, "bench-results", `${stamp}-merged`);
  mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(join(outDir, "results.jsonl"), merged.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const summary = buildBenchSummary(merged, { model: config.model, baseUrl: config.baseUrl });
  fs.writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  fs.writeFileSync(join(outDir, "report.md"), generateReport(merged, summary));
  fs.writeFileSync(join(REPO_ROOT, "bench-results", "latest.txt"), outDir);
  console.log(`Merged ${rerun.size} re-run records over ${base.length} base → ${outDir}`);
  console.log(`${summary.passed}/${summary.total} passed (${(summary.passRate * 100).toFixed(0)}%)`);
}

/** Rebuild report.md from an existing results.jsonl without re-running cases. */
function regen(dir: string): void {
  const records = require("node:fs").readFileSync(join(dir, "results.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l: string) => JSON.parse(l)) as CaseRecord[];
  const summary = JSON.parse(require("node:fs").readFileSync(join(dir, "summary.json"), "utf8"));
  writeFileSync(join(dir, "report.md"), generateReport(records, summary));
  console.log(`Regenerated ${join(dir, "report.md")} from ${records.length} records`);
}

async function main() {
  const regenDir = process.argv[process.argv.indexOf("--regen") + 1];
  if (process.argv.includes("--regen") && regenDir) {
    regen(regenDir);
    return;
  }
  if (process.argv.includes("--merge")) {
    const i = process.argv.indexOf("--merge");
    const baseDir = process.argv[i + 1];
    const rerunDir = process.argv[i + 2];
    if (!baseDir || !rerunDir) throw new Error("--merge needs <baseDir> <rerunDir>");
    merge(baseDir, rerunDir);
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outDir = join(REPO_ROOT, "bench-results", stamp);
  mkdirSync(outDir, { recursive: true });
  const homeDir = join(outDir, "home");
  mkdirSync(join(homeDir, ".sophie"), { recursive: true });
  process.env.SOPHIE_HOME = homeDir;
  process.env.SOPHIE_EPISODES_DIR = join(homeDir, ".sophie", "episodes");
  const sandbox = join(outDir, "sandbox");
  seedSandbox(sandbox);
  const jsonlPath = join(outDir, "results.jsonl");

  const questions = selectQuestions();
  const guard = installGuard();

  console.log(`Sophie benchmark → ${outDir}`);
  console.log(`model: ${config.model}`);
  console.log(`base:  ${config.baseUrl}`);
  console.log(`cases: ${questions.length}\n`);

  const records: CaseRecord[] = [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]!;
    process.stdout.write(`[${i + 1}/${questions.length}] ${q.id} (${q.complexity}/${q.category}) ... `);
    let rec: CaseRecord;
    try {
      rec = await runCase(q, sandbox, guard.events);
    } catch (e: any) {
      rec = {
        id: q.id, category: q.category, complexity: q.complexity, prompt: q.prompt, mode: q.mode ?? "normal",
        ok: false, durationMs: 0, timedOut: false, tools: [], toolCalls: [], toolRounds: 0, toolErrors: [],
        agentErrors: [`harness threw: ${e?.message ?? e}`], guard: [], checks: [{ name: "harness", pass: false, detail: String(e?.message ?? e) }],
        answerChars: 0, answerPreview: "",
      };
    }
    records.push(rec);
    appendFileSync(jsonlPath, JSON.stringify(rec) + "\n");
    const failed = rec.checks.filter((c) => !c.pass);
    console.log(`${rec.ok ? "PASS" : "FAIL"} ${(rec.durationMs / 1000).toFixed(0)}s tools:${rec.tools.length}${failed.length ? " — " + failed.map((c) => c.name).join(",") : ""}`);
  }

  guard.uninstall();

  const summary = buildBenchSummary(records, { model: config.model, baseUrl: config.baseUrl });
  writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  writeFileSync(join(outDir, "performance.json"), JSON.stringify(buildPerformanceSummary(records, config.model), null, 2));

  if (!parseArgs(process.argv.slice(2)).noReport) {
    const report = generateReport(records, summary);
    writeFileSync(join(outDir, "report.md"), report);
    console.log(`\nReport: ${join(outDir, "report.md")}`);
  }
  console.log(`\n${summary.passed}/${summary.total} passed (${(summary.passRate * 100).toFixed(0)}%)`);
  console.log(`Raw:    ${jsonlPath}`);
  // Expose the output dir for wrapping scripts.
  writeFileSync(join(REPO_ROOT, "bench-results", "latest.txt"), outDir);
  process.exitCode = parseArgs(process.argv.slice(2)).allowFailures || summary.passed === summary.total ? 0 : 1;
}

main();
