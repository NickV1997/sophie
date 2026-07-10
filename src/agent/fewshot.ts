import type { TurnIntent } from "./intent.ts";

/**
 * Per-intent worked examples for the ephemeral live-state message.
 *
 * A small model imitates far better than it follows instructions: one compact
 * exchange in the exact trained format buys more correct behavior than a page
 * of rules. These ride in the ephemeral trailing message (never the cached
 * system prefix, never stored history) and only while the turn has made no
 * tool call yet — once the model's own calls are in the transcript, they are
 * the example, and these tokens are better spent on context.
 */

const QUICK_CHECK_EXAMPLE = `# Worked example (format reference only — a different conversation)
user: is there a package.json in this folder?
assistant: <tool_call>{"name":"list_dir","arguments":{"path":"."}}</tool_call>
tool: <tool_response>{"name":"list_dir","content":"src/\\npackage.json\\nREADME.md"}</tool_response>
assistant: Yes — package.json is in the current folder, alongside src/ and README.md.
(One small read-only call, then a direct sourced answer. No task list.)`;

const EDIT_EXAMPLE = `# Worked example (format reference only — a different conversation)
user: the header says "Wellcome" — fix the typo
assistant: <tool_call>{"name":"grep","arguments":{"pattern":"Wellcome","path":"src"}}</tool_call>
tool: <tool_response>{"name":"grep","content":"src/components/Header.tsx:12: <h1>Wellcome</h1>"}</tool_response>
assistant: <tool_call>{"name":"edit_file","arguments":{"path":"src/components/Header.tsx","old_string":"<h1>Wellcome</h1>","new_string":"<h1>Welcome</h1>"}}</tool_call>
tool: <tool_response>{"name":"edit_file","content":"Edited src/components/Header.tsx (1 replacement)."}</tool_response>
assistant: <tool_call>{"name":"bash","arguments":{"command":"bunx tsc --noEmit"}}</tool_call>
tool: <tool_response>{"name":"bash","content":"(exit 0)"}</tool_response>
assistant: Fixed — "Wellcome" → "Welcome" in src/components/Header.tsx:12, typecheck clean.
(Locate → exact edit → verify → report with evidence.)`;

const PLAN_EXAMPLE = `# Worked example (format reference only — a different conversation)
assistant: <tool_call>{"name":"update_tasks","arguments":{"objective":"Build a working pomodoro timer web app","tasks":[{"content":"Scaffold the Next.js app","status":"in_progress","phase":"Phase 1: Scaffold"},{"content":"Build the timer screen with start/pause/reset","status":"pending","phase":"Phase 2: Core"},{"content":"Wire session/break cycling and a completed-count","status":"pending","phase":"Phase 3: Integration"},{"content":"Run verify_next_app and browser_check; fix everything it reports","status":"pending","phase":"Phase 4: Verify"}]}}</tool_call>
(Objective + small verifiable steps grouped by phase, first task in_progress, ends with an explicit verify step. Then start executing immediately.)`;

/** Pick the one example (or none) worth its tokens for this turn. */
export function fewShotForTurn(intent: TurnIntent, mode: string): string {
  if (mode === "build") return EDIT_EXAMPLE;
  if (mode === "plan") return PLAN_EXAMPLE;
  if (intent.kind === "quick_check" || intent.kind === "standalone_action" || intent.kind === "session_query") {
    return QUICK_CHECK_EXAMPLE;
  }
  if (intent.kind === "new_job" || intent.kind === "continue_job") return EDIT_EXAMPLE;
  return ""; // chat / correction — no tool example needed
}
