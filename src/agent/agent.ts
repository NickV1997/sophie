import { config } from "../config.ts";
import { completeChat, streamChat, type ChatMessage } from "../llm/client.ts";
import { buildUserMessage } from "../llm/images.ts";
import { toolCallGrammar } from "../llm/grammar.ts";
import { buildToolsBlock, type ParsedToolCall, QwenStreamParser, repairToolCallsViaModel, type ThinkLevel, thinkDirective } from "../llm/qwen.ts";
import { BUILD_MODE_TOOLS, PLAN_MODE_TOOLS, getTool, toolSpecs } from "../tools/registry.ts";
import { validateToolArguments } from "../tools/schema.ts";
import {
  activateToolGroups,
  activeToolGroups,
  autoActivateForInput,
  disclosedToolNames,
  groupOfTool,
  resetToolGroups,
  toolCatalogBlock,
} from "../tools/groups.ts";
import type { RiskLevel, ToolResult, ToolSpec } from "../tools/types.ts";
import { searchVerifiedEpisodes } from "./episodes.ts";
import { smartRecallForPrompt } from "../memory/embeddings.ts";
import { handleMemoryIntake, learnFromRuntimeEvidence, observeUserInputForMemory } from "../memory/engine.ts";
import { protectedPathBlockReason } from "../system/protected-paths.ts";
import { protectedProcessBlockReason } from "../system/protected-processes.ts";
import { beginUndoGroup } from "../system/undo.ts";
import { beginTurnStats, endTurnStats, recordGeneration, recordPromptTokens } from "./stats.ts";
import { maybeReflectOnJob } from "./reflection.ts";
import { clipForHistory, estimateTokens, historyBudget, messagesTokens, safeMaxTokens, stripThink } from "./context.ts";
import { systemPrompt } from "./prompt.ts";
import { gate } from "./safety.ts";
import { getMode, setMode } from "./mode.ts";
import { getDefaultRuntime, runWithRuntime, type AgentRuntimeState } from "./runtime.ts";
import { fewShotForTurn } from "./fewshot.ts";
import { classifyTurnIntent, requiresTaskLedger, turnFocusForPrompt, type TurnIntent } from "./intent.ts";
import { deterministicToolCallForInput, deterministicToolCallForMissingInput } from "./deterministic_tools.ts";
import { checkToolPreconditions } from "./preconditions.ts";
import { recoveryHintForFailure } from "./recovery.ts";
import { hasVerifierEvidence, isVerifierCall, lastFailedVerifier } from "./verification.ts";
import {
  addJournalEntry,
  beginObjective,
  clearTasks,
  getCurrentJob,
  getJournal,
  getObjective,
  getTasks,
  setTasks,
  tasksForPrompt,
} from "./tasks.ts";
import { isAway } from "./presence.ts";
import { noteFileTouch, resetWorkset, worksetForPrompt } from "./workset.ts";
import {
  projectLedgerForPrompt,
  recordLedgerCommand,
  recordLedgerFile,
  resetProjectLedger,
} from "./project_ledger.ts";
import { telegramReady } from "../channels/telegram.ts";

/** fs tools whose successful calls create/change/reveal a file's contents —
 *  recorded in the working set so long conversations keep an accurate, runtime-
 *  maintained file memory instead of relying on the model to remember. */
const FILE_TOUCH_ACTIONS: Record<string, "created" | "edited" | "read"> = {
  write_file: "created",
  edit_file: "edited",
  apply_edits: "edited",
  replace_lines: "edited",
  read_file: "read",
};

export interface ToolCallEvent {
  id: string;
  name: string;
  args: Record<string, unknown>;
  summary: string;
  risk: RiskLevel;
}

export type ApprovalDecision = "approve" | "deny";

export interface AgentCallbacks {
  onThinking?(delta: string): void;
  onContent?(delta: string): void;
  onToolCall?(call: ToolCallEvent): void;
  onToolResult?(id: string, result: ToolResult): void;
  /** Diagnostic hook for benchmarks/tests: receives the exact model prompt. */
  onPrompt?(messages: ChatMessage[], promptTokens: number): void;
  /** Called after model-facing history changes so the UI can persist progress. */
  onCheckpoint?(): void;
  /** Resolve with the user's decision for a caution/dangerous call. */
  requestApproval(call: ToolCallEvent): Promise<ApprovalDecision>;
  onError?(message: string): void;
}

/** Hard cap on tool rounds per turn — high, since long tasks need many. The
 *  real governor on length is context compaction, not this number. */
const MAX_ROUNDS = 200;
/** How many times we'll re-prompt a stalled model to finish its task list. */
const MAX_NUDGES = 12;
/** Retries for a generation that fails before producing any output. */
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 800;
/** Hard foreground ceiling for any one tool. Longer work should use run_background. */
const TOOL_TIMEOUT_MS = 3 * 60 * 1000;
/** Compact history once it reaches this fraction of its token budget. */
const COMPACT_AT = 0.58;
/** Messages kept verbatim (newest) when compacting; the rest are summarized. */
const KEEP_RECENT = 12;
/** On long tasks the model doesn't need the full text of every past tool result
 *  — only the last few. Older large tool outputs are elided to a stub (the task
 *  ledger, journal, and working set retain the durable facts). */
const KEEP_TOOL_OUTPUTS = 6;
/** Tool outputs shorter than this are cheap — leave them verbatim. */
const TOOL_OUTPUT_STUB_MIN = 400;
/** Identical tool calls before we warn the model it's looping. On the call
 *  after this limit the tool is hard-blocked and NOT executed. */
const REPEAT_LIMIT = 3;
/** Minimum ms between run_background calls with the same command. */
const BG_COOLDOWN_MS = 60_000;
/** Minimum meaningful content-sig length (chars). Sigs shorter than this are
 *  too generic ("ok", "...", etc.) to reliably detect a cycle. */
const CONTENT_SIG_MIN = 30;
/** Failed verifier attempts (with no pass) before we stop and hand the concrete
 *  blocker back to the user instead of letting the model spin to MAX_ROUNDS. */
const VERIFIER_ESCALATE_AFTER = 5;
/** Consecutive tool rounds with zero mutating-tool success before triggering a
 *  graceful synthesis exit. Catches "rotating reads with no real progress" spirals. */
const STALL_ROUNDS = 8;
/** Build/coding turns that only read for this many tool rounds get redirected
 *  before they drift into a long read-only loop. */
const READ_ONLY_STALL_ROUNDS = 3;
/** Minimum tool rounds completed before stale-progress detection kicks in.
 *  Avoids false positives on short read-only turns. */
const MIN_TOOL_ROUNDS_FOR_STALL = 4;
/** Same content-sig appearing this many additional times (≥3 total) triggers
 *  synthesis exit rather than another nudge that the model ignores. */
const CONTENT_SPIRAL_EXIT = 2;
const TOOL_CANCELLED = "(cancelled)";
/** Read-only tools with no side effects — safe to run in parallel in one round. */
const PARALLEL_SAFE = new Set([
  "read_file", "list_dir", "glob", "grep", "find_images", "describe_images",
  "web_search", "web_fetch", "current_time", "where_am_i", "system_info",
  "load_skill", "job_status", "search_sessions",
]);

const READ_ONLY_TOOLS = new Set([
  "read_file", "list_dir", "glob", "grep", "find_images", "describe_images",
  "web_search", "web_fetch", "current_time", "where_am_i", "system_info",
  "load_skill", "job_status", "search_sessions", "project_map",
]);

/** Tools that represent real forward progress — mutating state or completing tasks.
 *  Used by stale-progress detection to distinguish "doing work" from "spinning". */
const MUTATING_TOOLS = new Set([
  "write_file", "edit_file", "apply_edits", "replace_lines",
  "scaffold_project", "scaffold_python_project", "scaffold_next_shadcn_project",
  "update_tasks",
]);

const CODING_PROGRESS_TOOLS = new Set([
  ...MUTATING_TOOLS,
  "install_deps",
  "add_ui_component",
  "project_checks",
  "git_checkpoint",
  "verify_project",
  "verify_next_app",
  "verify_python_project",
  "verify_static_site",
  "verify_package_install",
  "browser_check",
]);

const QUICK_CHECK_TOOLS = new Set([
  "read_file",
  "list_dir",
  "glob",
  "grep",
  "find_images",
  "describe_images",
  "current_time",
  "where_am_i",
  "system_info",
  "calc",
  "weather",
]);

const SESSION_QUERY_TOOLS = new Set(["search_sessions", "current_time"]);

/** Tools whose large outputs carry their signal at the END (command/build/test
 *  output) — history clipping keeps the tail for these instead of the head. */
const TAIL_CLIPPED_TOOLS = new Set(["bash", "run_background", "job_status", "wait_for"]);

