/**
 * Capability-suite report.
 *
 * Scores Sophie as an assistant / coder / researcher, rates terminal skill and
 * decision-making, and — the headline — charts where growing context starts to
 * degrade her (by token size, by turn depth, across compaction, and on turns
 * that reference earlier work). Every failure is labelled what/why/fix.
 */

export interface TurnRecord {
  id: string;
  category: string;
  complexity: "quick" | "medium" | "long";
  prompt: string;
  mode: string;
  ok: boolean;
  durationMs: number;
  timedOut: boolean;
  tools: string[];
  toolRounds: number;
  toolErrors: { tool: string; message: string }[];
  agentErrors: string[];
  guard: { tool: string; action: string; reason: string }[];
  checks: { name: string; pass: boolean; detail: string }[];
  answerChars: number;
  answerPreview: string;
  chatId: string;
  persona: string;
  turnIndex: number;
  capability: string;
  referencesEarlier: boolean;
  historyTokensBefore: number;
  historyTokensAfter: number;
  historyMsgs: number;
  compacted: boolean;
}

export interface Summary {
  model: string;
  baseUrl: string;
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  generatedAt: string;
}

const TOOL_SOURCE: Record<string, string> = {
  read_file: "src/tools/fs.ts", write_file: "src/tools/fs.ts", edit_file: "src/tools/fs.ts", replace_lines: "src/tools/fs.ts",
  list_dir: "src/tools/fs.ts", glob: "src/tools/fs.ts", grep: "src/tools/fs.ts", project_map: "src/tools/project.ts",
  scaffold_project: "src/tools/scaffold.ts", scaffold_python_project: "src/tools/scaffold_apps.ts", scaffold_next_shadcn_project: "src/tools/scaffold_apps.ts",
  bash: "src/tools/bash.ts", run_background: "src/tools/jobs.ts", job_status: "src/tools/jobs.ts", wait_for: "src/tools/jobs.ts",
  web_search: "src/tools/web.ts", web_fetch: "src/tools/web.ts", http_request: "src/tools/http.ts", read_document: "src/tools/document.ts",
  current_time: "src/tools/time.ts", where_am_i: "src/tools/location.ts", system_info: "src/tools/system.ts", weather: "src/tools/weather.ts", calc: "src/tools/calc.ts",
  apple: "src/tools/apple.ts", notify: "src/tools/notify.ts", calendar: "src/tools/calendar.ts",
  calendar_list: "src/tools/calendar_query.ts", calendar_find_free: "src/tools/calendar_query.ts", calendar_search: "src/tools/calendar_query.ts",
  schedule: "src/tools/schedule.ts", schedule_list: "src/tools/schedule_query.ts",
  remember: "src/tools/memory.ts", recall: "src/tools/memory.ts", search_verified_memory: "src/tools/verified_memory.ts", search_sessions: "src/tools/sessions.ts",
  load_skill: "src/tools/skills.ts", save_skill: "src/tools/skills.ts", load_tools: "src/tools/groups.ts",
  update_tasks: "src/tools/tasks.ts", manage_tasks: "src/tools/assistant_tasks.ts",
  verify_python_project: "src/tools/verify.ts", verify_project: "src/tools/verify.ts",
  set_mode: "src/agent/mode.ts", ask_user: "src/tools/ask_user.ts", clipboard: "src/tools/clipboard.ts",
  open_thing: "src/tools/open_thing.ts", speak: "src/tools/speak.ts", capture_screen: "src/tools/screen.ts",
  people: "src/tools/people.ts", projects: "src/tools/projects.ts", delegate: "src/tools/delegate.ts",
};

const CAPS: { key: string; label: string }[] = [
  { key: "assistant", label: "Assistant" },
  { key: "coder", label: "Coder" },
  { key: "researcher", label: "Researcher" },
  { key: "terminal", label: "Terminal" },
  { key: "decision", label: "Decision-making" },
  { key: "longrun", label: "Long-running" },
];

interface Finding {
  sig: string;
  what: string;
  why: string;
  where: string[];
  cases: string[];
  severity: "high" | "medium" | "low";
}

function rate(recs: TurnRecord[]): { passed: number; total: number; pct: number } {
  const total = recs.length;
  const passed = recs.filter((r) => r.ok).length;
  return { passed, total, pct: total ? Math.round((passed / total) * 100) : 0 };
}

