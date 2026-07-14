import type { Objective, Task } from "./tasks.ts";
import type { OutcomeRequirement } from "./outcome_contract.ts";
import { classifyIntentWithModel, type IntentRoutingContext } from "./intent_model.ts";

export type TurnIntentKind =
  | "chat"
  | "quick_check"
  | "standalone_action"
  | "new_job"
  | "continue_job"
  | "correction"
  | "session_query";

export interface TurnIntent {
  kind: TurnIntentKind;
  requiresAction: boolean;
  shouldTrackTasks: boolean;
  /** 0..1 — how strongly this classification is trusted. */
  confidence: number;
  /** Whether the runtime should narrow tools / enforce turn policy for this
   *  kind. Only true for restrictive kinds matched with enough confidence: a
   *  weak guess advises (via prompt focus) but never traps the model. */
  restrictTools: boolean;
  resetReason?: string;
  /** Concrete first-choice tools this turn is expected to need. */
  expectedTools?: string[];
  /** Observable outcomes the user explicitly requested (intent model only —
   *  the heuristic fallback never guesses at contracts). */
  requiredOutcomes?: OutcomeRequirement[];
}

export interface IntentState {
  objective: Objective | null;
  tasks: Task[];
}

/** Kinds that narrow the toolset / gate tools. Others never restrict. */
const RESTRICTIVE_KINDS = new Set<TurnIntentKind>([
  "quick_check",
  "session_query",
  "correction",
  "new_job",
]);
/** A restrictive kind only actually restricts above this confidence. */
export const RESTRICT_CONFIDENCE = 0.7;
/** Trust assigned to a well-formed intent-model classification. */
const MODEL_CONFIDENCE = 0.85;

const KIND_REQUIRES_ACTION: Record<TurnIntentKind, boolean> = {
  chat: false,
  quick_check: true,
  standalone_action: true,
  new_job: true,
  continue_job: true,
  correction: false,
  session_query: true,
};

const KIND_TRACKS_TASKS: Record<TurnIntentKind, boolean> = {
  chat: false,
  quick_check: false,
  standalone_action: false,
  new_job: true,
  continue_job: true,
  correction: false,
  session_query: false,
};

/** Personal-assistant stores already provide a compact, observable work plan:
 * expected sources plus outcome contracts. Adding a second software-style
 * objective/task ledger makes small local models loop and bloats later turns.
 * Coding jobs do not route through this catalog and retain the ledger. */
const PERSONAL_OPERATION_TOOLS = new Set([
  "email", "apple", "calendar", "calendar_list", "calendar_find_free", "schedule", "schedule_list",
  "manage_tasks", "projects", "people", "delegate", "activity", "recall", "remember", "notify", "ask_user",
]);

function intent(
  kind: TurnIntentKind,
  confidence: number,
  expectedTools: string[] = [],
  requiredOutcomes: OutcomeRequirement[] = [],
): TurnIntent {
  const contractedOperation = requiredOutcomes.length > 0;
  const personalOperation = expectedTools.some((name) => PERSONAL_OPERATION_TOOLS.has(name));
  return {
    kind,
    // A concrete routed source is execution intent even if the broad label is
    // conversational (for example, "is this message real?" or "look this up").
    requiresAction: KIND_REQUIRES_ACTION[kind] || expectedTools.length > 0,
    shouldTrackTasks: KIND_TRACKS_TASKS[kind] && !personalOperation && !contractedOperation,
    confidence,
    restrictTools: RESTRICTIVE_KINDS.has(kind) && confidence >= RESTRICT_CONFIDENCE,
    ...(expectedTools.length ? { expectedTools } : {}),
    ...(requiredOutcomes.length ? { requiredOutcomes } : {}),
  };
}

/**
 * Classify the turn. Unambiguous conversational shapes (greetings, slash
 * commands, explicit continue/correction) resolve locally; everything else is
 * classified by the intent model, with the generic heuristics as fallback
 * when the model is unavailable or replies with garbage.
 */