const CORRECTION_TOOLS = new Set([
  "read_file",
  "list_dir",
  "glob",
  "grep",
  "search_sessions",
  "current_time",
  "update_tasks",
]);

const CODING_JOB_TOOLS = new Set([
  "read_file",
  "write_file",
  "edit_file",
  "apply_edits",
  "replace_lines",
  "scaffold_project",
  "scaffold_python_project",
  "scaffold_next_shadcn_project",
  "install_deps",
  "add_ui_component",
  "project_checks",
  "git_checkpoint",
  "list_dir",
  "glob",
  "grep",
  "project_map",
  "browser_check",
  "bash",
  "run_background",
  "job_status",
  "wait_for",
  "web_search",
  "web_fetch",
  "search_verified_memory",
  "current_time",
  "system_info",
  "load_skill",
  "save_skill",
  "update_tasks",
  "set_mode",
  "verify_project",
  "verify_next_app",
  "verify_python_project",
  "verify_static_site",
  "verify_package_install",
  "stop_webapp",
]);

/**
 * Holds conversation state and runs the think→act→observe loop against the
 * local model. One Agent instance per Sophie session.
 */
export class Agent {
  /** Persisted turns (user / assistant / tool-response). No system prompt. */
  private history: ChatMessage[] = [];
  private cwd = process.cwd();
  /** Set when a tool (e.g. ask_user) asks to end the turn and wait for the user. */
  private endTurnRequested = false;
  /** Local TUI messages sent while a turn is running. Applied at safe checkpoints. */
  private steeringInbox: string[] = [];
  /** Tracks when each run_background command was last started (persists across turns). */
  private bgCooldowns = new Map<string, number>();

  constructor(private readonly runtime: AgentRuntimeState = getDefaultRuntime()) {}

  getRuntime(): AgentRuntimeState {
    return this.runtime;
  }

  reset(): void {
    runWithRuntime(this.runtime, () => {
      this.history = [];
      this.steeringInbox = [];
      clearTasks();
      resetToolGroups();
      resetWorkset();
      resetProjectLedger();
    });
  }

  /** Add a local steering note for the active run to read before it keeps acting. */
  steer(input: string): void {
    const text = input.trim();
    if (text) this.steeringInbox.push(text);
  }

  hasPendingSteering(): boolean {
    return this.steeringInbox.length > 0;
  }

  /** Snapshot/restore the model-facing history (for session persistence). */
  getHistory(): ChatMessage[] {
    return this.history;
  }
  restoreHistory(history: ChatMessage[]): void {
    this.history = history;
  }

  /** Run one user turn to completion (through any number of tool rounds). */
  async run(input: string, cb: AgentCallbacks, signal?: AbortSignal): Promise<void> {
    return runWithRuntime(this.runtime, async () => {
      // Wrap the whole turn so per-turn bookkeeping runs on every exit path.
      beginUndoGroup(input); // file edits this turn become one /undo unit
      beginTurnStats();
      try {
        await this.runTurn(input, cb, signal);
      } finally {
        endTurnStats();
        learnFromRuntimeEvidence(this.cwd);
        // If a job just completed after real failures, distill a lesson (async).
        maybeReflectOnJob(this.cwd);
      }
    });
  }

