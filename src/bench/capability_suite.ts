/**
 * Sophie capability suite — multi-turn, persona-driven, context-aware.
 *
 * Drives 5 continuous chats (one persistent Agent each, history carried across
 * turns) so we can measure how Sophie performs as an assistant, coder, and
 * researcher — and, critically, WHERE growing context starts to degrade her.
 *
 *   bun run src/bench/capability_suite.ts                 # all 70 turns
 *   bun run src/bench/capability_suite.ts --chats rob,alex
 *   bun run src/bench/capability_suite.ts --regen <dir>   # rebuild report only
 *
 * Safety: every tool runs through the shared guard (guard.ts). Message sends,
 * calendar/schedule writes, app launches, speech, screen capture and dangerous
 * or out-of-sandbox deletes are blocked/simulated — Sophie can only delete
 * files she made this session, never the project folder or the computer.
 */

import { mkdirSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Agent, type ApprovalDecision, type ToolCallEvent } from "../agent/agent.ts";
import { setMode } from "../agent/mode.ts";
import { messagesTokens } from "../agent/context.ts";
import { config, REPO_ROOT } from "../config.ts";
import type { ToolResult } from "../tools/types.ts";
import { installGuard, type GuardEvent } from "./guard.ts";
import { CHATS, TOTAL_TURNS, type Chat, type Turn, type Complexity } from "./conversations.ts";
import { generateCapabilityReport, type TurnRecord } from "./capability_report.ts";

const TIMEOUT_MS: Record<Complexity, number> = { quick: 90_000, medium: 220_000, long: 460_000 };

function parseArgs(argv: string[]) {
  const get = (f: string) => (argv.indexOf(f) !== -1 ? argv[argv.indexOf(f) + 1] : undefined);
  return {
    chats: get("--chats")?.split(",").map((s) => s.trim()),
    regen: argv.includes("--regen") ? get("--regen") : undefined,
    noReport: argv.includes("--no-report"),
    maxTurns: get("--max-turns") ? Number(get("--max-turns")) : undefined,
  };
}

/** Files the coder/researcher prompts reference. Seeded fresh per chat sandbox. */
function seedSandbox(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "sample.ts"), "// sample TypeScript file\nexport function add(a: number, b: number): number {\n  return a + b; // TODO: handle overflow\n}\n");
  writeFileSync(join(dir, "notes.txt"), "Project notes\n- TODO: wire up storage\n- reviewed the registry\n");
  writeFileSync(join(dir, "README.md"), "# Session Sandbox\n\nScratch workspace for the capability suite. Safe to modify; do not delete files you did not create.\n");
}

