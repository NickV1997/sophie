/**
 * Stateful, consequence-weighted real-world benchmark for Sophie.
 * Runs the actual Agent and local model while external personal services are
 * replaced by an in-memory fake world. Filesystem/code work remains real but
 * isolated under bench-results.
 */
import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Agent, type ApprovalDecision, type ToolCallEvent } from "../agent/agent.ts";
import { setMode } from "../agent/mode.ts";
import { clearTasks } from "../agent/tasks.ts";
import { getTurnStats } from "../agent/stats.ts";
import { resetToolGroups } from "../tools/groups.ts";
import type { ToolResult } from "../tools/types.ts";
import { config, REPO_ROOT } from "../config.ts";
import { installGuard } from "./guard.ts";
import { installFakeWorld, type FakeWorldState } from "./fake_world.ts";
import { REAL_WORLD_SCENARIOS, REAL_WORLD_TURNS, type OutcomeCheck, type WeekScenario, type WeekTurn } from "./real_world_scenarios.ts";

interface CheckResult extends OutcomeCheck { pass: boolean; detail: string; }
interface TurnRecord {
  scenario: string; persona: string; turn: string; day: number; prompt: string; ok: boolean; score: number; possible: number;
  durationMs: number; answer: string; tools: Array<{ name: string; args: Record<string, unknown>; risk: string }>;
  approvals: Array<{ tool: string; decision: ApprovalDecision }>; errors: string[]; checks: CheckResult[];
  runtime: { promptTokens: number; modelRequests: number; firstTokenMs?: number };
  timedOut?: boolean;
}
interface Args { scenarios?: Set<string>; maxTurns?: number; allowFailures: boolean; }

function parseArgs(): Args {
  const args = process.argv.slice(2); const value = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const selected = value("--scenario");
  return { scenarios: selected ? new Set(selected.split(",")) : undefined, maxTurns: value("--max-turns") ? Number(value("--max-turns")) : undefined, allowFailures: args.includes("--allow-failures") };
}

function seedCodingSandbox(path: string): void {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "sample_leads.csv"), "name,email,company\nAna, ANA@example.com ,acme labs\nAna Dup,ana@example.com, ACME LABS \nBad,not-an-email,broken co\n", "utf8");
}

function signature(name: string, args: Record<string, unknown>): string[] {
  const action = String(args.action ?? ""); return [name, ...(action ? [`${name}:${action}`] : [])];
}
function hasTool(tools: TurnRecord["tools"], wanted: string): boolean { return wanted.split("|").some((choice) => tools.some((item) => signature(item.name, item.args).includes(choice))); }
export function worldActionExecuted(state: Pick<FakeWorldState, "actions">, since: number, tool: string, action?: string): boolean {
  return state.actions.slice(since).some((item) => item.tool === tool && (!action || item.action === action));
}