  private async runTurn(input: string, cb: AgentCallbacks, signal?: AbortSignal): Promise<void> {
    this.endTurnRequested = false;
    const userMessage = buildUserMessage(input, this.cwd);
    observeUserInputForMemory(input, this.cwd);
    if (userMessage.wantedImage && userMessage.attachments.length === 0 && !shouldRouteImageRequestToTools(input)) {
      const missing = userMessage.missingRefs.length
        ? ` I could not find or attach: ${userMessage.missingRefs.join(", ")}.`
        : " I could not find a readable image to attach.";
      cb.onError?.(
        `${missing} Reference an exact file path like @~/Desktop/screenshot.png so I can send it to the vision model.`,
      );
      return;
    }
    if (userMessage.attachments.length > 0) {
      cb.onToolResult?.(crypto.randomUUID(), {
        content: `Attached image${userMessage.attachments.length === 1 ? "" : "s"} to the model: ${userMessage.attachments.join(", ")}`,
        display: `vision: ${userMessage.attachments.map((p) => p.split("/").pop()).join(", ")}`,
      });
    }
    const memoryIntake = handleMemoryIntake(input, this.cwd);
    if (memoryIntake) {
      const id = crypto.randomUUID();
      cb.onToolCall?.({
        id,
        name: "remember",
        args: { fact: memoryIntake.memories.map((m) => m.capsule).join("; "), scope: "auto" },
        summary: `${memoryIntake.memories.length} compact memor${memoryIntake.memories.length === 1 ? "y" : "ies"}`,
        risk: "safe",
      });
      cb.onToolResult?.(id, { content: memoryIntake.summary, display: "memory saved" });
      const userSummary = `[Memory intake request summarized by runtime]\n${memoryIntake.memories.map((m) => `- ${m.capsule}`).join("\n")}`;
      const answer = `${memoryIntake.summary}.`;
      this.history.push({ role: "user", content: userSummary });
      this.history.push({ role: "assistant", content: answer });
      addJournalEntry({
        kind: "tool_result",
        tool: "remember",
        summary: "Runtime saved explicit memory intake without invoking the model.",
        evidence: memoryIntake.memories.map((m) => m.capsule).join("; "),
      });
      cb.onContent?.(answer);
      cb.onCheckpoint?.();
      return;
    }
    let intent = classifyTurnIntent(input, { objective: getObjective(), tasks: getTasks() });
    // Disclose deferred tool groups this message clearly needs, so their
    // schemas are already in the prompt on round one.
    autoActivateForInput(input);
    if (intent.resetReason) {
      this.history = [];
      clearTasks();
      // Abandon a stale job's mode too, so a fresh request re-routes cleanly and
      // we never get stuck in build/plan from a previous, unrelated task.
      if (getMode() !== "normal") setMode("normal");
      addJournalEntry({
        kind: "decision",
        summary: "Cleared stale active objective for a new user request.",
        evidence: intent.resetReason,
      });
      cb.onCheckpoint?.();
    }

    this.history.push(userMessage.message);
    const expectedAction = intent.requiresAction;
    const shouldTrackTasks = intent.shouldTrackTasks;
    if (expectedAction && !shouldTrackTasks && hasSimpleAutoLedger()) {
      clearTasks();
      cb.onCheckpoint?.();
    }
    if (shouldTrackTasks && !getTasks().length && !getObjective()) {
      beginObjective(input);
      setTasks([
        {
          content: "Inspect the relevant local context before acting",
          status: "in_progress",
          updatedAt: Date.now(),
          attempts: 1,
        },
        {
          content: "Do the requested work using the appropriate tools",
          status: "pending",
          updatedAt: Date.now(),
        },
        {
          content: "Verify the result and report concrete evidence",
          status: "pending",
          updatedAt: Date.now(),
        },
      ]);
      addJournalEntry({
        kind: "decision",
        summary: "Runtime seeded an objective and task journal for an action-oriented request.",
      });
      cb.onCheckpoint?.();
    }

    // Auto-routing (from normal mode only — never override an explicit user mode
    // or a continued job): a coding request enters BUILD; a non-coding new job
    // drops into standalone PLAN and hands off to normal. We don't route small
    // quick-checks/chat.
    let autoPlanned = false;
    if (shouldAutoBuild(getMode(), intent, input)) {
      setMode("build");
      addJournalEntry({ kind: "decision", summary: "Runtime entered BUILD mode for a coding request." });
      cb.onCheckpoint?.();
    } else if (shouldAutoPlan(getMode(), intent, input)) {
      setMode("plan");
      autoPlanned = true;
      addJournalEntry({ kind: "decision", summary: "Runtime entered PLAN mode to think the task through before acting." });
      cb.onCheckpoint?.();
    }

    let nudges = 0;
    let toolRounds = 0;
    let staleRounds = 0;
    let readOnlyRounds = 0;
    let synthesizing = false;
    const callCounts = new Map<string, number>();
    const failureCounts = new Map<string, number>();
    const deniedCalls = new Set<string>();
    // Approval-gated calls that already SUCCEEDED this turn (sig → outcome).
    // Re-issuing one (a common small-model quirk after "Sent!") must not send
    // a message / run a risky command twice, nor re-prompt the user.
    const completedSideEffects = new Map<string, string>();
    const successfulTools = new Set<string>();
    // Escape latch: if the model explicitly calls a tool the heuristic intent
    // didn't allow, we trust the model over the guess and stop restricting for
    // the rest of the turn (so one misclassification never dead-ends a task).
    const escalation = { active: false };

    // Retrieve the long-term facts relevant to THIS message, once per turn —
    // semantic (embeddings) when available, keyword otherwise. recall
    // reinforces what it surfaces, so it must not run per-round; the result
    // rides in the ephemeral live-state message, never the cached prefix.
    // Returns "" when nothing matches — unrelated turns inject nothing.
    const memoryRecall = await smartRecallForPrompt(input, this.cwd);

    const limits = runtimeLimits(getMode());
    for (let round = 0; round < limits.maxRounds; round++) {
      // On the penultimate round, proactively switch to synthesis so the final
      // generation produces a coherent user-facing answer instead of hitting the
      // hard limit and showing an error.
      if (round === limits.maxRounds - 2 && !synthesizing) {
        synthesizing = true;
        addJournalEntry({
          kind: "blocker",
          summary: `Approaching round limit (${round + 1}/${limits.maxRounds}) — switching to synthesis exit.`,
          isError: true,
        });
        this.history.push({ role: "user", content: spiralSynthesisPrompt(round + 1, "round limit") });
      }
      if (this.applySteering(cb)) continue;
      if (escalation.active && intent.restrictTools) {
        intent = { ...intent, restrictTools: false };
        addJournalEntry({
          kind: "decision",
          summary: "Lifted intent-based tool restrictions for this turn; advertising the full toolset.",
        });
      }
      // Read mode fresh each round: the user (Shift+Tab) or Sophie (set_mode)
      // may have changed it, and that must take effect on the next generation.
      const mode = getMode();
      const toolsBlock = buildToolsBlock(toolSpecsForModeAndIntent(mode, intent, input)) + toolCatalogBlock();
      // Sampler-level constraint on tool-call syntax (llama.cpp lazy grammar).
      // Built over ALL registered tools, not just the disclosed ones, so the
      // deferred-tool escape hatch is never blocked by the grammar.
      const grammar = config.toolGrammar ? toolCallGrammar(toolSpecs().map((s) => s.name)) : undefined;
      // Reasoning effort by mode: plan = medium, build = low, normal/audio = off.
      const thinkLevel = reasoningForMode(mode);
      const think = thinkDirective(thinkLevel);
      // Prose rounds (first round with no tools yet, or synthesis) benefit from
      // slightly higher temperature for natural language; subsequent tool rounds
      // benefit from lower temperature for precise argument selection.
      const temperature = mode === "plan" || mode === "build" ? config.temperature : Math.max(config.temperature, 0.7);
      // Signal to the client that we expect tool calls this round so it can
      // lower temperature for more deterministic argument selection.
      const expectingTools = toolRounds > 0 && !synthesizing;
      // Qwen3 recommendation: top_p=0.95 with thinking, 0.8 without.
      // Non-thinking mode has no reasoning filter so a tighter top_p helps.
      const topP = thinkLevel === "off" ? 0.8 : 0.95;

      // The system prompt is byte-stable (no per-round state), so llama.cpp can
      // reuse its cached KV for the big tools/skills/memory prefix every round.
      const sys = systemPrompt(mode, this.cwd, toolsBlock);

      // Trim stale tool outputs first (cheap), then compact the transcript if
      // it's still over budget. Keep history within a coherent size so a run can
      // continue for hours without the model bogging down in a huge window.
      this.pruneToolHistory();
      await this.compact(estimateTokens(sys), signal);

      // Volatile state (live task list + the /think|/no_think switch) rides at
      // the END as an ephemeral message, so it never busts the cached prefix.
      const taskBlock = tasksForPrompt();
      const verifiedMemory = verifiedMemoryForTurn(input, intent);
      // While the runtime is auto-planning, tell Sophie to drive the plan→execute
      // handoff herself (don't stop for review — she didn't ask, the runtime did).
      const planHandoff =
        mode === "plan" && autoPlanned
          ? "[Runtime] You are auto-planning. Find the most efficient approach, lay out the ordered steps with update_tasks, then START executing: set_mode('build') if the work involves coding, else set_mode('normal'). Do not stop for review.\n\n"
          : "";
      const awayNote = isAway()
        ? `[Presence] The user is AWAY from the terminal — assume no one is watching this screen. To tell them something, ask a question, or get approval, use the notify tool${telegramReady() ? " (set expect_reply to wait for their Telegram answer)" : ""} rather than just printing and stopping. Don't start risky or irreversible work that needs their sign-off without reaching them first.\n\n`
        : "";
      // A worked example teaches the call format best BEFORE the first call;
      // after that the model's own transcript is the example — save the tokens.
      const fewShot = toolRounds === 0 ? fewShotForTurn(intent, mode) : "";
      // Runtime-maintained file memory: keeps long, reference-back turns from
      // losing track of what was already created/edited as history grows.
      const workset = worksetForPrompt(this.cwd);
      const projectLedger = projectLedgerForPrompt(this.cwd);
      const liveState =
        `[Live state — system-provided, not from the user]\n${turnFocusForPrompt(input, intent)}\n\n` +
        `${awayNote}` +
        `${memoryRecall ? `${memoryRecall}\n\n` : ""}` +
        `${verifiedMemory ? `${verifiedMemory}\n\n` : ""}` +
        `${projectLedger ? `${projectLedger}\n\n` : ""}` +
        `${workset ? `${workset}\n\n` : ""}` +
        `${planHandoff}` +
        `${fewShot ? `${fewShot}\n\n` : ""}` +
        `${taskBlock ? `${taskBlock}\n\n` : ""}${think}`;
      const { systemContent, historyMessages } = prepareMessages(sys, this.history);
      const messages: ChatMessage[] = [
        { role: "system", content: systemContent },
        ...historyMessages,
        { role: "user", content: liveState },
      ];
      // Clamp completion tokens to the room left in the window so the full
      // request (prompt + reply) can never exceed what the server accepts.
      const promptTokens = messagesTokens(messages);
      const maxTokens = safeMaxTokens(promptTokens);
      recordPromptTokens(promptTokens); // feed the TUI's context gauge
      cb.onPrompt?.(messages, promptTokens);

      // Generate, retrying transient failures that happen before any output.
      let parser!: QwenStreamParser;
      let genErr: unknown = null;
      let contentBuffer = "";
      let thinkingBuffer = "";
      let flushedGenerated = false;
      const flushGenerated = () => {
        if (flushedGenerated) return;
        flushedGenerated = true;
        if (thinkingBuffer) cb.onThinking?.(thinkingBuffer);
        if (contentBuffer) cb.onContent?.(contentBuffer);
      };
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        contentBuffer = "";
        thinkingBuffer = "";
        flushedGenerated = false;
        parser = new QwenStreamParser(
          (d) => {
            contentBuffer += d;
          },
          (d) => {
            thinkingBuffer += d;
          },
        );
        const genStart = Date.now();
        try {
          for await (const delta of streamChat(messages, { temperature, topP, signal, maxTokens, grammar, thinking: thinkLevel, expectingTools })) {
            parser.push(delta);
          }
          recordGeneration(parser.fullText.length, Date.now() - genStart);
          genErr = null;
          break;
        } catch (e: any) {
          if (e?.name === "AbortError") {
            this.history.push({ role: "assistant", content: parser.fullText || "(cancelled)" });
            return;
          }
          genErr = e;
          // Only retry if nothing was generated yet. Visible output is buffered
          // until loop detection decides this response is not a repeat.
          if (!parser.fullText && attempt < MAX_RETRIES) {
            await new Promise((r) => setTimeout(r, RETRY_BASE_MS * 2 ** attempt));
            continue;
          }
          flushGenerated();
          break;
        }
      }
      if (genErr) {
        cb.onError?.(
          `Model request failed${parser.fullText ? " mid-stream" : ` after ${MAX_RETRIES} retries`}: ${
            (genErr as any)?.message ?? genErr
          }`,
        );
        return;
      }

      let toolCalls = parser.finalize();
      const assistantText = parser.fullText.trim() || "...";

      // Content-cycle detection: if the model has generated the same visible text
      // in this turn before (a loop, not just a stall), inject a hard nudge so it
      // doesn't spin indefinitely.  This catches small-model cycles like:
      //   "Let me update the tasks." → update_tasks → "Let me update the tasks." → …
      // Check against a temporary history that includes the current message so
      // countContentRepeats can exclude it while scanning prior assistant text.
      const sig = contentSig(assistantText);
      const historyWithCurrent = [...this.history, { role: "assistant" as const, content: assistantText }];
      const contentRepeats = countContentRepeats(historyWithCurrent, sig);
      if (contentRepeats >= 1) {
        this.history.push({ role: "assistant", content: assistantText });
        cb.onCheckpoint?.();
        addJournalEntry({
          kind: "blocker",
          summary: `Content cycle suppressed — same output generated ${contentRepeats + 1}× in this turn.`,
          evidence: sig.slice(0, 120),
          isError: true,
        });
        if (contentRepeats >= CONTENT_SPIRAL_EXIT && !synthesizing) {
          // Same response 3+ times — nudging isn't working; force synthesis exit.
          synthesizing = true;
          addJournalEntry({
            kind: "blocker",
            summary: `Content spiral: same output ${contentRepeats + 1}× — switching to synthesis exit.`,
            isError: true,
          });
          this.history.push({ role: "user", content: spiralSynthesisPrompt(toolRounds, "content spiral") });
          nudges = limits.maxNudges; // exhaust budget to suppress further nudges
          continue;
        }
        this.history.push({
          role: "user",
          content:
            `[Loop detected] Your last response repeated prior output and was not shown to the user. ` +
            "You are in a loop. Re-read the task ledger/journal, then continue from the next unfinished step. Do NOT repeat the same answer or tool call. " +
            "Choose exactly ONE of these exits:\n" +
            "1. Call a different useful tool or the same tool with materially different arguments.\n" +
            "2. Call update_tasks with objective_status 'blocked' and a specific blocker.\n" +
            "3. Give a direct final answer with new information and stop.",
        });
        nudges++; // count against the nudge budget so runaway loops eventually halt
        continue;
      }

      if (toolCalls.length === 0 && parser.hasStartedToolCall()) {
        // A call opened but nothing parsed. Before burning a whole round on a
        // "try again" nudge, re-emit just the broken body as forced JSON — one
        // cheap deterministic completion recovers almost all of these.
        toolCalls = await repairToolCallsViaModel(parser.fullText, signal);
        if (toolCalls.length) {
          addJournalEntry({
            kind: "decision",
            summary: `Repaired ${toolCalls.length} malformed tool call${toolCalls.length === 1 ? "" : "s"} via constrained re-emit.`,
          });
        }
      }
      if (toolCalls.length === 0 && parser.hasStartedToolCall()) {
        this.history.push({ role: "assistant", content: assistantText });
        cb.onCheckpoint?.();
        this.history.push({
          role: "user",
          content:
            "Your previous <tool_call> block was missing, incomplete, or could not be parsed as valid JSON, so no tool ran. " +
            "Retry the tool call now using exactly this shape and no prose inside the tag: " +
            '<tool_call>{"name":"tool_name","arguments":{"arg":"value"}}</tool_call>',
        });
        continue;
      }

      // Synthesis mode: the model is being guided to wrap up — only allow
      // update_tasks (to mark blocked); redirect everything else.
      if (synthesizing && toolCalls.length > 0) {
        const tasksOnly = toolCalls.filter((c) => c.name === "update_tasks");
        if (tasksOnly.length < toolCalls.length) {
          this.history.push({
            role: "user",
            content:
              "[Synthesis mode active — no further tool calls are permitted except update_tasks. " +
              "Give the user your best answer from what you have found, or use update_tasks to mark the objective blocked with a concrete reason.]",
          });
          toolCalls = tasksOnly;
          if (toolCalls.length === 0) continue; // force re-generation without tools
        }
      }

      let suppressAssistantForForcedTool = false;
      if (toolCalls.length === 0) {
        const forced =
          !synthesizing &&
          (toolRounds === 0
            ? deterministicToolCallForInput(input, intent)
            : deterministicToolCallForMissingInput(input, intent, successfulTools));
        if (forced) {
          toolCalls = [forced];
          suppressAssistantForForcedTool = true;
          addJournalEntry({
            kind: "decision",
            summary: `Enforced deterministic routing to ${forced.name}; model answered before using all required deterministic tools.`,
          });
          // Do not flush or record the premature answer. It was rejected before
          // the user saw it, so the next answer should be a clean synthesis from
          // the forced tool result instead of a duplicated correction.
          this.history.push({
            role: "user",
            content:
              `[Runtime deterministic routing] Your last answer was not accepted because this request still requires ${forced.name}. ` +
              `I am running ${forced.name} now; use its result before answering. Do not compute or guess this value in prose when the tool is available.`,
          });
          cb.onCheckpoint?.();
        } else {
        if (expectedAction && toolRounds === 0 && nudges < limits.maxNudges) {
          nudges++;
          const hasLedger = getTasks().length > 0 || !!getObjective();
          const toolHint = intent.expectedTools?.length
            ? ` Use ${intent.expectedTools.join(" or ")} for this request.`
            : "";
          this.history.push({
            role: "user",
            content:
              (hasLedger
                ? `This user request requires local action or inspection. You have not used any tools yet.${toolHint} Start with the in_progress task and call the appropriate tool now. `
                : `This user request requires a quick local check or concrete local action. You have not used any tools yet.${toolHint} Call one appropriate tool now, then answer directly. Do not create a task list for this simple check. `) +
              "Do not answer from memory.",
          });
          continue;
        }
        if (looksLikePromisedAction(parser.fullText) && nudges < limits.maxNudges) {
          nudges++;
          this.history.push({
            role: "user",
            content:
              "You said you were going to inspect, verify, fix, run, read, check, or start something, " +
              "but you did not call a tool. Continue now with the necessary tool call, or answer directly if no tool is needed.",
          });
          continue;
        }
        // The model stopped. If its own task list still has open items, it
        // likely narrated and quit mid-job — nudge it to keep going (capped, so
        // we never spin). This is what keeps a small model coherent on long tasks.
        const tasks = getTasks();
        const objective = getObjective();
        const incompleteTasks = tasks.some((t) => t.status !== "completed");
        const objectiveOpen = tasks.length > 0 && objective?.status === "active";
        if (shouldTrackTasks && (incompleteTasks || objectiveOpen) && nudges < limits.maxNudges) {
          nudges++;
          this.history.push({
            role: "user",
            content:
              `${readOnlyRounds >= READ_ONLY_STALL_ROUNDS ? "You have only gathered context so far; the next step must write/edit/scaffold, run a concrete verifier/check, or mark the job blocked with a specific blocker. " : ""}` +
              "You are not finished. Continue now without waiting: work the in_progress item with your tools, mark each task completed via update_tasks as you finish it, and do not stop until every task is done AND the final objective is marked completed with objective_evidence. If you are genuinely blocked, call update_tasks with objective_status 'blocked' and the concrete blocker.",
          });
          continue;
        }
        flushGenerated();
        this.history.push({ role: "assistant", content: assistantText });
        cb.onCheckpoint?.();
        return; // plain answer — turn complete.
        }
      }
      if (!suppressAssistantForForcedTool) {
        flushGenerated();
        // Record what the assistant produced this round (verbatim, incl. tool calls).
        this.history.push({ role: "assistant", content: assistantText });
        cb.onCheckpoint?.();
      }

      // A local steering message should take priority over whatever the model
      // just planned. Re-prompt with the correction before running any tool call.
      if (this.applySteering(cb)) continue;

      nudges = 0; // progress made; refresh the continuation budget
      toolRounds++;

      // Small models sometimes emit the SAME call twice in one response (e.g.
      // two identical messages_send blocks). Execute each unique call once —
      // for a side-effecting tool a duplicate means a double send, and for an
      // approval-gated one it means asking the user twice for the same thing.
      const seenSigs = new Set<string>();
      const uniqueCalls: ParsedToolCall[] = [];
      let duplicatesSkipped = 0;
      for (const c of toolCalls) {
        const s = `${c.name}:${JSON.stringify(c.arguments)}`;
        if (seenSigs.has(s)) {
          duplicatesSkipped++;
          continue;
        }
        seenSigs.add(s);
        uniqueCalls.push(c);
      }
      toolCalls = uniqueCalls;

      // If every call is an independent read-only tool needing no approval, run
      // them in parallel; otherwise sequentially (so approvals stay interactive
      // and stateful tools like set_mode/update_tasks keep their order).
      const parallel =
        limits.allowParallelTools &&
        toolCalls.length > 1 &&
        toolCalls.every((c) => {
          const t = getTool(c.name);
          return !!t && PARALLEL_SAFE.has(c.name) && gate(t, c.arguments, getMode()).decision === "run";
        });

      // Shared counter incremented by runCall for each mutating-tool success.
      const roundProgress = { count: 0, successfulTools };
      let responses: string[];
      if (parallel) {
        responses = await Promise.all(toolCalls.map((c) => this.runCall(c, cb, callCounts, failureCounts, deniedCalls, completedSideEffects, this.bgCooldowns, intent, escalation, roundProgress, signal)));
      } else {
        responses = [];
        for (const call of toolCalls) responses.push(await this.runCall(call, cb, callCounts, failureCounts, deniedCalls, completedSideEffects, this.bgCooldowns, intent, escalation, roundProgress, signal));
      }
      if (signal?.aborted) return;
      if (duplicatesSkipped) {
        responses.push(
          wrapResponse(
            "runtime",
            `[${duplicatesSkipped} duplicate tool call${duplicatesSkipped === 1 ? "" : "s"} in your last message ${duplicatesSkipped === 1 ? "was" : "were"} identical to one already listed and ran only once. Never emit the same tool call twice in one response.]`,
          ),
        );
      }

      // Feed tool outputs back for the next round as proper `tool` messages so
      // the model cleanly distinguishes tool results from user input.
      for (const r of responses) this.history.push({ role: "tool", content: r });
      cb.onCheckpoint?.();

      const codingContext = mode === "build" || (shouldTrackTasks && looksLikeCodingRequest(input));
      const readOnlyRound = toolCalls.length > 0 && toolCalls.every((c) => READ_ONLY_TOOLS.has(c.name));
      if (codingContext && readOnlyRound && roundProgress.count === 0) {
        readOnlyRounds++;
        if (readOnlyRounds >= READ_ONLY_STALL_ROUNDS && !synthesizing) {
          this.history.push({
            role: "user",
            content:
              "[Coding progress guard] You have spent several rounds only reading/searching. The next action must make concrete progress: write/edit/scaffold code, install/add required dependencies, run project_checks or a typed verifier, or call update_tasks with objective_status 'blocked' and the exact blocker. Do not perform another read-only round unless it names a specific file/error needed for the next edit.",
          });
          nudges++;
          readOnlyRounds = 0;
          continue;
        }
      } else if (roundProgress.count > 0 || !readOnlyRound) {
        readOnlyRounds = 0;
      }

      // Stale-progress detection: if enough rounds have passed without any tool
      // that actually mutates state succeeding, the model is spinning (reading
      // the same files, retrying failing commands, etc.) — trigger synthesis exit.
      if (roundProgress.count > 0) {
        staleRounds = 0;
      } else if (toolRounds >= MIN_TOOL_ROUNDS_FOR_STALL) {
        staleRounds++;
        if (staleRounds >= STALL_ROUNDS && !synthesizing) {
          synthesizing = true;
          addJournalEntry({
            kind: "blocker",
            summary: `Stale spiral: ${staleRounds} consecutive rounds with no forward progress after ${toolRounds} tool rounds.`,
            isError: true,
          });
          this.history.push({ role: "user", content: spiralSynthesisPrompt(toolRounds, "stale") });
          nudges = limits.maxNudges;
        }
      }

      this.advanceBuildPipeline(cb);

      // ask_user (or any tool) requested an end-of-turn: surface it and wait for
      // the user's reply. Mode persists, so the answer continues here.
      if (this.endTurnRequested) {
        this.endTurnRequested = false;
        return;
      }

      // Safety valve: if a verifier keeps failing and nothing has passed, the
      // model is stuck re-trying/rationalizing instead of converging. Stop and
      // hand the concrete blocker to the user rather than spinning to maxRounds.
      const verifierFailures = Math.max(
        0,
        ...[...failureCounts].filter(([fam]) => fam.startsWith("verify") || fam.startsWith("browser_check")).map(([, n]) => n),
      );
      if (
        verifierFailures >= VERIFIER_ESCALATE_AFTER &&
        !hasVerifierEvidence(getCurrentJob(), getJournal())
      ) {
        const failed = lastFailedVerifier(getJournal());
        const blocker = failed ? `${failed.tool} keeps failing — ${failed.summary}` : "a verifier keeps failing";
        addJournalEntry({
          kind: "blocker",
          summary: "Stopped and escalated to the user after repeated verifier failures.",
          evidence: `${blocker}${failed?.evidence ? `\n${failed.evidence}` : ""}`,
          isError: true,
        });
        cb.onError?.(
          `Stopping after ${verifierFailures} failed verifier attempts without a pass — I won't loop. ` +
            `Blocker: ${blocker}. The app isn't clean yet; fix this specific error or tell me how you'd like to proceed.`,
        );
        return;
      }
    }

