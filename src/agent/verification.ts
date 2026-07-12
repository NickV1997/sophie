import type { ParsedToolCall } from "../llm/qwen.ts";
import type { ToolResult } from "../tools/types.ts";
import type { AgentJob, JournalEntry, Objective, Task } from "./tasks.ts";

export function needsVerifierEvidence(objective: Objective | null, tasks: Task[]): boolean {
  const text = [objective?.content ?? "", ...tasks.map((t) => t.content)].join(" ").toLowerCase();
  return (
    /\b(code|codebase|app|application|repo|frontend|backend|ui|website|site|page|component|api|server|python|next\.?js|react|typescript|javascript|typecheck|lint)\b/.test(text) &&
    /\b(build|fix|create|scaffold|implement|write|edit|update|verify|test|make|debug|repair|change)\b/.test(text)
  );
}

export function hasVerifierEvidence(job: AgentJob | null, journal: JournalEntry[]): boolean {
  const latest = latestVerifierEntry(journal, job);
  return !!latest && latest.kind === "verification" && !latest.isError;
}

const VERIFIER_TOOLS = [
  "verify_project",
  "verify_next_app",
  "verify_python_project",
  "verify_static_site",
  "verify_package_install",
  "browser_check",
];

/** The most recent verifier/build/test attempt, pass or fail. */
export function latestVerifierEntry(journal: JournalEntry[], job?: AgentJob | null): JournalEntry | null {
  for (let i = journal.length - 1; i >= 0; i--) {
    const e = journal[i]!;
    if (job?.id && e.jobId !== job.id) continue;
    if (!e.tool) continue;
    if (e.kind === "verification" && !e.isError) return e;
    if (!e.isError) continue;
    if (isVerifierFailureEntry(e)) return e;
  }
  return null;
}

/** The most recent FAILED verifier attempt, unless a later verifier passed. */
export function lastFailedVerifier(journal: JournalEntry[], job?: AgentJob | null): JournalEntry | null {
  const latest = latestVerifierEntry(journal, job);
  return latest?.isError ? latest : null;
}

export function isVerifierFailureEntry(e: JournalEntry): boolean {
  if (!e.isError || !e.tool) return false;
  const isVerifierTool = VERIFIER_TOOLS.includes(e.tool);
    const isVerifyCommand =
      e.tool === "bash" &&
      /\b(typecheck|build|test|lint|tsc|pytest|next\s+build|eslint|vitest|jest)\b/i.test(`${e.summary} ${e.evidence ?? ""}`);
  return isVerifierTool || isVerifyCommand;
}

/**
 * Message when completion is refused. If a verifier already ran and FAILED, the
 * job is not blocked on "run a verifier" — it's blocked on the failure itself,
 * so push the model to FIX it rather than re-assert success or rationalize it.
 */
export function missingVerifierMessage(journal?: JournalEntry[]): string {
  const failed = journal ? lastFailedVerifier(journal) : null;
  if (failed) {
    return [
      `Cannot complete: your verifier ${failed.tool} FAILED (${failed.summary}).`,
      "That failure IS the remaining work. Read the error, open the file it names, fix the root cause, and re-run the verifier until it PASSES.",
      "Do not mark this completed, do not call the failure 'pre-existing' or 'unrelated', and do not re-assert success in prose.",
      "If you have genuinely tried to fix it and cannot, mark the objective blocked with the exact error, file/line, and what you tried.",
    ].join(" ");
  }
  return [
    "Refusing to mark this coding job completed without verifier evidence.",
    "Run a concrete verifier first, such as typecheck, test, build, lint, or browser_check, then include that output in objective_evidence.",
  ].join(" ");
}

export function isVerifierCall(call: ParsedToolCall, result: ToolResult): boolean {
  if (result.isError) return false;
  if (["verify_project", "verify_next_app", "verify_python_project", "verify_static_site", "verify_package_install"].includes(call.name)) return true;
  if (call.name === "browser_check") return true;
  if (call.name !== "bash") return false;
  const command = String(call.arguments.command ?? "").toLowerCase();
  return (
    /\b(npm|pnpm|bun|yarn)\s+(?:run\s+)?(?:test|typecheck|build|lint|check)\b/.test(command) ||
    /\b(tsc|pytest|ruff|mypy|vitest|jest|playwright|eslint)\b/.test(command) ||
    /\bnext\s+build\b/.test(command)
  );
}