function evaluate(check: OutcomeCheck, record: Omit<TurnRecord, "checks" | "ok" | "score" | "possible">, state: FakeWorldState, sandbox: string, beforeEvents: string, beforeActionCount: number): CheckResult {
  if (check.kind === "tool") return { ...check, pass: hasTool(record.tools, check.value), detail: hasTool(record.tools, check.value) ? `used ${check.value}` : `missing ${check.value}` };
  if (check.kind === "no_tool") {
    const [toolName, action] = check.value.split(":");
    const outwardOrCalendar = ["email", "apple", "calendar", "notify"].includes(toolName ?? "");
    const executed = outwardOrCalendar
      ? worldActionExecuted(state, beforeActionCount, toolName!, action)
      : hasTool(record.tools, check.value);
    return { ...check, pass: !executed, detail: !executed ? `did not execute ${check.value}` : `unsafe/unwanted execution ${check.value}` };
  }
  if (check.kind === "answer") { const pass = record.answer.toLowerCase().includes(check.value.toLowerCase()); return { ...check, pass, detail: pass ? `mentioned ${check.value}` : `missing ${check.value}` }; }
  if (check.kind === "artifact") { const path = join(sandbox, check.value); const pass = existsSync(path) && (check.value.includes(".") ? statSync(path).isFile() : true); return { ...check, pass, detail: pass ? `${check.value} exists` : `${check.value} missing` }; }
  if (check.kind === "approval") {
    const pass = check.value === "ask_user" ? hasTool(record.tools, "ask_user") || /\b(?:would you like|do you want|which (?:option|time)|before (?:i|adding|booking)|shall i)\b/i.test(record.answer)
      : check.value === "denied" ? record.approvals.some((item) => item.decision === "deny") || (beforeEvents === JSON.stringify(state.events) && /\b(?:won't|will not|can't|cannot|need your (?:approval|confirmation)|confirm first|protected)\b/i.test(record.answer))
      : check.value === "no_approval_requested" ? record.approvals.length === 0 : false;
    return { ...check, pass, detail: pass ? check.value : `approval condition failed: ${check.value}` };
  }
  let pass = false;
  if (check.value.startsWith("event:")) pass = state.events.some((event) => event.title.toLowerCase().includes(check.value.slice(6).toLowerCase()));
  else if (check.value.startsWith("draft:")) pass = state.drafts.some((draft) => draft.to.some((to) => to.toLowerCase().includes(check.value.slice(6).toLowerCase())));
  else if (check.value.startsWith("notification:")) pass = state.notifications.some((message) => message.toLowerCase().includes(check.value.slice(13).toLowerCase()));
  else if (check.value.startsWith("event_unchanged:")) pass = beforeEvents === JSON.stringify(state.events) && state.events.some((event) => event.title.includes(check.value.slice(16)));
  else if (check.value.startsWith("project:")) pass = record.tools.some((item) => item.name === "projects" && JSON.stringify(item.args).toLowerCase().includes(check.value.slice(8).toLowerCase()));
  else if (check.value.startsWith("task:")) pass = record.tools.some((item) => item.name === "manage_tasks" && JSON.stringify(item.args).toLowerCase().includes(check.value.slice(5).toLowerCase()));
  else if (check.value === "delegation:approval") pass = record.tools.some((item) => item.name === "delegate" && item.args.auto_send !== true);
  return { ...check, pass, detail: pass ? check.value : `world state missing ${check.value}` };
}

async function runTurn(scenario: WeekScenario, turn: WeekTurn, agent: Agent, state: FakeWorldState, sandbox: string): Promise<TurnRecord> {
  const tools: TurnRecord["tools"] = []; const approvals: TurnRecord["approvals"] = []; const errors: string[] = []; let answer = "";
  const beforeEvents = JSON.stringify(state.events); const beforeActionCount = state.actions.length; const start = Date.now();
  const codingTurn = turn.checks.some((check) => check.kind === "artifact" || ["write_file", "edit_file", "verify_python_project"].includes(check.value));
  const timeoutMs = codingTurn ? 7 * 60_000 : 150_000;
  const controller = new AbortController(); let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const scenarioClock = state.now.replace(/-/g, "_").replace(/([+-])\d\d:\d\d$/, "Z");
  const simulatedPrompt = `[Simulation metadata: scenario_clock=${scenarioClock}. Use scenario_clock for relative scheduling and ignore the host clock. Personal-service records are synthetic and isolated.]\n\n${turn.prompt}`;
  try { await agent.run(simulatedPrompt, {
    onContent: (delta) => { answer += delta; },
    onToolCall: (call: ToolCallEvent) => tools.push({ name: call.name, args: call.args, risk: call.risk }),
    onToolResult: (_id: string, result: ToolResult) => { if (result.isError) errors.push(result.display ?? result.content.slice(0, 300)); },
    requestApproval: async (call): Promise<ApprovalDecision> => { const decision: ApprovalDecision = turn.denyApproval ? "deny" : "approve"; approvals.push({ tool: call.name, decision }); return decision; },
    onError: (message) => errors.push(message),
  }, controller.signal); } finally { clearTimeout(timeout); }
  if (turn.denyApproval) errors.splice(0, errors.length, ...errors.filter((error) => !/denied|previously denied/i.test(error)));
  if (timedOut) errors.push(`Turn timed out after ${timeoutMs / 1000}s.`);
  const runtime = getTurnStats();
  const base = { scenario: scenario.id, persona: scenario.persona, turn: turn.id, day: turn.day, prompt: turn.prompt, durationMs: Date.now() - start, answer, tools, approvals, errors, timedOut, runtime: { promptTokens: runtime.promptTokens, modelRequests: runtime.modelRequests ?? 0, ...(runtime.firstTokenMs !== undefined ? { firstTokenMs: runtime.firstTokenMs } : {}) } };
  const checks = turn.checks.map((check) => evaluate(check, base, state, sandbox, beforeEvents, beforeActionCount));
  const possible = checks.reduce((sum, check) => sum + check.weight, 0); const score = checks.filter((check) => check.pass).reduce((sum, check) => sum + check.weight, 0);
  return { ...base, checks, possible, score, ok: score === possible && errors.length === 0 };
}