    if (!synthesizing) {
      cb.onError?.(`Reached the ${limits.maxRounds}-step limit for one turn. Stopping.`);
    }
  }

  private applySteering(cb: AgentCallbacks): boolean {
    if (!this.steeringInbox.length) return false;
    const notes = this.steeringInbox.splice(0);
    const content = [
      "[User steering received while you were already working]",
      ...notes.map((note, i) => `${i + 1}. ${note}`),
      "",
      "Treat this as the latest user instruction for the active task. Re-evaluate the next action before calling another tool. If this changes the plan, update the task list/journal first. Do not run a previously planned tool call that conflicts with this steering.",
    ].join("\n");
    this.history.push({ role: "user", content });
    addJournalEntry({
      kind: "decision",
      summary: `Applied ${notes.length} live steering message${notes.length === 1 ? "" : "s"} from the local TUI.`,
      evidence: notes.map((n) => `- ${clipOneLine(n, 220)}`).join("\n"),
    });
    cb.onCheckpoint?.();
    return true;
  }

  /**
   * Execute one tool call: classify → (block / approve) → run → clip → return
   * the response envelope for history. Pure enough to run in parallel.
   */
  private async runCall(
    call: ParsedToolCall,
    cb: AgentCallbacks,
    callCounts: Map<string, number>,
    failureCounts: Map<string, number>,
    deniedCalls: Set<string>,
    completedSideEffects: Map<string, string>,
    bgCooldowns: Map<string, number>,
    intent: TurnIntent,
    escalation: { active: boolean },
    roundProgress: { count: number; successfulTools?: Set<string> },
    signal?: AbortSignal,
  ): Promise<string> {
    const id = crypto.randomUUID();
    const tool = getTool(call.name);
    if (!tool) {
      const msg = `Unknown tool "${call.name}".`;
      cb.onToolCall?.({ id, name: call.name, args: call.arguments, summary: msg, risk: "safe" });
      cb.onToolResult?.(id, { content: msg, isError: true });
      return wrapResponse(call.name, msg);
    }

    // Calling a deferred tool directly is a disclosure signal: activate its
    // group so the full schemas appear in the prompt from the next round on.
    const group = groupOfTool(call.name);
    if (group && !activeToolGroups().has(group.name)) activateToolGroups([group.name]);

    const event: ToolCallEvent = {
      id,
      name: call.name,
      args: call.arguments,
      summary: tool.summarize(call.arguments),
      risk: tool.risk(call.arguments),
    };
    cb.onToolCall?.(event);
    addJournalEntry({
      kind: "tool_call",
      tool: call.name,
      summary: clipOneLine(tool.summarize(call.arguments), 240),
    });

    // Gate against the live mode (a set_mode earlier this round can unlock more).
    const g = gate(tool, call.arguments, getMode());
    const sig = `${call.name}:${JSON.stringify(call.arguments)}`;
    const validation = validateToolArguments(call.name, tool.parameters, call.arguments);
    if (!validation.ok) {
      const msg =
        `Tool argument validation failed for ${call.name}:\n` +
        validation.errors.map((e) => `- ${e}`).join("\n") +
        "\nRetry with arguments that match the tool schema exactly.";
      cb.onToolResult?.(id, { content: msg, isError: true, display: "invalid args" });
      addJournalEntry({ kind: "blocker", tool: call.name, summary: "Tool argument validation failed.", evidence: msg, isError: true });
      return wrapResponse(call.name, msg);
    }
    const preconditionBlock = checkToolPreconditions(call, tool, { cwd: this.cwd, intent, journal: getJournal() });
    if (preconditionBlock) {
      cb.onToolResult?.(id, { content: preconditionBlock, isError: true, display: "precondition failed" });
      addJournalEntry({ kind: "blocker", tool: call.name, summary: "Tool precondition failed.", evidence: preconditionBlock, isError: true });
      return wrapResponse(call.name, preconditionBlock);
    }
    if (call.name === "bash" || call.name === "run_background") {
      const command = String(call.arguments.command ?? "");
      const processBlocked = protectedProcessBlockReason(command);
      if (processBlocked) {
        const msg =
          `${processBlocked}\n` +
          "This protected-process action was blocked before approval. Sophie may not kill, stop, restart, or signal the LLM server process.";
        cb.onToolResult?.(id, { content: msg, isError: true, display: "LLM process protected" });
        addJournalEntry({ kind: "blocker", tool: call.name, summary: "Protected LLM process blocked before approval.", evidence: msg, isError: true });
        return wrapResponse(call.name, msg);
      }
      const blocked = protectedPathBlockReason(command, this.cwd);
      if (blocked) {
        const msg =
          `${blocked}\n` +
          "This protected-folder action was blocked before approval. Delete a specific non-protected generated subfolder, or move files to a named backup directory instead.";
        cb.onToolResult?.(id, { content: msg, isError: true, display: "protected path blocked" });
        addJournalEntry({ kind: "blocker", tool: call.name, summary: "Protected runtime path blocked before approval.", evidence: msg, isError: true });
        return wrapResponse(call.name, msg);
      }
    }
    // Only the intent heuristic gates here, and only while it's still trusted.
    // The model explicitly choosing a richer tool is the escape signal: trust
    // the choice, latch off the restriction for the rest of the turn, and let
    // the call proceed (it still passes the safety gate and preconditions).
    const policyBlock = intent.restrictTools ? turnPolicyBlock(intent, event.risk, call.name) : null;
    if (policyBlock) {
      escalation.active = true;
      addJournalEntry({
        kind: "decision",
        tool: call.name,
        summary: `Escalated turn: model needed ${call.name}, beyond the ${intent.kind} heuristic.`,
        evidence: clipOneLine(policyBlock, 200),
      });
    }
    if (deniedCalls.has(sig)) {
      const msg =
        "This exact tool call was already denied by the user during this turn. Do not retry it; choose a non-destructive alternative or ask the user what to do.";
      cb.onToolResult?.(id, { content: msg, isError: true, display: "previously denied" });
      addJournalEntry({ kind: "blocker", tool: call.name, summary: "Repeated a user-denied tool call.", evidence: msg, isError: true });
      return wrapResponse(call.name, msg);
    }
    // An approval-gated call that already succeeded this turn must not run (or
    // prompt) again — re-issuing "send the message" after "Sent!" would text
    // the person twice and ask the user for a second approval.
    if (event.risk !== "safe" && completedSideEffects.has(sig)) {
      const msg =
        `This exact ${call.name} call already ran successfully this turn (${completedSideEffects.get(sig)}). ` +
        "It was NOT run again. Do not repeat a completed action — continue with the next step or report the result to the user.";
      cb.onToolResult?.(id, { content: msg, display: "already done — skipped" });
      addJournalEntry({ kind: "decision", tool: call.name, summary: "Skipped a repeat of an already-completed side-effecting call.", evidence: clipOneLine(msg, 200) });
      return wrapResponse(call.name, msg);
    }
    if (g.decision === "block") {
      const msg = g.reason ?? "This action is not allowed in the current mode.";
      cb.onToolResult?.(id, { content: msg, isError: true });
      addJournalEntry({ kind: "blocker", tool: call.name, summary: "Tool blocked by safety gate.", evidence: msg, isError: true });
      return wrapResponse(call.name, msg);
    }
    if (g.decision === "ask") {
      const decision = await cb.requestApproval(event);
      if (signal?.aborted) {
        const result = { content: TOOL_CANCELLED, isError: true, display: "cancelled" };
        cb.onToolResult?.(id, result);
        addJournalEntry({ kind: "blocker", tool: call.name, summary: "Tool cancelled during approval.", evidence: TOOL_CANCELLED, isError: true });
        return wrapResponse(call.name, TOOL_CANCELLED);
      }
      if (decision === "deny") {
        const msg = "The user denied this action. Do not retry it; consider an alternative or ask why.";
        deniedCalls.add(sig);
        cb.onToolResult?.(id, { content: msg, isError: true });
        addJournalEntry({ kind: "blocker", tool: call.name, summary: "User denied tool approval.", evidence: msg, isError: true });
        return wrapResponse(call.name, msg);
      }
    }

    const repeats = (callCounts.get(sig) ?? 0) + 1;
    callCounts.set(sig, repeats);

    // Hard block: identical call has already hit the repeat limit — don't run it.
    if (repeats > REPEAT_LIMIT) {
      const msg =
        `[Hard block: ${call.name} called with identical arguments ${repeats} times. ` +
        "This call was NOT executed. Change your approach — use different arguments, a different tool, or tell the user you are stuck and why.]";
      const blocked: ToolResult = { content: msg, isError: true, display: "repeat blocked" };
      cb.onToolResult?.(id, blocked);
      addJournalEntry({ kind: "blocker", tool: call.name, summary: `Repeat-blocked (${repeats}×).`, evidence: msg, isError: true });
      return wrapResponse(call.name, msg);
    }

    // 60-second cooldown: the same run_background command must not be restarted
    // within BG_COOLDOWN_MS of its previous launch.
    if (call.name === "run_background") {
      const command = String(call.arguments.command ?? "").trim();
      const lastAt = bgCooldowns.get(command);
      if (lastAt) {
        const elapsedMs = Date.now() - lastAt;
        if (elapsedMs < BG_COOLDOWN_MS) {
          const remainSec = Math.ceil((BG_COOLDOWN_MS - elapsedMs) / 1000);
          const msg =
            `[Cooldown: this exact command was started ${Math.round(elapsedMs / 1000)}s ago — wait ${remainSec}s before retrying. ` +
            "Use job_status to check the existing job first. If you need to kill it, use bash to send SIGTERM, then wait_for the cooldown to expire before launching again.]";
          const blocked: ToolResult = { content: msg, isError: true, display: "cooldown" };
          cb.onToolResult?.(id, blocked);
          addJournalEntry({ kind: "blocker", tool: call.name, summary: `Cooldown blocked (${remainSec}s left).`, evidence: msg, isError: true });
          return wrapResponse(call.name, msg);
        }
      }
      bgCooldowns.set(command, Date.now());
    }

    let result: ToolResult;
    const toolSignal = withTimeoutSignal(signal, TOOL_TIMEOUT_MS);
    try {
      result = await abortable(tool.execute(call.arguments, { cwd: this.cwd, signal: toolSignal.signal }), toolSignal.signal);
    } catch (e: any) {
      if (e?.name === "AbortError") {
        if (toolSignal.timedOut()) {
          const seconds = Math.round(TOOL_TIMEOUT_MS / 1000);
          const hint =
            call.name === "bash"
              ? " If this command is expected to take longer, restart it with run_background, then use wait_for/job_status."
              : " Split this into smaller work or use the background job tools when the work is command-based.";
          result = {
            content: `Tool timed out after ${seconds}s.${hint}`,
            isError: true,
            display: "timed out",
          };
        } else {
          result = { content: TOOL_CANCELLED, isError: true, display: "cancelled" };
        }
        cb.onToolResult?.(id, result);
        addJournalEntry({
          kind: "tool_result",
          tool: call.name,
          summary: result.display ?? "Tool did not finish normally.",
          evidence: clipOneLine(result.content, 500),
          isError: true,
        });
        return wrapResponse(call.name, result.content);
      }
      result = { content: `Tool threw: ${e?.message ?? e}`, isError: true };
    } finally {
      toolSignal.dispose();
    }
    cb.onToolResult?.(id, result);
    if (result.endTurn) this.endTurnRequested = true;
    if (!result.isError && event.risk !== "safe") {
      completedSideEffects.set(sig, result.display ?? "completed");
    }
    if (!result.isError && FILE_TOUCH_ACTIONS[call.name]) {
      const p = String(call.arguments.path ?? call.arguments.file ?? "").trim();
      if (p) {
        const full = p.startsWith("/") ? p : `${this.cwd}/${p}`;
        noteFileTouch(full, FILE_TOUCH_ACTIONS[call.name]!);
        recordLedgerFile(full, FILE_TOUCH_ACTIONS[call.name]!);
      }
    }
    const verifierCall = isVerifierCall(call, result);
    if (call.name === "bash" || call.name === "project_checks" || call.name.startsWith("verify_") || call.name === "browser_check") {
      recordLedgerCommand({
        tool: call.name,
        command: call.name === "bash" ? String(call.arguments.command ?? "") : undefined,
        kind: verifierCall || call.name === "project_checks" || call.name.startsWith("verify_") || call.name === "browser_check" ? "verifier" : "command",
        status: result.isError ? "failed" : "passed",
        summary: result.display ?? clipOneLine(result.content, 220),
      });
    }
    if (!result.isError && (CODING_PROGRESS_TOOLS.has(call.name) || verifierCall)) {
      roundProgress.count++;
    }
    if (!result.isError) roundProgress.successfulTools?.add(call.name);
    addJournalEntry({
      kind: result.isError ? "blocker" : verifierCall ? "verification" : "tool_result",
      tool: call.name,
      summary: result.display ?? (result.isError ? "Tool failed." : verifierCall ? "Verifier passed." : "Tool completed."),
      evidence: clipOneLine(result.content, 500),
      isError: result.isError,
    });

    // Store a clipped copy in history (the UI already showed the full output);
    // warn if the model is repeating the same call fruitlessly.
    let stored = clipForHistory(result.content, 4000, TAIL_CLIPPED_TOOLS.has(call.name) ? "tail" : "head");
    if (result.isError) {
      const family = failureFamily(call, result);
      const failures = (failureCounts.get(family) ?? 0) + 1;
      failureCounts.set(family, failures);
      if (failures >= 2) {
        stored +=
          `\n\n[Failure policy: this is the ${failures} related failure for ${family}. ` +
          "Stop guessing in this area. " +
          `${recoveryHintForFailure(family, result.content)}]`;
      }
    }
    if (repeats >= REPEAT_LIMIT) {
      stored += `\n\n[Final warning: you've called ${call.name} with identical arguments ${repeats} times. The NEXT identical call will be hard-blocked and NOT executed. Change approach now — different arguments, a different tool, or tell the user you are stuck.]`;
    }
    return wrapResponse(call.name, stored);
  }

  /**
   * Compact history when it nears the context budget. Like Hermes-style context
   * engines, this keeps volatile working state deterministic (objective, tasks,
   * journal evidence) and only uses the model for the lossy transcript slice.
   */
  /** Exit build mode when the objective is verified complete. */
  private advanceBuildPipeline(cb: AgentCallbacks): void {
    if (getMode() !== "build") return;
    const objective = getObjective();
    if (objective?.status === "completed") {
      setMode("normal");
      addJournalEntry({ kind: "decision", summary: "Build complete — exited build mode to normal." });
      cb.onCheckpoint?.();
      return;
    }
  }

  /**
   * Elide the raw text of old tool outputs, keeping only the last
   * KEEP_TOOL_OUTPUTS verbatim. On a long task the model doesn't need the full
   * body of a file it read or a command it ran twenty steps ago — the working
   * set, task ledger, and journal retain the durable facts, and it can re-read
   * or re-run if it truly needs the detail again. This keeps history lean
   * between full compactions and is much cheaper than summarizing.
   */
  private pruneToolHistory(): void {
    const toolIdx: number[] = [];
    for (let i = 0; i < this.history.length; i++) {
      if (this.history[i]!.role === "tool") toolIdx.push(i);
    }
    if (toolIdx.length <= KEEP_TOOL_OUTPUTS) return;
    const stubUntil = toolIdx.length - KEEP_TOOL_OUTPUTS;
    for (let k = 0; k < stubUntil; k++) {
      const i = toolIdx[k]!;
      const content = typeof this.history[i]!.content === "string" ? (this.history[i]!.content as string) : "";
      if (content.length < TOOL_OUTPUT_STUB_MIN || content.includes("output elided to save context")) continue;
      const name = /"name":\s*"([^"]+)"/.exec(content)?.[1] ?? "tool";
      this.history[i] = {
        role: "tool",
        content: wrapResponse(name, `[earlier ${name} output elided to save context — re-read the file or re-run the command if you need it again.]`),
      };
    }
  }

  private async compact(systemTokens: number, signal?: AbortSignal): Promise<void> {
    const budget = historyBudget(systemTokens);
    if (messagesTokens(this.history) <= budget * COMPACT_AT) return;
    if (this.history.length <= KEEP_RECENT + 2) return; // too short to bother

    const first = this.history[0];
    const recent = this.history.slice(-KEEP_RECENT);
    const middle = this.history.slice(1, this.history.length - KEEP_RECENT);
    if (!middle.length) return;

    const summary = await this.summarize(middle, signal);
    const brief = continuationBrief(summary, this.cwd);
    this.history = [
      first,
      {
        role: "system",
        content: brief,
      },
      ...recent,
    ];
    addJournalEntry({
      kind: "decision",
      summary: "Compressed older transcript into a structured continuation brief.",
      evidence: `Kept ${recent.length} recent messages verbatim.`,
    });
  }

  /** One-shot summary of a slice of the transcript (used by compaction). */
  private async summarize(messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
    const transcript = messages
      .map((m) => {
        const text = typeof m.content === "string" ? m.content : "[image/multimodal content]";
        return `${m.role.toUpperCase()}:\n${text}`;
      })
      .join("\n\n");
    const prompt: ChatMessage[] = [
      {
        role: "system",
        content:
          "You compress an AI agent's working transcript so it can keep going without the originals. " +
          "Produce a dense, factual continuation summary with these exact headings: User requests, " +
          "Work completed, Files and commands, Decisions, Errors and recovery, Pending context. " +
          "Preserve concrete paths, command results, failures, approvals/denials, and unresolved facts. " +
          "Do not include raw <tool_call> or <tool_response> XML, JSON tool-call examples, malformed tool syntax, " +
          "or chat-template tokens; describe tool actions in plain English. Use terse bullets. No preamble. /no_think",
      },
      { role: "user", content: `Compress this transcript:\n\n${transcript}` },
    ];
    try {
      const out = await completeChat(prompt, { signal, temperature: 0.3, thinking: "off" });
      return sanitizeSummary(stripThink(out)) || "(summary unavailable)";
    } catch {
      return fallbackSummary(messages);
    }
  }
}