export async function classifyTurnIntent(input: string, state: IntentState, signal?: AbortSignal, routingContext?: IntentRoutingContext): Promise<TurnIntent> {
  const text = input.toLowerCase().trim();
  let base = fastPathIntent(text);
  if (!base) {
    const modeled = await classifyIntentWithModel(input.trim(), signal, routingContext);
    base = modeled
      ? intent(modeled.kind, MODEL_CONFIDENCE, modeled.expectedTools, modeled.requiredOutcomes)
      : heuristicTurnIntent(input);
  }
  return withResetReason(base, input, state);
}

/** Synchronous generic fallback — no model call, and no phrase lists tied to
 *  any particular scenario. Exported for tests and offline use. */
export function heuristicTurnIntent(input: string): TurnIntent {
  const text = input.toLowerCase().trim();
  const fast = fastPathIntent(text);
  if (fast) return fast;
  if (requiresTaskLedger(input)) return intent("new_job", 0.7);
  const hinted = genericExpectedTools(text);
  if (hinted.length) return intent("standalone_action", 0.7, hinted);
  const quick = quickCheckConfidence(text);
  if (quick > 0) return intent("quick_check", quick);
  if (requiresLocalAction(input)) return intent("standalone_action", 0.6);
  return intent("chat", 0.6);
}

/** Shapes so unambiguous that a model call would be waste. */
function fastPathIntent(text: string): TurnIntent | null {
  if (!text || text.startsWith("/")) return intent("chat", 0.9);
  if (/^(hi|hello|hey|thanks|thank you)[!. ]*$/.test(text) && text.length < 80) {
    return intent("chat", 0.9);
  }
  if (/\b(continue|resume|keep going|carry on|where you left off)\b/.test(text)) {
    return intent("continue_job", 0.8);
  }
  if (/\b(not what i asked|wrong thing|off track|stop doing|why are you|what are you doing)\b/.test(text)) {
    return intent("correction", 0.75);
  }
  if (/\b(previous|latest|last)\b.*\b(session|conversation|chat|sophie)\b/.test(text)) {
    return intent("session_query", 0.85);
  }
  return null;
}

function withResetReason(base: TurnIntent, input: string, state: IntentState): TurnIntent {
  const text = input.toLowerCase().trim();
  const hasOpenWork = state.objective?.status === "active" || state.tasks.some((t) => t.status !== "completed");
  if (!hasOpenWork || text.startsWith("/")) return base;
  if (base.kind === "continue_job") return base;

  const prior = state.objective ? `Previous active objective was: ${state.objective.content}` : "Previous task list had open items.";
  if (base.kind === "correction") {
    return { ...base, resetReason: `${prior} User indicated Sophie is off track: ${input.trim()}` };
  }
  if (base.kind === "quick_check" || base.kind === "standalone_action") {
    return { ...base, resetReason: `${prior} New request is a standalone local action: ${input.trim()}` };
  }
  if (base.kind === "new_job" && looksLikeNewObjective(text)) {
    return { ...base, resetReason: `${prior} New request appears to define a fresh complex objective: ${input.trim()}` };
  }
  return base;
}

export function turnFocusForPrompt(input: string, intent: TurnIntent): string {
  const request = input.trim();
  const requestLine = request.length > 1200
    ? `User request: use the latest user message above as the active request (${request.length} characters); it is intentionally not duplicated here.`
    : `User request: ${request}`;
  return [
    "# Current turn focus",
    requestLine,
    `Runtime intent: ${intent.kind}`,
    "This is the active request. Treat older objectives and compacted context as background unless the user explicitly asks to continue them.",
    intent.expectedTools?.length
      ? `Tool routing hint: this request should use ${intent.expectedTools.join(" or ")} before answering. Do not answer from memory when a hinted tool can verify or perform it.`
      : "",
    intent.kind === "quick_check" && intent.restrictTools
      ? "Quick-check policy: use only the smallest safe read needed, then answer with the result, decisive evidence, and one practical next step. Do not repeat implications, append a follow-up offer, or create a task list. If real action is needed, do it — this is only a scope guess."
      : "",
  ].filter(Boolean).join("\n");
}