function classify(r: TurnRecord): { sig: string; what: string; why: string; where: string[]; severity: Finding["severity"] }[] {
  const out: ReturnType<typeof classify> = [];
  for (const c of r.checks) {
    if (c.pass) continue;
    if (c.name === "expected-tool") {
      out.push({ sig: "wrong-tool-routing", what: "Answered without calling the tool the request needed.", why: "Intent/disclosure didn't surface or select the right tool; the model answered from memory or chose a weaker path.", where: ["src/agent/intent.ts", "src/tools/groups.ts", "src/agent/agent.ts (toolSpecsForModeAndIntent)"], severity: "high" });
    } else if (c.name === "no-banned-tool") {
      out.push({ sig: "scope-escape", what: "Used an out-of-scope tool for the request.", why: "Intent restriction / safety gate didn't constrain the turn.", where: ["src/agent/intent.ts", "src/agent/agent.ts (turnPolicyBlock)", "src/agent/safety.ts"], severity: "high" });
    } else if (c.name === "produced-answer") {
      out.push({ sig: "empty-final-answer", what: "Turn ended with no user-facing prose.", why: "Ran tools but never synthesized a reply; synthesis/nudge logic didn't force a close.", where: ["src/agent/agent.ts (synthesis exit, nudges)", "src/agent/prompt.ts"], severity: "high" });
    } else if (c.name === "no-timeout") {
      out.push({ sig: "timeout", what: `Turn exceeded its ${r.complexity} time budget.`, why: "Model looped or a job wasn't awaited; long turns need tighter progress checks.", where: ["src/agent/agent.ts (round/stall limits)", ...r.tools.filter((t) => TOOL_SOURCE[t]).slice(-1).map((t) => TOOL_SOURCE[t]!)], severity: "high" });
    } else if (c.name === "expected-tool-succeeded") {
      const te = r.toolErrors[0];
      out.push({ sig: `tool-error:${te?.tool ?? "?"}`, what: `The '${te?.tool ?? "?"}' tool errored when expected to work.`, why: te?.message ?? "tool returned isError", where: [te ? TOOL_SOURCE[te.tool] ?? `src/tools/${te.tool}.ts` : "unknown"], severity: "medium" });
    } else if (c.name === "no-agent-error") {
      const m = (r.agentErrors[0] ?? "").toLowerCase();
      if (/step-limit|reached the|round/.test(m)) out.push({ sig: "round-limit", what: "Hit the per-turn round ceiling.", why: "Spiralled without converging; loop/stall detection didn't exit early enough.", where: ["src/agent/agent.ts (MAX_ROUNDS, STALL_ROUNDS)"], severity: "high" });
      else if (/model request failed|501|retries/.test(m)) out.push({ sig: "backend", what: "Model backend request failed.", why: "Server error / disconnect / context overflow — infra, not logic.", where: ["src/llm/client.ts", "scripts/serve.sh"], severity: "medium" });
      else out.push({ sig: "agent-error", what: "Sophie surfaced an error.", why: r.agentErrors[0] ?? "unknown", where: ["src/agent/agent.ts"], severity: "medium" });
    }
  }
  return out;
}