function continuationBrief(transcriptSummary: string, cwd = process.cwd()): string {
  const objective = getObjective();
  const tasks = getTasks();
  const journal = getJournal();
  const ledger = projectLedgerForPrompt(cwd, 16, 14);
  const taskLines = tasks.length
    ? tasks.map((t, i) => {
        const note = t.note ? ` | note: ${t.note}` : "";
        const attempts = t.attempts ? ` | attempts: ${t.attempts}` : "";
        return `${i + 1}. ${t.status}: ${t.content}${note}${attempts}`;
      })
    : ["(none)"];
  const journalLines = journal.slice(-40).map((j) => {
    const time = new Date(j.at).toISOString();
    const task = j.task ? ` | task: ${j.task}` : "";
    const tool = j.tool ? ` | tool: ${j.tool}` : "";
    const evidence = j.evidence ? ` | evidence: ${clipOneLine(j.evidence, 350)}` : "";
    const error = j.isError ? " | error" : "";
    return `- ${time} | ${j.kind}${error}${tool}${task} | ${j.summary}${evidence}`;
  });
  return [
    "[Compacted continuation brief — earlier transcript was compressed to preserve context]",
    "",
    "# Deterministic state",
    objective
      ? `Objective: ${objective.status} — ${objective.content}${objective.evidence ? `\nObjective evidence/blocker: ${objective.evidence}` : ""}`
      : "Objective: (none)",
    "",
    "# Task ledger",
    ...taskLines,
    "",
    "# Journal evidence retained",
    ...(journalLines.length ? journalLines : ["(none)"]),
    "",
    "# Runtime project ledger",
    ledger || "(none)",
    "",
    "# Transcript summary",
    transcriptSummary,
    "",
    "# Resume protocol",
    "Continue from the task ledger and journal evidence above. Do not ask the user to repeat compacted context. Re-read files or rerun checks when fresh evidence is needed.",
  ].join("\n");
}