export function requiresLocalAction(input: string): boolean {
  const text = input.toLowerCase();
  if (text.trim().startsWith("/")) return false;
  if (/^(hi|hello|hey|thanks|thank you)[!. ]*$/.test(text) && text.length < 80) return false;
  return (
    /\b(read|inspect|check|look at|look up|find|search|research|study|compare|audit|review)\b/.test(text) ||
    /\b(fix|change|edit|update|add|remove|delete|create|build|scaffold|implement|recode|rewrite|make)\b/.test(text) ||
    /\b(run|start|restart|stop|kill|install|download|open|browse|verify|test|typecheck|lint|commit)\b/.test(text) ||
    /\b(ask me|ask the user|ask for|tell me first|before doing anything|notify me|send me a notification)\b/.test(text) ||
    /\b(today'?s date|day of the week|what time|current time|right now|days? until)\b/.test(text) ||
    (/\b(calculate|calculator|compute|standard deviation|average|mean|percent|percentage|square root|fahrenheit|celsius)\b/.test(text) || /\d+\s*[%*/+-]/.test(text)) ||
    /\b(remember (?:that|this|the)|save (this|that) (preference|fact)|keep this .*in mind|recall|what do you remember)\b/.test(text) ||
    /\b(weather|rain|forecast|temperature)\b/.test(text) ||
    /\b(screenshot|screen shot|my screen|image|photo|picture)\b/.test(text) ||
    /\b(what os|operating system|os version|shell am i|free disk|disk space|memory)\b/.test(text) ||
    /\b(my|our|this|the local|latest|last)\b.*\b(file|folder|repo|project|codebase|app|server|terminal|command|tool|skill|agent|sophie)\b/.test(text)
  );
}

/** Minimal, generic single-purpose hints for the offline fallback. Anything
 *  more contextual (mail vs messages vs records) is the intent model's job. */
function genericExpectedTools(text: string): string[] {
  const tools: string[] = [];
  const add = (name: string) => {
    if (!tools.includes(name)) tools.push(name);
  };
  if (/\b(today'?s date|day of the week|what time|current time|days? until)\b/.test(text)) add("current_time");
  if (/\b(calculate|calculator|compute|standard deviation|square root|percent of|fahrenheit|celsius)\b/.test(text) || /\d+\s*[%*/^]/.test(text)) add("calc");
  if (/\b(what os|operating system|os version|free disk|disk space)\b/.test(text)) add("system_info");
  if (/\b(remember (?:that|this|the)|save (this|that) (preference|fact)|keep this .*in mind)\b/.test(text)) add("remember");
  if (/\b(recall|what do you remember|stored memor(y|ies))\b/.test(text)) add("recall");
  if (/\b(take a screenshot|capture (my )?screen|screen shot)\b/.test(text)) add("capture_screen");
  if (/\b(weather|forecast|rain)\b/.test(text)) add("weather");
  if (/\b(what|which|list|show)\b.*\b(scheduled|schedules|reminders?|cron)\b/.test(text)) add("schedule_list");
  if (/\b(notify me|send me a notification)\b/.test(text)) add("notify");
  if (/\b(?:create|write|make)\s+(?:a\s+)?file(?:\s+called|\s+named)?\b/.test(text)) add("write_file");
  return tools;
}

export function requiresTaskLedger(input: string): boolean {
  const text = input.toLowerCase();
  if (text.trim().startsWith("/")) return false;
  const explicitMultiStep = [
    /\b(task list|roadmap|multi[- ]step|end[- ]to[- ]end|fully complete|until .*done)\b/,
    /\b(keep|continue)\b.*\b(upgrad|improv|build|fix|work|going|until)\b/,
    /\b(dev server|long[- ]running|background job|deploy|database migration)\b/,
  ];
  if (explicitMultiStep.some((re) => re.test(text))) return true;
  // One bounded research/explanation request stays a direct assistant turn.
  if (/^(?:research|look up)\b/.test(text) && !/\b(?:and then|then|after that|multi[- ]step|end[- ]to[- ]end)\b/.test(text)) return false;
  // A personal briefing/review/summary is itself the requested answer, not a
  // software-style project needing an internal live task ledger.
  if (/\b(plan|review|checklist|summary|briefing)\b/.test(text) && /\b(email|inbox|messages?|texts?|calendar|weather|appointments?|commitments?|tasks?|week|today)\b/.test(text) && !/\b(then|task list|roadmap|multi[- ]step|end[- ]to[- ]end)\b/.test(text)) return false;
  // Creating personal records (tasks, contacts, reminders, appointments) is
  // one bounded action unless it is clearly a software build.
  if (
    /\b(?:create|add|make|track|set)\b[\s\S]{0,180}\b(?:projects?|stakeholders?|contacts?|tasks?|reminders?|appointments?)\b/.test(text) &&
    !/\b(?:code|codebase|repo|app|frontend|backend|component|api endpoint|server|script|python|react|next\.?js|typescript|javascript|cli|source file)\b/.test(text)
  ) return false;

  // A project/app build is intrinsically multi-step even when phrased as one
  // outcome. A focused "fix the typo/type error" stays one task.
  if (
    /\b(build|create|scaffold|set\s?up|implement|make)\b/.test(text) &&
    /\b(app|application|project|website|site|dashboard|frontend|backend|api|server|tool|cli|mvp)\b/.test(text)
  ) {
    return true;
  }

  const actionWords = (text.match(/\b(read|inspect|check|find|search|research|fix|change|edit|update|add|remove|delete|create|run|start|restart|stop|install|verify|test|build|scaffold|implement|rewrite|refactor|debug|migrate|deploy)\b/g) ?? []).length;
  const connectors = (text.match(/\b(and then|then|after that|also|plus|make sure|while|once|and)\b|[,;]/g) ?? []).length;
  return actionWords >= 2 && connectors >= 1;
}

/** Returns 0 if this isn't a quick check, else a confidence in (0,1] that
 *  scales with how strongly the read-only-single-check signals fired. A bare
 *  match (generic noun only) stays below RESTRICT_CONFIDENCE so it advises but
 *  does not trap the model. */
function quickCheckConfidence(text: string): number {
  const hasPath = /\/[a-z0-9._~/-]+/i.test(text);
  const hasNamedTarget = /\b(named|called)\s+["']?[a-z0-9._ -]+["']?/.test(text);
  const hasGenericTarget =
    /\b(desktop|downloads|documents|folder|directory|file|port|server|service|process|app|project)\b/.test(text);
  const selfContainedTarget = hasPath || hasNamedTarget || hasGenericTarget;
  const readOnlyAction = /\b(is there|check|find|list|show|look at|read|what is|what's|which|where is)\b/.test(text);
  const mutatingAction = /\b(delete|remove|kill|stop|close|create|make|edit|write|install|build|scaffold)\b/.test(text);
  if (text.length > 180 || !selfContainedTarget || !readOnlyAction || mutatingAction) return 0;
  let confidence = 0.55; // matched, but weak (generic noun only)
  if (hasPath || hasNamedTarget) confidence += 0.25; // a concrete, unambiguous target
  if (text.length <= 80) confidence += 0.1; // short, single-clause asks are clearer
  return Math.min(confidence, 0.95);
}

function looksLikeNewObjective(text: string): boolean {
  if (/\b(this|that|it|current|existing|same|above|previous)\b/.test(text)) return false;
  return (
    /\b(build|create|scaffold|set up|setup|make|implement|write|generate)\b/.test(text) &&
    /\b(app|application|project|page|website|site|dashboard|ui|frontend|backend|api|server|tool|script|python|next\.?js|react)\b/.test(text)
  );
}
