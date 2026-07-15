/**
 * Turns raw benchmark case records into a failure-analysis report.
 *
 * For every failed check it labels: WHAT went wrong, WHY (the likely cause), and
 * WHERE in Sophie to fix it (concrete source files). Findings are grouped by
 * signature so the reader gets a deduplicated, prioritized fix list rather
 * than 110 one-off notes.
 */

import type { Complexity } from "./questions.ts";
import type { BenchSummary } from "./summary.ts";

export interface CaseRecord {
  id: string;
  category: string;
  complexity: Complexity;
  prompt: string;
  mode: string;
  ok: boolean;
  durationMs: number;
  timedOut: boolean;
  tools: string[];
  toolCalls?: { name: string; args: Record<string, unknown>; summary: string }[];
  toolRounds: number;
  toolErrors: { tool: string; message: string }[];
  agentErrors: string[];
  guard: { tool: string; action: string; reason: string }[];
  checks: { name: string; pass: boolean; detail: string }[];
  answerChars: number;
  answerPreview: string;
  falseAction?: boolean;
  actionQuality?: { unauthorizedActions: number; duplicateActions: number; falseCompletions: number; failedActions: number };
  runtime?: { promptTokens: number; modelRequests: number; firstTokenMs?: number };
}

export interface Summary extends BenchSummary {}

/** tool name → the source file that implements it. */
const TOOL_SOURCE: Record<string, string> = {
  read_file: "src/tools/fs.ts", write_file: "src/tools/fs.ts", edit_file: "src/tools/fs.ts",
  replace_lines: "src/tools/fs.ts", list_dir: "src/tools/fs.ts", glob: "src/tools/fs.ts", grep: "src/tools/fs.ts",
  scaffold_project: "src/tools/scaffold.ts",
  scaffold_python_project: "src/tools/scaffold_apps.ts", scaffold_next_shadcn_project: "src/tools/scaffold_apps.ts",
  bash: "src/tools/bash.ts", run_background: "src/tools/jobs.ts", job_status: "src/tools/jobs.ts", wait_for: "src/tools/jobs.ts",
  web_search: "src/tools/web.ts", web_fetch: "src/tools/web.ts", http_request: "src/tools/http.ts",
  current_time: "src/tools/time.ts", where_am_i: "src/tools/location.ts", system_info: "src/tools/system.ts",
  weather: "src/tools/weather.ts", calc: "src/tools/calc.ts",
  apple: "src/tools/apple.ts", notify: "src/tools/notify.ts (+ src/channels/notify.ts)",
  calendar: "src/tools/calendar.ts", calendar_list: "src/tools/calendar_query.ts", calendar_search: "src/tools/calendar_query.ts", calendar_find_free: "src/tools/calendar_query.ts",
  schedule: "src/tools/schedule.ts", schedule_list: "src/tools/schedule_query.ts",
  remember: "src/tools/memory.ts (+ src/memory/*)", recall: "src/tools/memory.ts (+ src/memory/embeddings.ts)",
  search_verified_memory: "src/tools/verified_memory.ts", search_sessions: "src/tools/sessions.ts",
  load_skill: "src/tools/skills.ts", save_skill: "src/tools/skills.ts", load_tools: "src/tools/groups.ts",
  update_tasks: "src/tools/tasks.ts", manage_tasks: "src/tools/assistant_tasks.ts",
  verify_project: "src/tools/verify.ts", verify_next_app: "src/tools/verify.ts", verify_python_project: "src/tools/verify.ts",
  verify_static_site: "src/tools/verify.ts", verify_package_install: "src/tools/verify.ts",
  set_mode: "src/tools/mode.ts (+ src/agent/mode.ts)", ask_user: "src/tools/ask_user.ts",
  clipboard: "src/tools/clipboard.ts", open_thing: "src/tools/open_thing.ts",
  speak: "src/tools/speak.ts", voice: "src/tools/voice.ts", capture_screen: "src/tools/screen.ts",
  browser_check: "src/tools/browser.ts", browser_act: "src/tools/browser.ts",
  find_images: "src/tools/images.ts", describe_images: "src/tools/images.ts",
  read_document: "src/tools/document.ts", project_map: "src/tools/project.ts",
  people: "src/tools/people.ts", projects: "src/tools/projects.ts", delegate: "src/tools/delegate.ts",
  watch_path: "src/tools/watch.ts", stop_webapp: "src/tools/webapp.ts",
};

interface Finding {
  signature: string;
  what: string;
  why: string;
  where: string[];
  cases: string[];
  severity: "high" | "medium" | "low";
}