/** Qwen-style tool response envelope the model is trained to read. */
function wrapResponse(name: string, content: string): string {
  return `<tool_response>\n{"name": ${JSON.stringify(name)}, "content": ${JSON.stringify(
    content,
  )}}\n</tool_response>`;
}

function sanitizeSummary(summary: string): string {
  return summary
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "[tool call omitted from summary]")
    .replace(/<tool_response>[\s\S]*?<\/tool_response>/g, "[tool response omitted from summary]")
    .replace(/<\|im_start\|>[\s\S]*?<\|im_end\|>/g, "[chat-template block omitted from summary]")
    .trim();
}

function fallbackSummary(messages: ChatMessage[]): string {
  const lines = messages.slice(-30).map((m) => {
    const text = typeof m.content === "string" ? m.content : "[image/multimodal content]";
    return `- ${m.role}: ${clipOneLine(sanitizeSummary(text), 500)}`;
  });
  return [
    "User requests",
    "- Model summarization failed during compaction; deterministic fallback retained recent older-message outline.",
    "Work completed",
    ...lines,
    "Pending context",
    "- Use the deterministic task ledger and journal evidence above as the source of truth.",
  ].join("\n");
}

/**
 * Prompt injected when the agent is detected to be spiraling. Guides the model
 * toward a useful synthesis response instead of an error or endless repetition.
 * The user should see a coherent answer, not evidence that Sophie got stuck.
 */