async function runTurn(agent: Agent, chat: Chat, turn: Turn, turnIndex: number, guardEvents: GuardEvent[]): Promise<TurnRecord> {
  setMode(turn.mode ?? "normal");
  guardEvents.length = 0;

  const historyTokensBefore = messagesTokens(agent.getHistory());
  const historyMsgsBefore = agent.getHistory().length;

  const tools: string[] = [];
  const toolErrors: { tool: string; message: string }[] = [];
  const agentErrors: string[] = [];
  const toolNameById = new Map<string, string>();
  let answer = "";
  let toolRounds = 0;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS[turn.complexity]);
  let timedOut = false;
  controller.signal.addEventListener("abort", () => (timedOut = true), { once: true });

  const started = Date.now();
  try {
    await agent.run(
      turn.prompt,
      {
        onContent: (d) => (answer += d),
        onToolCall: (c: ToolCallEvent) => {
          tools.push(c.name);
          toolNameById.set(c.id, c.name);
          toolRounds++;
        },
        onToolResult: (id: string, r: ToolResult) => {
          if (r.isError) toolErrors.push({ tool: toolNameById.get(id) ?? "?", message: (r.display ?? r.content ?? "").slice(0, 300) });
        },
        requestApproval: async (): Promise<ApprovalDecision> => "approve",
        onError: (m) => agentErrors.push(m.slice(0, 500)),
      },
      controller.signal,
    );
  } catch (e: any) {
    agentErrors.push(`threw: ${e?.message ?? e}`);
  } finally {
    clearTimeout(timer);
  }

  const durationMs = Date.now() - started;
  const historyAfter = agent.getHistory();
  const historyTokensAfter = messagesTokens(historyAfter);
  const historyMsgsAfter = historyAfter.length;
  // Compaction replaces old transcript with a deterministic brief; detect it by
  // the brief marker rather than message-count deltas (which turn growth hides).
  const compacted = historyAfter.some(
    (m) => typeof m.content === "string" && m.content.includes("Compacted continuation brief"),
  );

  const checks = scoreTurn(turn, { tools, toolErrors, agentErrors, answer, timedOut });
  const ok = checks.every((c) => c.pass);

  return {
    id: `${chat.id}-t${String(turnIndex + 1).padStart(2, "0")}`,
    category: turn.kind,
    complexity: turn.complexity,
    prompt: turn.prompt,
    mode: turn.mode ?? "normal",
    ok,
    durationMs,
    timedOut,
    tools,
    toolRounds,
    toolErrors,
    agentErrors,
    guard: guardEvents.filter((e) => e.action !== "allow").map((e) => ({ tool: e.tool, action: e.action, reason: e.reason })),
    checks,
    answerChars: answer.replace(/\s+/g, " ").trim().length,
    answerPreview: answer.replace(/\s+/g, " ").trim().slice(0, 400),
    // capability-suite extras:
    chatId: chat.id,
    persona: chat.persona,
    turnIndex,
    capability: turn.kind,
    referencesEarlier: !!turn.referencesEarlier,
    historyTokensBefore,
    historyTokensAfter,
    historyMsgs: historyMsgsAfter,
    compacted,
  };
}

function scoreTurn(
  turn: Turn,
  ctx: { tools: string[]; toolErrors: { tool: string; message: string }[]; agentErrors: string[]; answer: string; timedOut: boolean },
): { name: string; pass: boolean; detail: string }[] {
  const checks: { name: string; pass: boolean; detail: string }[] = [];
  const answerText = ctx.answer.replace(/\s+/g, " ").trim();
  if (turn.expectAny?.length) {
    const hit = turn.expectAny.filter((t) => ctx.tools.includes(t));
    checks.push({ name: "expected-tool", pass: hit.length > 0, detail: hit.length ? `used ${hit.join(", ")}` : `used none of [${turn.expectAny.join(", ")}]; called [${[...new Set(ctx.tools)].join(", ") || "none"}]` });
  }
  if (turn.ban?.length) {
    const used = turn.ban.filter((t) => ctx.tools.includes(t));
    checks.push({ name: "no-banned-tool", pass: used.length === 0, detail: used.length ? `used banned ${used.join(", ")}` : "clean" });
  }
  if (turn.mustAnswer !== false) {
    checks.push({ name: "produced-answer", pass: answerText.length > 0, detail: answerText.length ? `${answerText.length} chars` : "empty final answer" });
  }
  checks.push({ name: "no-agent-error", pass: ctx.agentErrors.length === 0, detail: ctx.agentErrors[0] ?? "clean" });
  checks.push({ name: "no-timeout", pass: !ctx.timedOut, detail: ctx.timedOut ? "timed out" : "ok" });
  const relevant = ctx.toolErrors.find((e) => turn.expectAny?.includes(e.tool));
  checks.push({ name: "expected-tool-succeeded", pass: !relevant, detail: relevant ? `${relevant.tool}: ${relevant.message}` : "ok" });
  return checks;
}

function summarize(records: TurnRecord[]) {
  const passed = records.filter((r) => r.ok).length;
  return {
    model: config.model,
    baseUrl: config.baseUrl,
    total: records.length,
    passed,
    failed: records.length - passed,
    passRate: records.length ? +(passed / records.length).toFixed(3) : 0,
    generatedAt: new Date().toISOString(),
  };
}