function agentErrorClass(msg: string): { sig: string; what: string; why: string; where: string[] } | null {
  const m = msg.toLowerCase();
  if (/step-limit|reached the|round/.test(m)) {
    return {
      sig: "round-limit-hit",
      what: "Turn hit the per-turn step/round ceiling without finishing.",
      why: "The model spiralled (re-reading, retrying, or narrating without progress) and never converged. Loop/stall detection did not exit early enough, or the task genuinely needs more decomposition.",
      where: ["src/agent/agent.ts (MAX_ROUNDS, STALL_ROUNDS, spiralSynthesisPrompt, runtimeLimits)", "src/agent/intent.ts (task decomposition)"],
    };
  }
  if (/model request failed|mid-stream|retries/.test(m)) {
    return {
      sig: "model-request-failed",
      what: "The model/LLM request failed (stream error or exhausted retries).",
      why: "Local model server returned an error, disconnected mid-stream, or the request exceeded the context window.",
      where: ["src/llm/client.ts (streamChat, retries)", "src/agent/context.ts (token budgeting)", "scripts/serve.sh (server config)"],
    };
  }
  if (/verifier|blocker/.test(m)) {
    return {
      sig: "verifier-escalation",
      what: "Sophie stopped and escalated after repeated verifier failures.",
      why: "A verify_* / browser_check tool kept failing with no pass; the build could not be proven clean.",
      where: ["src/tools/verify.ts", "src/agent/verification.ts", "src/agent/agent.ts (VERIFIER_ESCALATE_AFTER)"],
    };
  }
  if (/could not find|attach|image/.test(m)) {
    return { sig: "attachment-error", what: "An image/attachment could not be resolved.", why: "The referenced path did not resolve to a readable image.", where: ["src/llm/images.ts", "src/llm/image-files.ts"] };
  }
  return null;
}

/** A case that failed purely because the model backend was unreachable (e.g. a
 *  501/connection error). Its downstream check failures (no tool, no answer) are
 *  artifacts of getting no model response — NOT Sophie logic bugs — so we
 *  attribute them to a single infra finding and flag the case for re-run. */
function isBackendOutage(agentErrors: string[]): boolean {
  return agentErrors.some((e) =>
    /model request failed|501|unsupported method|econnrefused|is it running at|after \d+ retries|socket|fetch failed/i.test(e),
  );
}