function spiralSynthesisPrompt(roundCount: number, reason: string): string {
  return (
    `[Auto-recovery after ${roundCount} rounds — ${reason}] You need to wrap up now. ` +
    "Synthesize everything you have gathered and give the user a complete, direct answer. " +
    "If the task is incomplete, explain what you accomplished, what specific blocker remains, and what the user should try. " +
    "Do NOT call any tools — just respond. If you must record a status, use update_tasks to mark the objective blocked, then answer."
  );
}

/**
 * Content fingerprint used for cycle detection.  Strip internal reasoning and
 * tool-call XML, normalise whitespace, lowercase, take the first 250 chars.
 * Long enough to catch real repetition; short enough to be cheap to compare.
 */
function contentSig(text: string): string {
  return stripThink(text)
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .slice(0, 250);
}

/**
 * Scan the last `window` assistant messages in history (excluding the most
 * recent one, which is `sig` itself) and count how many times `sig` appears.
 */
function countContentRepeats(
  history: ChatMessage[],
  sig: string,
  window = 6,
): number {
  if (sig.length < CONTENT_SIG_MIN) return 0;
  const recent = history.slice(-window - 1, -1); // exclude last (just pushed)
  return recent.filter(
    (m) => m.role === "assistant" &&
      contentSig(typeof m.content === "string" ? m.content : "") === sig,
  ).length;
}

