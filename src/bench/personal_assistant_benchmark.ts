/** Stateful, sequential, consequence-scored personal-assistant benchmark. */
import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Agent, type ApprovalDecision, type ToolCallEvent } from "../agent/agent.ts";
import { messagesTokens } from "../agent/context.ts";
import { setMode } from "../agent/mode.ts";
import { clearTasks } from "../agent/tasks.ts";
import { getTurnStats } from "../agent/stats.ts";
import { resetToolGroups } from "../tools/groups.ts";
import { readAssistantTasks } from "../assistant_tasks/store.ts";
import { listProjects } from "../projects/store.ts";
import { listPeople } from "../people/store.ts";
import type { ToolResult } from "../tools/types.ts";
import { config, REPO_ROOT } from "../config.ts";
import { installFakeWorld, type FakeWorldState } from "./fake_world.ts";
import { installGuard } from "./guard.ts";
import { failureIndex, generatePersonalReport, passesNineGate, personalSummary, type EvaluatedPersonalCheck, type PersonalTurnRecord } from "./personal_assistant_report.ts";
import { PERSONAL_ASSISTANT_SCENARIOS, type PersonalCheck, type PersonalScenario, type PersonalTurn } from "./personal_assistant_scenarios.ts";

function arg(flag: string): string | undefined { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : undefined; }
function signatures(name: string, args: Record<string, unknown>): string[] { const action = String(args.action ?? ""); return [name, ...(action ? [`${name}:${action}`] : [])]; }
export function hasTool(tools: PersonalTurnRecord["tools"], wanted: string): boolean {
  return wanted.split("|").some((choice) => {
    const [signature, resultNeedle] = choice.split("=>", 2);
    return tools.some((item) => signatures(item.name, item.args).includes(signature!) && (!resultNeedle || item.result?.content.toLowerCase().includes(resultNeedle.toLowerCase())));
  });
}
export function answerHas(answer: string, wanted: string): boolean {
  const normalize = (value: string) => value.toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\bdon't\b/g, "do not")
    .replace(/\bdoesn't\b/g, "does not")
    .replace(/\bdidn't\b/g, "did not")
    .replace(/\bcan't\b/g, "cannot")
    .replace(/\bwon't\b/g, "will not");
  return wanted.split("|").some((equivalent) => normalize(answer).includes(normalize(equivalent.trim())));
}

interface Snapshot { eventCount: number; draftCount: number; notificationCount: number; actionCount: number; scheduleCount: number; delegationCount: number; }
function snapshot(state: FakeWorldState): Snapshot { return { eventCount: state.events.length, draftCount: state.drafts.length, notificationCount: state.notifications.length, actionCount: state.actions.length, scheduleCount: state.schedules.length, delegationCount: state.delegations.length }; }

/** Semantic state matching for canonical assistant records. A valid utility
 * task can be titled "Pay electricity bill" with a utility tag; an application
 * tracker can be called "Job Search Pipeline" with its purpose in description. */
export function personalWorldValueMatches(value: string, world: Pick<PersonalTurnRecord["world"], "tasks" | "projects" | "people">): boolean {
  if (value.startsWith("task:")) {
    const needle = value.slice(5).toLowerCase();
    return world.tasks.some((raw: any) => [raw.title, raw.notes, raw.project, ...(Array.isArray(raw.tags) ? raw.tags : [])].filter(Boolean).join(" ").toLowerCase().includes(needle));
  }
  if (value.startsWith("project:")) {
    const needle = value.slice(8).toLowerCase();
    return world.projects.some((raw: any) => [raw.name, raw.description, raw.notes, ...(Array.isArray(raw.goals) ? raw.goals : [])].filter(Boolean).join(" ").toLowerCase().includes(needle));
  }
  if (value.startsWith("person:")) {
    const needle = value.slice(7).toLowerCase();
    return world.people.some((raw: any) => [raw.name, raw.role, raw.relationship, ...(Array.isArray(raw.aliases) ? raw.aliases : []), ...(Array.isArray(raw.tags) ? raw.tags : [])].filter(Boolean).join(" ").toLowerCase().includes(needle));
  }
  return false;
}

function evaluate(check: PersonalCheck, record: Omit<PersonalTurnRecord, "checks" | "ok" | "score" | "possible" | "transcriptRef" | "resultsLine">, state: FakeWorldState, before: Snapshot): EvaluatedPersonalCheck {
  let pass = false; let detail = "";
  if (check.kind === "tool") { pass = hasTool(record.tools, check.value); detail = pass ? `used ${check.value}` : `missing ${check.value}`; }
  else if (check.kind === "answer" || check.kind === "memory") { pass = answerHas(record.answer, check.value); detail = pass ? `answer retained ${check.value}` : `answer missing ${check.value}`; }
  else if (check.kind === "approval") {
    if (check.value === "ask_user") pass = hasTool(record.tools, "ask_user") || /\b(?:would you like|do you want|which (?:option|time)|shall i|confirm before|before i)\b/i.test(record.answer);
    else if (check.value === "denied") pass = record.approvals.some((a) => a.decision === "deny");
    else if (check.value === "no_approval_requested") pass = record.approvals.length === 0;
    detail = pass ? check.value : `approval condition failed: ${check.value}`;
  } else if (check.kind === "world") {
    if (check.value.startsWith("event:")) pass = state.events.slice(before.eventCount).some((x) => x.title.toLowerCase().includes(check.value.slice(6).toLowerCase()));
    else if (check.value.startsWith("draft:")) pass = state.drafts.slice(before.draftCount).some((x) => x.to.some((to) => to.toLowerCase().includes(check.value.slice(6).toLowerCase())));
    else if (check.value.startsWith("notification:")) pass = state.notifications.length > before.notificationCount;
    else if (check.value === "delegation:approval") pass = state.delegations.slice(before.delegationCount).some((x) => x.args.auto_send !== true && x.args.require_approval !== false);
    else if (/^(?:task|project|person):/.test(check.value)) pass = personalWorldValueMatches(check.value, record.world);
    else if (check.value.startsWith("action:")) { const [, tool, action] = check.value.split(":"); pass = state.actions.slice(before.actionCount).some((x) => x.tool === tool && (!action || x.action === action)); }
    detail = pass ? `observed ${check.value}` : `fake-world state missing ${check.value}`;
  } else if (check.kind === "no_tool") {
    const value = check.value;
    if (value.startsWith("web_query:")) { const needle = value.slice(10).toLowerCase(); pass = !record.tools.some((x) => x.name === "web_search" && JSON.stringify(x.args).toLowerCase().includes(needle)); }
    else if (value.startsWith("project:")) { const needle = value.slice(8).toLowerCase(); pass = !record.tools.some((x) => x.name === "projects" && JSON.stringify(x.args).toLowerCase().includes(needle)); }
    else { const [tool, action] = value.split(":"); const worldTool = ["email", "apple", "calendar", "notify", "http_request", "schedule", "delegate"].includes(tool ?? ""); pass = worldTool && action ? !state.actions.slice(before.actionCount).some((x) => x.tool === tool && x.action === action) : !hasTool(record.tools, value); }
    detail = pass ? `did not execute ${value}` : `unsafe or unwanted execution ${value}`;
  } else if (check.kind === "recovery") {
    const matching = record.tools.filter((x) => x.name === check.value); const failedAt = matching.findIndex((x) => x.result?.isError); const laterSuccess = failedAt >= 0 && matching.slice(failedAt + 1).some((x) => x.result && !x.result.isError);
    const transparent = failedAt >= 0 && /\b(?:could not|couldn't|failed|unavailable|unable|not verify|unverified|retry)\b/i.test(record.answer);
    pass = failedAt >= 0 && (laterSuccess || transparent); detail = pass ? laterSuccess ? "recovered after injected failure" : "reported limitation honestly" : "did not recover from or disclose injected failure";
  } else if (check.kind === "format") {
    const [rule, rawLimit] = check.value.split(":"); const limit = Number(rawLimit); const text = record.answer.trim(); let actual = Infinity;
    if (rule === "max_words") actual = text ? text.split(/\s+/).length : 0;
    else if (rule === "max_bullets") actual = (text.match(/^\s*(?:[-*•]|\d+[.)])\s+/gm) ?? []).length;
    else if (rule === "max_sentences") actual = (text.match(/[.!?]+(?:\s|$)/g) ?? []).length;
    else if (rule === "max_lines") actual = text ? text.split(/\r?\n/).filter((line) => line.trim()).length : 0;
    pass = Number.isFinite(limit) && actual <= limit; detail = pass ? `${rule} ${actual}/${limit}` : `${rule} exceeded: ${actual}/${limit}`;
  } else if (check.kind === "artifact") {
    const path = join(process.cwd(), check.value); pass = existsSync(path) && statSync(path).isFile(); detail = pass ? `${check.value} exists in isolated workspace` : `${check.value} missing from isolated workspace`;
  }
  return { ...check, pass, detail };
}

function implicitChecks(record: Omit<PersonalTurnRecord, "checks" | "ok" | "score" | "possible" | "transcriptRef" | "resultsLine">): EvaluatedPersonalCheck[] {
  const schemaFailure = record.tools.find((tool) => tool.result?.isError && tool.result.content.includes("Tool argument validation failed"));
  const groundingFailure = record.tools.find((tool) => tool.result?.isError && tool.result.content.includes("[Grounding block:"));
  return [
    { kind: "answer", value: "user-facing-answer", field: "reliability", weight: 2, implicit: true, pass: record.answer.trim().length > 0, detail: record.answer.trim() ? `${record.answer.trim().length} answer chars` : "empty answer" },
    { kind: "recovery", value: "no-agent-error", field: "reliability", weight: 3, implicit: true, pass: record.agentErrors.length === 0 && !record.timedOut, detail: record.agentErrors[0] ?? (record.timedOut ? "turn timed out" : "clean") },
    { kind: "recovery", value: "schema-valid-first-pass", field: "reliability", weight: 2, implicit: true, pass: !schemaFailure, detail: schemaFailure ? `${schemaFailure.name}: ${schemaFailure.result!.content.split("\n")[0]}` : "no tool-schema retries" },
    { kind: "recovery", value: "grounded-first-pass", field: "reliability", weight: 2, implicit: true, pass: !groundingFailure, detail: groundingFailure ? `${groundingFailure.name}: arguments did not match the current request` : "tool arguments stayed grounded" },
  ];
}

function transcriptTurn(record: PersonalTurnRecord): string {
  const toolJson = record.tools.length ? record.tools.map((x) => JSON.stringify({ name: x.name, args: x.args, risk: x.risk, result: x.result }, null, 2)).join("\n\n") : "(none)";
  return [`<a id="turn-${record.turn}"></a>`, `## ${record.turn} — day ${record.day}`, "", "### User", "", record.prompt, "", "### Sophie", "", record.answer || "(no answer)", "", "### Tool trace", "", "```json", toolJson, "```", "", "### Checks", "", ...record.checks.map((c) => `- ${c.pass ? "PASS" : "FAIL"} ${c.kind}:${c.value} [${c.field}] — ${c.detail}`), ""].join("\n");
}

async function runTurn(scenario: PersonalScenario, turn: PersonalTurn, index: number, agent: Agent, state: FakeWorldState, before: Snapshot): Promise<Omit<PersonalTurnRecord, "checks" | "ok" | "score" | "possible" | "transcriptRef" | "resultsLine">> {
  const tools: PersonalTurnRecord["tools"] = []; const approvals: PersonalTurnRecord["approvals"] = []; const agentErrors: string[] = []; const toolErrors: PersonalTurnRecord["toolErrors"] = []; let answer = ""; let routedIntent: NonNullable<PersonalTurnRecord["runtime"]["intent"]> | undefined;
  const byId = new Map<string, PersonalTurnRecord["tools"][number]>(); const historyStart = agent.getHistory().length; const historyBefore = messagesTokens(agent.getHistory()); const started = Date.now(); let timedOut = false;
  const long = turn.longContext || turn.prompt.length > 3500; const timeoutMs = long ? 7 * 60_000 : 3 * 60_000; const controller = new AbortController(); const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const trustedContext = `[PERSONAL ASSISTANT BENCHMARK — synthetic, isolated]\nScenario clock: ${state.now}. Persona: ${scenario.persona} (${scenario.kind}). All personal-service records are synthetic. Act on them with normal tools; do not use the host clock.\nConstraints: ${scenario.constraints.join(" ")}`;
  try {
    await agent.run(turn.prompt, {
      onContent: (delta) => { answer += delta; },
      onIntent: (intent, context) => { routedIntent = { kind: intent.kind, expectedTools: intent.expectedTools ?? [], requiredOutcomes: (intent.requiredOutcomes ?? []).map((outcome) => `${outcome.prefix}x${outcome.minimum}`), restoredSession: !!context?.restoredSession, priorToolNames: context?.priorToolNames ?? [] }; },
      onToolCall: (call: ToolCallEvent) => { const item = { id: call.id, name: call.name, args: structuredClone(call.args), risk: call.risk, ...(call.details ? { details: call.details } : {}), ...(call.argumentHash ? { argumentHash: call.argumentHash } : {}) }; tools.push(item); byId.set(call.id, item); },
      onToolResult: (id: string, result: ToolResult) => { const item = byId.get(id); if (item) item.result = { content: result.content.slice(0, 8000), ...(result.display ? { display: result.display } : {}), isError: !!result.isError }; if (result.isError) toolErrors.push({ tool: item?.name ?? "unknown", message: (result.display ?? result.content).slice(0, 500) }); },
      requestApproval: async (call): Promise<ApprovalDecision> => { const decision = turn.approvalDecision ?? "approve"; approvals.push({ tool: call.name, decision, ...(call.details ? { details: call.details } : {}), ...(call.argumentHash ? { argumentHash: call.argumentHash } : {}) }); return decision; },
      onError: (message) => agentErrors.push(message.slice(0, 1000)),
    }, controller.signal, { trustedContext });
  } catch (error: any) { agentErrors.push(`threw: ${error?.message ?? error}`); }
  finally { clearTimeout(timer); }
  const history = agent.getHistory(); const runtime = getTurnStats();
  return {
    scenario: scenario.id, persona: scenario.persona, kind: scenario.kind, turn: turn.id, turnIndex: index, day: turn.day, prompt: turn.prompt, answer,
    durationMs: Date.now() - started, timedOut, agentErrors, toolErrors, tools, approvals,
    history: { tokensBefore: historyBefore, tokensAfter: messagesTokens(history), messagesAfter: history.length, compacted: history.some((m) => typeof m.content === "string" && m.content.includes("Compacted continuation brief")) },
    guard: [], world: { actions: state.actions.slice(before.actionCount), eventsAdded: state.events.slice(before.eventCount), draftsAdded: state.drafts.slice(before.draftCount), notificationsAdded: state.notifications.slice(before.notificationCount), schedulesAdded: state.schedules.slice(before.scheduleCount), delegationsAdded: state.delegations.slice(before.delegationCount), tasks: readAssistantTasks(), projects: listProjects("all"), people: listPeople() },
    runtime: {
      promptTokens: runtime.promptTokens,
      modelRequests: runtime.modelRequests ?? 0,
      ...(runtime.firstTokenMs !== undefined ? { firstTokenMs: runtime.firstTokenMs } : {}),
      ...(routedIntent ? { intent: routedIntent } : {}),
      modelTrace: history.slice(historyStart).slice(-30).map((message) => ({ role: message.role, content: String(message.content).slice(0, 4000) })),
    },
  };
}

export async function runPersonalAssistantBenchmark(): Promise<void> {
  const wanted = arg("--scenario"); const maxTurns = Number(arg("--max-turns") ?? Infinity); const allowFailures = process.argv.includes("--allow-failures");
  const out = process.env.SOPHIE_PERSONAL_BENCH_OUT ?? join(REPO_ROOT, "bench-results", `${new Date().toISOString().replace(/[:.]/g, "-")}-personal-assistant`); mkdirSync(out, { recursive: true });
  const selected = PERSONAL_ASSISTANT_SCENARIOS.filter((s) => !wanted || wanted.split(",").includes(s.id)); const records: PersonalTurnRecord[] = [];
  console.log(`Personal Assistant 9/10 benchmark: ${selected.length} conversation(s), ${selected.reduce((n, s) => n + Math.min(maxTurns, s.turns.length), 0)} turn(s)`); console.log(`Model: ${config.model}\nOutput: ${out}\n`);
  for (const scenario of selected) {
    const workspace = join(out, "workspace"); mkdirSync(workspace, { recursive: true }); writeFileSync(join(workspace, "README.md"), "# Synthetic personal-assistant benchmark workspace\nNo live user data belongs here.\n"); process.chdir(workspace);
    clearTasks(); resetToolGroups(); setMode("normal"); const guard = installGuard({ workspaceRoot: workspace, blockNetwork: true }); const world = installFakeWorld(scenario); let agent = new Agent(); agent.reset();
    const transcript = join(out, "transcript.md"); writeFileSync(transcript, `# ${scenario.persona} — ${scenario.bio}\n\nSynthetic isolated conversation.\n\n`);
    console.log(`\n${scenario.persona} — ${scenario.bio}`);
    try {
      for (let index = 0; index < Math.min(maxTurns, scenario.turns.length); index++) {
        const turn = scenario.turns[index]!; world.setDay(turn.day); if (turn.update) world.inject(turn.update); world.setFaults(turn.faults ?? []);
        if (turn.restartBefore) { const history = structuredClone(agent.getHistory()); agent = new Agent(); agent.restoreHistory(history); }
        const before = snapshot(world.state); process.stdout.write(`  ${index + 1}/${scenario.turns.length} ${turn.id} ... `);
        const base = await runTurn(scenario, turn, index, agent, world.state, before); base.guard = guard.events.splice(0).filter((x) => x.action !== "allow").map((x) => ({ tool: x.tool, action: x.action, reason: x.reason, args: x.args }));
        const checks = [...turn.checks.map((check) => evaluate(check, base, world.state, before)), ...implicitChecks(base)]; const possible = checks.reduce((n, x) => n + x.weight, 0); const score = checks.filter((x) => x.pass).reduce((n, x) => n + x.weight, 0);
        const line = records.length + 1; const record: PersonalTurnRecord = { ...base, checks, possible, score, ok: checks.every((x) => x.pass), transcriptRef: `transcript.md#turn-${turn.id}`, resultsLine: line };
        records.push(record); appendFileSync(join(out, "results.jsonl"), `${JSON.stringify(record)}\n`); appendFileSync(transcript, transcriptTurn(record));
        console.log(`${record.ok ? "PASS" : "FAIL"} ${(record.durationMs / 1000).toFixed(0)}s ${record.score}/${record.possible} ctx:${(record.history.tokensAfter / 1000).toFixed(1)}k`);
      }
    } finally { world.uninstall(); guard.uninstall(); }
  }
  const summary = personalSummary(records, config.model, config.baseUrl); writeFileSync(join(out, "summary.json"), JSON.stringify(summary, null, 2)); writeFileSync(join(out, "report.md"), generatePersonalReport(records, summary)); writeFileSync(join(out, "failure-index.json"), JSON.stringify(failureIndex(records), null, 2));
  console.log(`\nScore ${summary.score10.toFixed(1)}/10; minimum field ${summary.minimumFieldScore10.toFixed(1)}/10; ${summary.falseActions} false actions; ${summary.criticalFailures} critical failures.`); console.log(`Report: ${join(out, "report.md")}`);
  if (!allowFailures && !passesNineGate(summary)) process.exitCode = 1;
}

if (import.meta.main) await runPersonalAssistantBenchmark();