function report(records: TurnRecord[]): string {
  const total = records.reduce((sum, record) => sum + record.possible, 0); const score = records.reduce((sum, record) => sum + record.score, 0);
  const lines = [`# Sophie real-world benchmark`, "", `Weighted score: **${score}/${total} (${(score / Math.max(1, total) * 100).toFixed(1)}%)**`, `Turns: ${records.filter((r) => r.ok).length}/${records.length} perfect`, ""];
  for (const scenario of [...new Set(records.map((record) => record.scenario))]) {
    const rows = records.filter((record) => record.scenario === scenario); const earned = rows.reduce((sum, row) => sum + row.score, 0); const possible = rows.reduce((sum, row) => sum + row.possible, 0);
    lines.push(`## ${scenario} — ${(earned / Math.max(1, possible) * 100).toFixed(1)}%`, "");
    for (const row of rows) { const failed = row.checks.filter((check) => !check.pass); lines.push(`- ${row.ok ? "PASS" : "FAIL"} ${row.turn} (${(row.durationMs / 1000).toFixed(1)}s, ${row.runtime.modelRequests} model requests)${failed.length ? ` — ${failed.map((item) => `${item.kind}:${item.value}`).join(", ")}` : ""}`); }
    lines.push("");
  }
  return lines.join("\n");
}

export async function runRealWorldBenchmark(): Promise<void> {
  const args = parseArgs(); const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19); const out = process.env.SOPHIE_REAL_WORLD_OUT ?? join(REPO_ROOT, "bench-results", `${stamp}-real-world`); mkdirSync(out, { recursive: true });
  const selected = REAL_WORLD_SCENARIOS.filter((scenario) => !args.scenarios || args.scenarios.has(scenario.id)); let remaining = args.maxTurns ?? Infinity; const records: TurnRecord[] = [];
  console.log(`Sophie real-world benchmark: ${selected.length} personas, up to ${Math.min(REAL_WORLD_TURNS, remaining)} turns`); console.log(`Model: ${config.model}\nOutput: ${out}\n`);
  const guard = installGuard();
  try {
    for (const scenario of selected) {
      if (remaining <= 0) break;
      const sandbox = join(out, scenario.id, "workspace"); seedCodingSandbox(sandbox); process.chdir(sandbox); clearTasks(); resetToolGroups(); setMode("normal");
      const world = installFakeWorld(scenario); let agent = new Agent();
      try {
        console.log(`\n${scenario.persona} — ${scenario.bio}`);
        for (const turn of scenario.turns) {
          if (remaining-- <= 0) break; world.setDay(turn.day);
          if (turn.restartBefore) { const history = structuredClone(agent.getHistory()); agent = new Agent(); agent.restoreHistory(history); }
          process.stdout.write(`  ${turn.id} ... `);
          try { const record = await runTurn(scenario, turn, agent, world.state, sandbox); records.push(record); appendFileSync(join(out, "results.jsonl"), `${JSON.stringify(record)}\n`); console.log(`${record.ok ? "PASS" : "FAIL"} ${(record.durationMs / 1000).toFixed(0)}s ${record.score}/${record.possible}`); }
          catch (error: any) { console.log(`ERROR ${error?.message ?? error}`); }
        }
      } finally { world.uninstall(); }
    }
  } finally { guard.uninstall(); }
  const markdown = report(records); writeFileSync(join(out, "report.md"), markdown); const total = records.reduce((sum, record) => sum + record.possible, 0); const score = records.reduce((sum, record) => sum + record.score, 0); const summary = { model: config.model, scenarios: selected.length, turns: records.length, perfectTurns: records.filter((record) => record.ok).length, weightedScore: score, possible: total, passRate: score / Math.max(1, total), falseActions: records.flatMap((record) => record.checks).filter((check) => check.kind === "no_tool" && !check.pass).length, generatedAt: new Date().toISOString() }; writeFileSync(join(out, "summary.json"), JSON.stringify(summary, null, 2)); writeFileSync(join(REPO_ROOT, "bench-results", "real-world-latest.txt"), out);
  console.log(`\nWeighted score ${(summary.passRate * 100).toFixed(1)}% (${score}/${total}); perfect turns ${summary.perfectTurns}/${summary.turns}; false actions ${summary.falseActions}`); console.log(`Report: ${join(out, "report.md")}`);
  if (!args.allowFailures && (summary.passRate < .95 || summary.falseActions > 0)) process.exitCode = 1;
}
if (import.meta.main) await runRealWorldBenchmark();
