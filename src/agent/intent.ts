import type { Objective, Task } from "./tasks.ts";

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
  /** 0..1 — how strongly the heuristics matched this kind. */
  confidence: number;
  /** Whether the runtime should narrow tools / enforce turn policy for this
   *  kind. Only true for restrictive kinds matched with enough confidence: a
   *  weak guess advises (via prompt focus) but never traps the model. */
  restrictTools: boolean;
  resetReason?: string;
  /** Concrete first-choice tools the heuristic expects this turn to need. */
  expectedTools?: string[];
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

function intent(
  kind: TurnIntentKind,
  requiresAction: boolean,
  shouldTrackTasks: boolean,
  confidence: number,
  expectedTools: string[] = [],
): TurnIntent {
  return {
    kind,
    requiresAction,
    shouldTrackTasks,
    confidence,
    restrictTools: RESTRICTIVE_KINDS.has(kind) && confidence >= RESTRICT_CONFIDENCE,
    ...(expectedTools.length ? { expectedTools } : {}),
  };
}

export function classifyTurnIntent(input: string, state: IntentState): TurnIntent {
  const text = input.toLowerCase().trim();
  const hasOpenWork = state.objective?.status === "active" || state.tasks.some((t) => t.status !== "completed");
  const base = classifyBaseIntent(input);

  if (!hasOpenWork || text.startsWith("/")) return base;
  if (base.kind === "continue_job") return base;

  const prior = state.objective ? `Previous active objective was: ${state.objective.content}` : "Previous task list had open items.";
  if (base.kind === "correction") {
    return { ...base, resetReason: `${prior} User indicated Sophie is off track: ${input}` };
  }
  if (base.kind === "quick_check" || base.kind === "standalone_action") {
    return { ...base, resetReason: `${prior} New request is a standalone local action: ${input}` };
  }
  if (base.kind === "new_job" && looksLikeNewObjective(text)) {
    return { ...base, resetReason: `${prior} New request appears to define a fresh complex objective: ${input}` };
  }
  return base;
}

export function turnFocusForPrompt(input: string, intent: TurnIntent): string {
  return [
    "# Current turn focus",
    `User request: ${input.trim()}`,
    `Runtime intent: ${intent.kind}`,
    "This is the active request. Treat older objectives and compacted context as background unless the user explicitly asks to continue them.",
    intent.expectedTools?.length
      ? `Tool routing hint: this request should use ${intent.expectedTools.join(" or ")} before answering. Do not answer from memory when a hinted tool can verify or perform it.`
      : "",
    intent.kind === "quick_check" && intent.restrictTools
      ? "Quick-check policy: use only the smallest safe read-only tool call needed, then answer directly. Do not create or continue a task list. If it turns out you genuinely need to change or run something, just do it — this is only a guess about scope."
      : "",
  ].filter(Boolean).join("\n");
}

function classifyBaseIntent(input: string): TurnIntent {
  const text = input.toLowerCase().trim();
  if (!text || text.startsWith("/")) return intent("chat", false, false, 0.9);
  if (/^(hi|hello|hey|thanks|thank you)[!. ]*$/.test(text) && text.length < 80) {
    return intent("chat", false, false, 0.9);
  }
  if (/\b(continue|resume|keep going|carry on|finish|same task|that task|the task|where you left off)\b/.test(text)) {
    return intent("continue_job", true, true, 0.8);
  }
  if (/\b(not what i asked|wrong thing|off track|stop doing|why are you|what are you doing)\b/.test(text)) {
    return intent("correction", false, false, 0.75);
  }
  if (/\b(previous|latest|last)\b.*\b(session|conversation|chat|sophie)\b/.test(text)) {
    return intent("session_query", true, false, 0.85);
  }

  const localAction = requiresLocalAction(input);
  const taskLedger = requiresTaskLedger(input);
  const hinted = expectedToolsForInput(text);
  if (taskLedger) return intent("new_job", localAction, true, 0.8, hinted);
  if (hinted.length) return intent("standalone_action", true, false, 0.8, hinted);
  const quick = quickCheckConfidence(text);
  if (quick > 0) return intent("quick_check", true, false, quick);
  if (localAction) return intent("standalone_action", true, false, 0.65);
  return intent("chat", false, false, 0.6);
}