function looksLikePromisedAction(text: string): boolean {
  const visible = stripThink(text)
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
    .trim()
    .toLowerCase();
  if (!visible) return false;
  return /\b(let me|i'?ll|i will|i’m going to|i am going to)\b/.test(visible) &&
    /\b(check|inspect|verify|fix|run|read|start|restart|look|build|test|open|fetch)\b/.test(visible);
}

function clipOneLine(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max)}...` : one;
}

function hasSimpleAutoLedger(): boolean {
  const objective = getObjective();
  const tasks = getTasks();
  if (!objective || objective.status !== "active" || requiresTaskLedger(objective.content)) return false;
  const defaults = [
    "Inspect the relevant local context before acting",
    "Do the requested work using the appropriate tools",
    "Verify the result and report concrete evidence",
  ];
  return tasks.length === defaults.length && tasks.every((t, i) => t.content === defaults[i]);
}

function failureFamily(call: ParsedToolCall, result: ToolResult): string {
  if (call.name !== "bash") return `${call.name}:${result.display ?? "error"}`;
  if (result.content.includes("timed out")) return "bash:timeout";
  const command = String(call.arguments.command ?? "").toLowerCase();
  if (/\bshadcn\b|@shadcn|shadcn-ui/.test(command)) return "bash:shadcn";
  if (/\b(npm|pnpm|bun|yarn)\b/.test(command)) return "bash:package-manager";
  if (/\b(git)\b/.test(command)) return "bash:git";
  return `bash:${command.split(/\s+/).slice(0, 3).join(" ") || "command"}`;
}

function turnPolicyBlock(intent: TurnIntent, risk: RiskLevel, toolName: string): string | null {
  if (!intent.shouldTrackTasks && toolName === "update_tasks") {
    return [
      "Blocked by task-ledger policy.",
      "This turn does not need a live task list. Do the single requested action directly, verify if needed, then answer.",
      "Use update_tasks only for explicit multi-step work or project/app builds.",
    ].join("\n");
  }
  if (intent.kind === "quick_check") {
    if (toolName === "update_tasks" || toolName === "set_mode" || risk !== "safe") {
      return [
        "Blocked by quick-check policy.",
        "This user request only needs a small read-only inspection and direct answer.",
        "Do not create/continue a task list or run mutating commands for this turn.",
      ].join("\n");
    }
  }
  if (intent.kind === "correction" && toolName !== "update_tasks" && risk !== "safe") {
    return [
      "Blocked by correction policy.",
      "The user indicated Sophie was off track. Acknowledge, discard the stale objective, and ask or perform only safe inspection.",
    ].join("\n");
  }
  return null;
}

function toolSpecsForModeAndIntent(mode: string, intent: TurnIntent, input: string): ToolSpec[] {
  // Build mode needs the coding/jobs/MCP toolsets — disclose them up front.
  if (mode === "build") activateToolGroups(["coding", "jobs", "shell", "mcp"]);
  // Progressive disclosure: advertise full schemas only for core tools and
  // activated groups; the rest ride in the compact catalog. Every registered
  // tool still EXECUTES if called — disclosure shapes the prompt, not ability.
  const disclosed = disclosedToolNames(toolSpecs().map((s) => s.name));
  let specs = toolSpecs().filter((spec) => disclosed.has(spec.name));
  if (mode === "normal" && !intent.shouldTrackTasks) {
    specs = specs.filter((spec) => spec.name !== "update_tasks");
  }
  if (mode === "plan") return specs.filter((spec) => PLAN_MODE_TOOLS.has(spec.name));
  if (mode === "build") return specs.filter((spec) => BUILD_MODE_TOOLS.has(spec.name));
  // A low-confidence (or escaped) intent advises but never narrows the toolset.
  if (!intent.restrictTools) return specs;
  let allowed: Set<string> | null = null;
  if (intent.kind === "quick_check") allowed = QUICK_CHECK_TOOLS;
  else if (intent.kind === "session_query") allowed = SESSION_QUERY_TOOLS;
  else if (intent.kind === "correction") allowed = CORRECTION_TOOLS;
  else if (intent.kind === "new_job" && looksLikeCodingRequest(input)) allowed = CODING_JOB_TOOLS;
  if (!allowed) return specs;
  return specs.filter((spec) => allowed.has(spec.name));
}

function looksLikeCodingRequest(input: string): boolean {
  return /\b(code|codebase|app|application|project|repo|frontend|backend|ui|website|site|page|component|api|server|script|bash|python|unit tests?|next\.?js|react|typescript|javascript|build|test|typecheck|lint|browser)\b/i.test(input);
}

/** Reasoning effort per mode: plan medium, build low, normal/audio off. */
export function reasoningForMode(mode: string): ThinkLevel {
  if (mode === "plan") return "medium";
  if (mode === "build") return "low";
  return "off";
}

/** A request that mutates code/projects (a code noun + a build/edit verb), so it
 *  should execute in build mode. */
export function involvesCoding(input: string): boolean {
  return (
    looksLikeCodingRequest(input) &&
    /\b(fix|change|edit|update|add|remove|delete|create|build|scaffold|implement|recode|rewrite|refactor|make|write|debug|generate|set\s?up)\b/i.test(input)
  );
}

function isFreshActionable(mode: string, intent: TurnIntent): boolean {
  return mode === "normal" && intent.requiresAction && intent.kind !== "continue_job";
}

/** A coding request → enter BUILD mode. */
export function shouldAutoBuild(mode: string, intent: TurnIntent, input: string): boolean {
  return isFreshActionable(mode, intent) && intent.shouldTrackTasks && involvesCoding(input);
}

/** A non-coding new job → standalone PLAN (then hands off to normal). Coding
 *  goes to build instead, so plan here is only for non-coding work. */
export function shouldAutoPlan(mode: string, intent: TurnIntent, input: string): boolean {
  return (
    isFreshActionable(mode, intent) &&
    intent.kind === "new_job" &&
    !involvesCoding(input) &&
    /\b(plan|roadmap|think through|strategy|compare options|research and decide)\b/i.test(input)
  );
}

function shouldRouteImageRequestToTools(input: string): boolean {
  return /\b(take|capture|find|search|look for|locate)\b[\s\S]{0,80}\b(screen ?shot|screen|image|photo|picture)\b/i.test(input) ||
    /\b(screen ?shot|screen|image|photo|picture)\b[\s\S]{0,80}\b(find|search|describe|capture)\b/i.test(input);
}

function verifiedMemoryForTurn(input: string, intent: TurnIntent): string {
  if (!(intent.kind === "new_job" || intent.kind === "continue_job") || !looksLikeCodingRequest(input)) return "";
  const hits = searchVerifiedEpisodes(input, 3);
  if (!hits.length) return "";
  return ["# Relevant verified memory", ...hits.map((h) => `- ${h.replace(/\n/g, "\n  ")}`)].join("\n");
}

function runtimeLimits(mode?: string): { maxRounds: number; maxNudges: number; allowParallelTools: boolean } {
  const base =
    config.resourceProfile === "small"
      ? { maxRounds: 80, maxNudges: 5, allowParallelTools: false }
      : config.resourceProfile === "large"
        ? { maxRounds: MAX_ROUNDS, maxNudges: MAX_NUDGES, allowParallelTools: true }
        : { maxRounds: 140, maxNudges: 8, allowParallelTools: true };
  // A full MVP build is many small steps — give build mode the generous ceiling
  // regardless of profile so it can finish in one turn.
  if (mode === "build") {
    return { ...base, maxRounds: Math.max(base.maxRounds, MAX_ROUNDS), maxNudges: Math.max(base.maxNudges, MAX_NUDGES) };
  }
  return base;
}

function prepareMessages(
  systemContent: string,
  history: ChatMessage[],
): { systemContent: string; historyMessages: ChatMessage[] } {
  const extraSystem: string[] = [];
  const historyMessages: ChatMessage[] = [];
  for (const m of history) {
    if (m.role === "system") {
      const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      extraSystem.push(text);
    } else {
      historyMessages.push(m);
    }
  }
  return {
    systemContent: extraSystem.length
      ? `${systemContent}\n\n# Compacted Session Context\n${extraSystem.join("\n\n")}`
      : systemContent,
    historyMessages,
  };
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function withTimeoutSignal(parent: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  timedOut: () => boolean;
  dispose: () => void;
} {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("Tool timed out", "TimeoutError"));
  }, timeoutMs);
  const onParentAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted) onParentAbort();
  else parent?.addEventListener("abort", onParentAbort, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timeout);
      parent?.removeEventListener("abort", onParentAbort);
    },
  };
}