export function generateReport(records: CaseRecord[], summary: Summary): string {
  const findings = new Map<string, Finding>();
  const outageCases = records.filter((r) => isBackendOutage(r.agentErrors)).map((r) => r.id);
  const outageSet = new Set(outageCases);
  const add = (f: { sig: string; what: string; why: string; where: string[]; severity: Finding["severity"] }, caseId: string) => {
    const existing = findings.get(f.sig);
    if (existing) {
      if (!existing.cases.includes(caseId)) existing.cases.push(caseId);
      for (const w of f.where) if (!existing.where.includes(w)) existing.where.push(w);
    } else {
      findings.set(f.sig, { signature: f.sig, what: f.what, why: f.why, where: [...f.where], cases: [caseId], severity: f.severity });
    }
  };

  for (const r of records) {
    // Cases poisoned by a backend outage are attributed to one infra finding;
    // their cascading check failures are not counted as Sophie logic bugs.
    if (outageSet.has(r.id)) {
      add({
        sig: "backend-outage",
        what: "Model backend was unreachable (request failed / 501 / connection error), so these turns could not run.",
        why: "The configured local model endpoint did not answer chat requests. These cases are NOT Sophie logic failures — they need a clean re-run with the model server healthy and reachable. If this appears after a site-serving benchmark, also check whether a dev/static server tried to bind the model port.",
        where: ["scripts/serve.sh (model server)", "src/llm/client.ts (backend error surfacing and retries)", "src/bench/guard.ts (blocks binding the model port during benchmarks)"],
        severity: "high",
      }, r.id);
      continue;
    }
    for (const c of r.checks) {
      if (c.pass) continue;
      switch (c.name) {
        case "expected-tool": {
          add({
            sig: "wrong-tool-routing",
            what: "Sophie answered without calling the tool the request needed (or picked the wrong one).",
            why: "Intent classification / progressive tool disclosure did not surface or select the right tool; the model answered from memory or chose a weaker path. This is the dominant capability gap for a small local model.",
            where: ["src/agent/intent.ts (classifyTurnIntent, tool restriction sets)", "src/tools/groups.ts (autoActivateForInput, progressive disclosure)", "src/agent/agent.ts (toolSpecsForModeAndIntent)", "src/agent/prompt.ts + src/agent/fewshot.ts (guidance/examples)"],
            severity: "high",
          }, r.id);
          break;
        }
        case "no-banned-tool": {
          add({
            sig: "scope-escape",
            what: "Sophie used a tool that should have been out of scope for this request.",
            why: "Intent restriction or the safety gate did not constrain the turn; a quick/chat/plan request reached a side-effecting tool.",
            where: ["src/agent/intent.ts (restrictTools, kind)", "src/agent/agent.ts (turnPolicyBlock)", "src/agent/safety.ts (gate)"],
            severity: "high",
          }, r.id);
          break;
        }
        case "produced-answer": {
          add({
            sig: "empty-final-answer",
            what: "The turn ended with no user-facing prose.",
            why: "Sophie ran tools but never synthesized a reply, or stopped after a tool without answering. Synthesis/nudge logic did not force a closing answer.",
            where: ["src/agent/agent.ts (synthesis exit, nudge budget, looksLikePromisedAction)", "src/agent/prompt.ts"],
            severity: "high",
          }, r.id);
          break;
        }
        case "no-agent-error": {
          const cls = agentErrorClass(r.agentErrors[0] ?? "");
          if (cls) add({ ...cls, severity: cls.sig === "model-request-failed" ? "high" : "medium" }, r.id);
          else add({ sig: "agent-error-other", what: "Sophie surfaced an error to the user.", why: r.agentErrors[0] ?? "unknown", where: ["src/agent/agent.ts"], severity: "medium" }, r.id);
          break;
        }
        case "no-timeout": {
          add({
            sig: "timeout",
            what: `Case exceeded its time budget (${r.complexity}).`,
            why: "A tool hung, a background job was never awaited correctly, or the model looped past the wall-clock limit. Long tasks need tighter progress checks or backgrounding.",
            where: ["src/agent/agent.ts (TOOL_TIMEOUT_MS, round limits)", "src/tools/jobs.ts (run_background/wait_for)", ...r.tools.filter((t) => TOOL_SOURCE[t]).slice(-1).map((t) => TOOL_SOURCE[t]!)],
            severity: "high",
          }, r.id);
          break;
        }
        case "expected-tool-succeeded": {
          const te = r.toolErrors[0];
          const src = te ? TOOL_SOURCE[te.tool] ?? `src/tools/${te.tool}.ts` : "unknown";
          add({
            sig: `tool-error:${te?.tool ?? "?"}`,
            what: `The '${te?.tool ?? "?"}' tool errored on a request that expected it to work.`,
            why: te?.message ?? "tool returned isError",
            where: [src],
            severity: "medium",
          }, r.id);
          break;
        }
        case "artifact": {
          add({
            sig: "coding-artifact-missing",
            what: "A coding benchmark did not leave the expected app/tool files or required contents behind.",
            why: c.detail,
            where: [
              "src/bench/questions.ts (artifact expectations for coding benchmarks)",
              "src/agent/agent.ts (build-mode completion and verifier discipline)",
              "src/tools/verify.ts (domain verifiers)",
              "src/tools/fs.ts / src/tools/scaffold.ts / src/tools/scaffold_apps.ts (artifact creation)",
            ],
            severity: "high",
          }, r.id);
          break;
        }
        default:
          add({ sig: `check:${c.name}`, what: `Check '${c.name}' failed.`, why: c.detail, where: ["src/agent/agent.ts"], severity: "low" }, r.id);
      }
    }
  }

  // Per-category rollup.
  const byCat = new Map<string, { total: number; passed: number }>();
  for (const r of records) {
    const e = byCat.get(r.category) ?? { total: 0, passed: 0 };
    e.total++;
    if (r.ok) e.passed++;
    byCat.set(r.category, e);
  }
  const byComplexity = new Map<Complexity, { total: number; passed: number }>();
  for (const r of records) {
    const e = byComplexity.get(r.complexity) ?? { total: 0, passed: 0 };
    e.total++;
    if (r.ok) e.passed++;
    byComplexity.set(r.complexity, e);
  }

  const sorted = [...findings.values()].sort((a, b) => {
    const rank = { high: 0, medium: 1, low: 2 } as const;
    if (rank[a.severity] !== rank[b.severity]) return rank[a.severity] - rank[b.severity];
    return b.cases.length - a.cases.length;
  });

  // Safety confirmation: what the guard intercepted (proof nothing reached the world).
  const guardTally = new Map<string, number>();
  for (const r of records) for (const g of r.guard) guardTally.set(`${g.tool}:${g.action}`, (guardTally.get(`${g.tool}:${g.action}`) ?? 0) + 1);

  const L: string[] = [];
  L.push("# Sophie Benchmark Report");
  L.push("");
  L.push(`Generated: ${summary.generatedAt}`);
  L.push(`Model: \`${summary.model}\``);
  L.push(`Endpoint: \`${summary.baseUrl}\``);
  L.push("");
  L.push(`**${summary.passed}/${summary.total} cases passed (${(summary.passRate * 100).toFixed(0)}%).**`);
  L.push("");
  if (outageCases.length) {
    const evalTotal = summary.total - outageCases.length;
    const effRate = evalTotal ? (summary.passed / evalTotal) * 100 : 0;
    L.push(`> ⚠️ **${outageCases.length} cases hit a model-backend outage** (see finding \`backend-outage\`) and could not run — their failures are infra, not Sophie logic. Excluding them, the effective rate is **${summary.passed}/${evalTotal} (${effRate.toFixed(0)}%)**. Re-run those cases with the model server healthy: \`bun run src/bench/sophie_benchmark.ts --ids ${outageCases.join(",")}\`.`);
    L.push("");
  }
  L.push("Every case was a real conversation driven through Sophie's live Agent runtime against the local model. All tool groups were exercised through a safety guard that simulated real-world side effects (message sends, calendar/schedule writes, app launches, speech, screen capture, dangerous shell) while allowing sandboxed reads/writes, notes, and reminders.");
  L.push("");

  L.push("## Results by complexity");
  L.push("");
  L.push("| Complexity | Passed | Total | Rate |");
  L.push("| --- | --- | --- | --- |");
  for (const c of ["quick", "medium", "long"] as Complexity[]) {
    const e = byComplexity.get(c);
    if (e) L.push(`| ${c} | ${e.passed} | ${e.total} | ${((e.passed / e.total) * 100).toFixed(0)}% |`);
  }
  L.push("");

  L.push("## Results by category");
  L.push("");
  L.push("| Category | Passed | Total | Rate |");
  L.push("| --- | --- | --- | --- |");
  for (const [cat, e] of [...byCat.entries()].sort((a, b) => a[1].passed / a[1].total - b[1].passed / b[1].total)) {
    L.push(`| ${cat} | ${e.passed} | ${e.total} | ${((e.passed / e.total) * 100).toFixed(0)}% |`);
  }
  L.push("");

  L.push("## Prioritized findings (what went wrong / why / where to fix)");
  L.push("");
  if (!sorted.length) {
    L.push("No failing checks — every case passed.");
  }
  let n = 1;
  for (const f of sorted) {
    L.push(`### ${n}. ${f.what}  \`[${f.severity}]\``);
    L.push("");
    L.push(`- **Signature:** \`${f.signature}\``);
    L.push(`- **Affected cases (${f.cases.length}):** ${f.cases.join(", ")}`);
    L.push(`- **Why it went wrong:** ${f.why}`);
    L.push(`- **Where to fix in Sophie:**`);
    for (const w of f.where) L.push(`  - \`${w}\``);
    L.push("");
    n++;
  }

  L.push("## Failing cases (detail)");
  L.push("");
  for (const r of records.filter((x) => !x.ok)) {
    const failed = r.checks.filter((c) => !c.pass);
    L.push(`### ${r.id} — ${r.category}/${r.complexity}`);
    L.push(`- Prompt: ${JSON.stringify(r.prompt)}`);
    L.push(`- Tools called (${r.tools.length}): ${[...r.tools].join(", ") || "none"}`);
    if (r.toolCalls?.length) {
      L.push(`- Tool call log: ${r.toolCalls.map((c) => `${c.name}(${JSON.stringify(c.args).slice(0, 180)})`).join(" | ")}`);
    }
    if (r.toolErrors.length) L.push(`- Tool errors: ${r.toolErrors.map((e) => `${e.tool} → ${e.message}`).join(" | ")}`);
    if (r.agentErrors.length) L.push(`- Agent errors: ${r.agentErrors.join(" | ")}`);
    L.push(`- Failed checks: ${failed.map((c) => `${c.name} (${c.detail})`).join("; ")}`);
    L.push(`- Answer preview: ${JSON.stringify(r.answerPreview.slice(0, 220))}`);
    L.push("");
  }

  L.push("## Safety guard activity (proof nothing reached the real world)");
  L.push("");
  if (!guardTally.size) {
    L.push("No side-effecting tools were intercepted.");
  } else {
    L.push("| Tool:action | Times intercepted |");
    L.push("| --- | --- |");
    for (const [k, v] of [...guardTally.entries()].sort((a, b) => b[1] - a[1])) L.push(`| ${k} | ${v} |`);
  }
  L.push("");

  L.push("## How to work this fix list");
  L.push("");
  L.push("Work through the **Prioritized findings** top to bottom (high severity first). For each finding:");
  L.push("1. Open the listed source file(s) and reproduce the failure using the affected case ids (re-run `bun run src/bench/sophie_benchmark.ts --ids <id>`).");
  L.push("2. Fix the root cause — do not just widen a timeout or loosen a check to make the benchmark pass.");
  L.push("3. Prefer fixes in the routing/intent layer (`src/agent/intent.ts`, `src/tools/groups.ts`, `src/agent/agent.ts`) for `wrong-tool-routing` and `scope-escape`, since those affect many cases at once.");
  L.push("4. Re-run the affected cases to confirm, then run the full suite before finishing.");
  L.push("");
  L.push("Do not commit or push. Leave the working tree changed for review.");
  L.push("");
  return L.join("\n");
}