export function requiresLocalAction(input: string): boolean {
  const text = input.toLowerCase();
  if (text.trim().startsWith("/")) return false;
  if (/^(hi|hello|hey|thanks|thank you)[!. ]*$/.test(text) && text.length < 80) return false;
  return (
    /\b(read|inspect|check|look at|look up|find|search|research|study|compare|audit|review)\b/.test(text) ||
    /\b(fix|change|edit|update|add|remove|delete|create|build|scaffold|implement|recode|rewrite|make)\b/.test(text) ||
    /\b(run|start|restart|stop|kill|install|download|open|browse|verify|test|typecheck|lint|commit)\b/.test(text) ||
    /\b(ask me|ask the user|ask for|tell me first|before doing anything|let me know on my phone|on my phone|notify me|send me a notification)\b/.test(text) ||
    /\b(today'?s date|day of the week|what time|current time|right now|days? until|new year'?s day)\b/.test(text) ||
    (/\b(calculate|calculator|compute|standard deviation|average|mean|percent|percentage|square root|fahrenheit|celsius|seconds?|minutes?|hours?)\b/.test(text) || /\d+\s*[%*/+-]/.test(text)) ||
    /\b(remember (?:that|this|the)|save (this|that) (preference|fact)|keep this .*in mind|recall|what do you remember)\b/.test(text) ||
    /\b(weather|rain|forecast|temperature)\b/.test(text) ||
    /\b(screenshot|screen shot|my screen|image|photo|picture)\b/.test(text) ||
    /\b(what os|operating system|os version|shell am i|free disk|disk space|memory)\b/.test(text) ||
    /\b(definition of|in the context of http|httpbin|make a get request)\b/.test(text) ||
    /\b(my|our|this|the local|latest|last)\b.*\b(file|folder|repo|project|codebase|app|server|terminal|command|tool|skill|agent|sophie)\b/.test(text)
  );
}

export function expectedToolsForInput(text: string): string[] {
  const tools: string[] = [];
  const add = (...names: string[]) => {
    for (const name of names) if (!tools.includes(name)) tools.push(name);
  };
  if (/\b(today'?s date|day of the week|what time|current time|right now|days? until|new year'?s day)\b/.test(text)) add("current_time");
  if (/\b(calculate|calculator|compute|standard deviation|average|mean|percent|percentage|square root|fahrenheit|celsius|seconds?|minutes?|hours?)\b|\d+\s*[%*/+-]/.test(text)) add("calc");
  if (/\b(what os|operating system|os version|shell am i|free disk|disk space|memory)\b/.test(text)) add("system_info", "bash");
  const memoryRequest = /\b(remember (?:that|this|the)|save (this|that) (preference|fact)|keep this .*in mind)\b/.test(text);
  if (memoryRequest) add("remember");
  if (/\b(recall|what do you remember|stored memor(y|ies))\b/.test(text)) add("recall");
  if (/\b(ask me|ask the user|ask for|tell me first|before doing anything)\b/.test(text)) add("ask_user");
  if (/\b(take a screenshot|capture (my )?screen|my screen|screen shot)\b/.test(text)) add("capture_screen");
  if (/\b(find|search).*\b(screenshot|image|photo|picture)\b/.test(text)) add("find_images", "describe_images");
  if (/\b(open)\b.*https?:\/\//.test(text)) add("open_thing");
  if (/\b(let me know on my phone|on my phone|notify me|send me a notification)\b/.test(text)) add("notify");
  if (/\b(weather|rain|forecast|temperature)\b/.test(text)) add("weather");
  if (/\b(look up|definition of|current version|latest|research|source link)\b/.test(text)) add("web_search", "web_fetch");
  if (/\b(make a get request|http_request|httpbin|api request)\b/.test(text)) add("http_request");
  if (!memoryRequest && /\b(notes?|make a note|create a note|append.*note)\b/.test(text)) add("apple");
  if (/\b(?:create|write|make)\s+(?:a\s+)?file(?:\s+called|\s+named)?\b/.test(text)) add("write_file");
  if (/\b(what|which|list|show)\b.*\b(scheduled|schedules|reminders?|cron)\b/.test(text)) add("schedule_list");
  if (/\b(unread|inbox|email|e-mail|mailbox)\b/.test(text)) add("email");
  if (/\b(recent messages?|imessages?|texts?)\b/.test(text)) add("apple");
  if (/\b(calendar|schedule)\b/.test(text) && /\b(today|tomorrow|week|review|check|look)\b/.test(text)) add("calendar_list");
  if (/\b(free|available|availability|conflict-free|fit)\b.*\b(slot|time|calendar|meeting|walkthrough|interview)?\b/.test(text)) add("calendar_find_free");
  if (/\b(project)\b/.test(text) && /\b(stakeholder|client|milestone|track|create|add)\b/.test(text)) add("people", "projects");
  if (/\b(?:create|add|track)\b.*\b(?:high-priority |priority )?task\b/.test(text)) add("manage_tasks");
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