function regen(dir: string): void {
  const records = readFileSync(join(dir, "results.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) as TurnRecord[];
  const summary = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"));
  writeFileSync(join(dir, "capability-report.md"), generateCapabilityReport(records, summary));
  console.log(`Regenerated ${join(dir, "capability-report.md")} from ${records.length} turns`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.regen) {
    regen(args.regen);
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outDir = join(REPO_ROOT, "bench-results", `${stamp}-capability`);
  mkdirSync(outDir, { recursive: true });
  const jsonlPath = join(outDir, "results.jsonl");

  const chats = args.chats ? CHATS.filter((c) => args.chats!.includes(c.id)) : CHATS;
  const guard = installGuard();

  console.log(`Sophie capability suite → ${outDir}`);
  console.log(`model: ${config.model}`);
  console.log(`chats: ${chats.length}   turns: ${chats.reduce((n, c) => n + c.turns.length, 0)} / ${TOTAL_TURNS}\n`);

  const records: TurnRecord[] = [];
  for (const chat of chats) {
    const sandbox = join(outDir, "sandbox", chat.id);
    seedSandbox(sandbox);
    process.chdir(sandbox);
    const agent = new Agent();
    agent.reset();
    const turnCount = args.maxTurns ? Math.min(args.maxTurns, chat.turns.length) : chat.turns.length;
    console.log(`\n=== ${chat.persona} (${turnCount} turns) ===`);
    for (let i = 0; i < turnCount; i++) {
      const turn = chat.turns[i]!;
      process.stdout.write(`  [${chat.id} ${i + 1}/${chat.turns.length}] ${turn.kind}/${turn.complexity} ... `);
      let rec: TurnRecord;
      try {
        rec = await runTurn(agent, chat, turn, i, guard.events);
      } catch (e: any) {
        rec = errorRecord(chat, turn, i, `harness threw: ${e?.message ?? e}`);
      }
      records.push(rec);
      appendFileSync(jsonlPath, JSON.stringify(rec) + "\n");
      const failed = rec.checks.filter((c) => !c.pass).map((c) => c.name);
      console.log(`${rec.ok ? "PASS" : "FAIL"} ${(rec.durationMs / 1000).toFixed(0)}s ctx:${(rec.historyTokensAfter / 1000).toFixed(1)}k tools:${rec.tools.length}${failed.length ? " — " + failed.join(",") : ""}`);
    }
  }

  guard.uninstall();

  const summary = summarize(records);
  writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  if (!args.noReport) {
    writeFileSync(join(outDir, "capability-report.md"), generateCapabilityReport(records, summary));
  }
  writeFileSync(join(REPO_ROOT, "bench-results", "latest-capability.txt"), outDir);

  console.log(`\n${summary.passed}/${summary.total} turns passed (${(summary.passRate * 100).toFixed(0)}%)`);
  console.log(`Report: ${join(outDir, "capability-report.md")}`);
  process.exitCode = summary.passed === summary.total ? 0 : 1;
}

function errorRecord(chat: Chat, turn: Turn, i: number, msg: string): TurnRecord {
  return {
    id: `${chat.id}-t${String(i + 1).padStart(2, "0")}`, category: turn.kind, complexity: turn.complexity, prompt: turn.prompt, mode: turn.mode ?? "normal",
    ok: false, durationMs: 0, timedOut: false, tools: [], toolRounds: 0, toolErrors: [], agentErrors: [msg], guard: [],
    checks: [{ name: "harness", pass: false, detail: msg }], answerChars: 0, answerPreview: "",
    chatId: chat.id, persona: chat.persona, turnIndex: i, capability: turn.kind, referencesEarlier: !!turn.referencesEarlier,
    historyTokensBefore: 0, historyTokensAfter: 0, historyMsgs: 0, compacted: false,
  };
}

main();