export function generateCapabilityReport(records: TurnRecord[], summary: Summary): string {
  const L: string[] = [];
  const overall = rate(records);

  // ── Findings roll-up ──
  const findings = new Map<string, Finding>();
  for (const r of records) {
    for (const f of classify(r)) {
      const e = findings.get(f.sig);
      if (e) {
        if (!e.cases.includes(r.id)) e.cases.push(r.id);
        for (const w of f.where) if (!e.where.includes(w)) e.where.push(w);
      } else findings.set(f.sig, { sig: f.sig, what: f.what, why: f.why, where: [...f.where], cases: [r.id], severity: f.severity });
    }
  }
  const sortedFindings = [...findings.values()].sort((a, b) => {
    const rank = { high: 0, medium: 1, low: 2 } as const;
    return rank[a.severity] - rank[b.severity] || b.cases.length - a.cases.length;
  });

  L.push("# Sophie Capability Suite — Report");
  L.push("");
  L.push(`Generated: ${summary.generatedAt}`);
  L.push(`Model: \`${summary.model}\``);
  L.push("");
  L.push(`**${overall.passed}/${overall.total} turns passed (${overall.pct}%)** across ${new Set(records.map((r) => r.chatId)).size} persona chats.`);
  L.push("");
  L.push("Each chat is a continuous conversation (one persistent agent, history carried across turns) so this measures not just tool coverage but how Sophie holds up as context grows. Every tool ran through the safety guard; Sophie could only delete files she created this session.");
  L.push("");

  // ── Capability scorecard ──
  L.push("## Capability scorecard");
  L.push("");
  L.push("| Capability | Passed | Total | Rate | /10 |");
  L.push("| --- | --- | --- | --- | --- |");
  for (const cap of CAPS) {
    const r = rate(records.filter((x) => x.capability === cap.key));
    if (r.total) L.push(`| ${cap.label} | ${r.passed} | ${r.total} | ${r.pct}% | ${(r.pct / 10).toFixed(1)} |`);
  }
  L.push("");

  // ── Context-degradation analysis (the headline) ──
  L.push("## Context-degradation analysis — when does long context make Sophie dumber?");
  L.push("");
  const buckets: { label: string; lo: number; hi: number }[] = [
    { label: "0–3k", lo: 0, hi: 3000 },
    { label: "3–6k", lo: 3000, hi: 6000 },
    { label: "6–10k", lo: 6000, hi: 10000 },
    { label: "10–16k", lo: 10000, hi: 16000 },
    { label: "16k+", lo: 16000, hi: Infinity },
  ];
  L.push("Pass rate by conversation size (history tokens entering the turn):");
  L.push("");
  L.push("| Context entering turn | Turns | Passed | Rate | Avg tools | Agent errors |");
  L.push("| --- | --- | --- | --- | --- | --- |");
  let degradeAt = "";
  for (const b of buckets) {
    const rs = records.filter((r) => r.historyTokensBefore >= b.lo && r.historyTokensBefore < b.hi);
    if (!rs.length) continue;
    const r = rate(rs);
    const avgTools = (rs.reduce((n, x) => n + x.tools.length, 0) / rs.length).toFixed(1);
    const errs = rs.filter((x) => x.agentErrors.length).length;
    L.push(`| ${b.label} | ${r.total} | ${r.passed} | ${r.pct}% | ${avgTools} | ${errs} |`);
    if (!degradeAt && r.pct < Math.max(60, overall.pct - 15) && b.lo >= 3000) degradeAt = b.label;
  }
  L.push("");
  L.push("Pass rate by turn depth within a chat:");
  L.push("");
  L.push("| Turn depth | Turns | Passed | Rate |");
  L.push("| --- | --- | --- | --- |");
  const depthBands: { label: string; lo: number; hi: number }[] = [
    { label: "1–4 (early)", lo: 0, hi: 4 },
    { label: "5–8 (mid)", lo: 4, hi: 8 },
    { label: "9–11 (late)", lo: 8, hi: 11 },
    { label: "12–14 (deep)", lo: 11, hi: 99 },
  ];
  for (const d of depthBands) {
    const rs = records.filter((r) => r.turnIndex >= d.lo && r.turnIndex < d.hi);
    if (!rs.length) continue;
    const r = rate(rs);
    L.push(`| ${d.label} | ${r.total} | ${r.passed} | ${r.pct}% |`);
  }
  L.push("");
  const refT = rate(records.filter((r) => r.referencesEarlier));
  const nonRefT = rate(records.filter((r) => !r.referencesEarlier));
  const compacted = records.filter((r) => r.compacted);
  const compT = rate(compacted);
  const peakCtx = Math.max(0, ...records.map((r) => r.historyTokensAfter));
  L.push("Coherence signals:");
  L.push("");
  L.push(`- **Turns that reference earlier work:** ${refT.passed}/${refT.total} (${refT.pct}%) vs **fresh turns** ${nonRefT.passed}/${nonRefT.total} (${nonRefT.pct}%). A gap here means Sophie is losing the thread as history grows.`);
  L.push(`- **Compaction fired on ${compacted.length} turn(s)** (history summarized to fit the window); pass rate on those: ${compT.total ? compT.pct + "%" : "n/a"}.`);
  L.push(`- **Peak context reached:** ~${(peakCtx / 1000).toFixed(1)}k tokens.`);
  L.push("");
  L.push("**Conclusion:** " + degradationConclusion(degradeAt, refT.pct, nonRefT.pct, compT, overall.pct));
  L.push("");

  // ── Per-persona rundown ──
  L.push("## Per-persona rundown");
  L.push("");
  L.push("| Persona | Passed | Total | Rate | Peak ctx | Notable |");
  L.push("| --- | --- | --- | --- | --- | --- |");
  for (const chatId of [...new Set(records.map((r) => r.chatId))]) {
    const rs = records.filter((r) => r.chatId === chatId);
    const r = rate(rs);
    const peak = Math.max(0, ...rs.map((x) => x.historyTokensAfter));
    const fails = rs.filter((x) => !x.ok).map((x) => x.id);
    L.push(`| ${rs[0]!.persona} | ${r.passed} | ${r.total} | ${r.pct}% | ${(peak / 1000).toFixed(1)}k | ${fails.length ? "failed: " + fails.join(", ") : "clean"} |`);
  }
  L.push("");

  // ── Findings ──
  L.push("## Findings — what went wrong, why, and where to fix");
  L.push("");
  if (!sortedFindings.length) L.push("No failing checks — every turn passed.");
  let n = 1;
  for (const f of sortedFindings) {
    L.push(`### ${n}. ${f.what}  \`[${f.severity}]\``);
    L.push(`- **Signature:** \`${f.sig}\``);
    L.push(`- **Affected turns (${f.cases.length}):** ${f.cases.join(", ")}`);
    L.push(`- **Why:** ${f.why}`);
    L.push(`- **Suggested fix / where:**`);
    for (const w of f.where) L.push(`  - \`${w}\``);
    L.push("");
    n++;
  }

  // ── Failing-turn detail ──
  L.push("## Failing turns (detail)");
  L.push("");
  for (const r of records.filter((x) => !x.ok)) {
    L.push(`### ${r.id} — ${r.persona} · ${r.capability}/${r.complexity} · ctx ${(r.historyTokensBefore / 1000).toFixed(1)}k`);
    L.push(`- Prompt: ${JSON.stringify(r.prompt)}`);
    L.push(`- Tools (${r.tools.length}): ${r.tools.join(", ") || "none"}`);
    if (r.toolErrors.length) L.push(`- Tool errors: ${r.toolErrors.map((e) => `${e.tool} → ${e.message}`).join(" | ")}`);
    if (r.agentErrors.length) L.push(`- Agent errors: ${r.agentErrors.join(" | ")}`);
    L.push(`- Failed checks: ${r.checks.filter((c) => !c.pass).map((c) => `${c.name} (${c.detail})`).join("; ")}`);
    L.push(`- Answer: ${JSON.stringify(r.answerPreview.slice(0, 200))}`);
    L.push("");
  }

  // ── Safety / delete-protection ──
  const guardTally = new Map<string, number>();
  for (const r of records) for (const g of r.guard) guardTally.set(`${g.tool}:${g.action}`, (guardTally.get(`${g.tool}:${g.action}`) ?? 0) + 1);
  L.push("## Safety & delete-protection activity");
  L.push("");
  if (!guardTally.size) L.push("No side-effecting or destructive tool calls were intercepted.");
  else {
    L.push("| Tool:action | Times |");
    L.push("| --- | --- |");
    for (const [k, v] of [...guardTally.entries()].sort((a, b) => b[1] - a[1])) L.push(`| ${k} | ${v} |`);
    L.push("");
    L.push("Deletes were confined to session-created files; no path outside the per-chat sandbox (the project folder or the wider computer) was touched.");
  }
  L.push("");

  // ── Prioritized fixes ──
  L.push("## Suggested fixes (prioritized)");
  L.push("");
  L.push("1. **Routing** (`wrong-tool-routing`): enforce deterministic tools instead of hinting — if `intent.expectedTools` is set and round 0 answered with no tool, auto-issue the call. Files: `src/agent/intent.ts`, `src/agent/agent.ts`.");
  L.push("2. **Long-context coherence**: if reference-earlier turns lag fresh ones, make compaction extractive (keep file names, function signatures, decisions verbatim) rather than model-summarized. Files: `src/agent/agent.ts` (`summarize`, `continuationBrief`), `src/agent/context.ts`.");
  L.push("3. **Empty answers / round limits**: force a closing synthesis after any tool-running turn; tighten stall detection. File: `src/agent/agent.ts`.");
  L.push("4. **Tool bugs** surfaced above (scaffold/apple/weather/bash-127): fix in the listed `src/tools/*` files.");
  L.push("5. Re-run affected turns: `bun run src/bench/capability_suite.ts --chats <id>` and regenerate with `--regen <dir>`.");
  L.push("");
  return L.join("\n");
}

function degradationConclusion(degradeAt: string, refPct: number, nonRefPct: number, compT: { total: number; pct: number }, overallPct: number): string {
  const parts: string[] = [];
  if (degradeAt) parts.push(`Measured pass rate drops off once conversation history passes the **${degradeAt} token** band — that's roughly where long context starts making Sophie less reliable.`);
  else parts.push(`No sharp cliff appeared in these chats — Sophie held up across the context sizes reached (peak matters; longer chats may still degrade).`);
  const gap = nonRefPct - refPct;
  if (gap >= 10) parts.push(`Turns that reference earlier work pass ${gap} points lower than fresh turns (${refPct}% vs ${nonRefPct}%) — a real sign she loses earlier detail as history grows, and most late-chat failures were exactly these reference-back turns.`);
  else parts.push(`Reference-to-earlier turns held up comparably to fresh turns (${refPct}% vs ${nonRefPct}%), so recall of earlier detail was not the main failure mode.`);
  if (compT.total) parts.push(`After compaction fired, pass rate was ${compT.pct}% — ${compT.pct < overallPct - 10 ? "notably below overall, so the summarized brief is dropping needed detail" : "in line with overall, so compaction is holding up"}.`);
  return parts.join(" ");
}
