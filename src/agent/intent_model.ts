/**
 * Model-based turn intent classification — the replacement for phrase-list
 * routing. One small, thinking-off call asks the local model what kind of turn
 * this is, which sources/tools it needs, and which observable outcomes the
 * user explicitly requested. The model only PROPOSES; the runtime remains the
 * gatekeeper: the reply is parsed strictly, tool names are checked against the
 * routable catalog, and outcome keys are checked against the enforceable-
 * outcome whitelist. Anything unparseable or unknown is dropped, and a failed
 * call falls back to the generic heuristics in intent.ts.
 *
 * This keeps the division of labor Sophie is built on: the model supplies
 * judgment ("this needs the inbox and the calendar"), the runtime supplies
 * discipline (which tools exist, which outcomes are enforceable, and how the
 * turn is then driven). Nothing in here may reference evaluation scenarios or
 * their wording — routing must generalize to requests we have never seen.
 */
import { completeChat } from "../llm/client.ts";
import { stripThink } from "./context.ts";
import { addJournalEntry } from "./tasks.ts";
import { recordModelRequest } from "./stats.ts";
import { ENFORCEABLE_OUTCOMES, outcomeIsReadOnly, type OutcomeRequirement } from "./outcome_contract.ts";
import type { TurnIntentKind } from "./intent.ts";

export interface ModelIntent {
  kind: TurnIntentKind;
  expectedTools: string[];
  requiredOutcomes: OutcomeRequirement[];
}

export interface IntentRoutingContext {
  restoredSession?: boolean;
  priorToolNames?: string[];
}

export type IntentModel = (input: string, signal?: AbortSignal, context?: IntentRoutingContext) => Promise<ModelIntent | null>;

/** Tools the intent model may route a personal-assistant turn to, with the
 *  one-line purpose shown in the classification prompt. Kept deliberately
 *  small: coding/workspace turns are routed by mode and tool focus, not here. */
export const ROUTABLE_TOOLS: Record<string, string> = {
  current_time: "date/time",
  calc: "math",
  system_info: "this machine's OS/hardware/disk/memory",
  where_am_i: "working directory",
  weather: "forecast",
  email: "inbox, received mail, and drafts",
  apple: "messages/texts; also Notes/contacts",
  calendar_list: "read events",
  calendar_find_free: "find free slots",
  calendar: "add/change event",
  schedule: "add reminder",
  schedule_list: "read reminders",
  manage_tasks: "stored to-dos, not prose plans",
  projects: "stored projects, not prose plans",
  people: "people/contact records",
  delegate: "agent delegations",
  activity: "what Sophie actually did",
  recall: "memory lookup",
  remember: "save fact/preference",
  notify: "phone notification",
  ask_user: "ask before proceeding",
  web_search: "web research",
  http_request: "named API call",
  capture_screen: "take screenshot",
  find_images: "find local images",
  open_thing: "open URL/file/app",
  write_file: "one named content file (not software)",
};

const VALID_KINDS = new Set<TurnIntentKind>([
  "chat",
  "quick_check",
  "standalone_action",
  "new_job",
  "continue_job",
  "correction",
  "session_query",
]);

const MAX_TOOLS = 8;
const MAX_OUTCOMES = 8;
const MAX_INPUT_CHARS = 2400;
const CALL_TIMEOUT_MS = 20_000;
const ACTION_KINDS = new Set<TurnIntentKind>(["standalone_action", "new_job", "continue_job"]);
const MUTATION_ONLY_TOOLS = new Set(["calendar", "schedule", "manage_tasks", "projects", "people", "delegate", "remember", "notify", "ask_user", "write_file"]);
const CONTRACT_ONLY_READ_TOOLS = new Set(["calendar_find_free", "web_search"]);
const REVIEW_SOURCE_CANDIDATES = [
  "email", "apple", "calendar_list", "schedule_list", "manage_tasks", "projects", "people", "delegate", "activity", "recall",
];

/** Readable domains that can carry an indirect reference across turns. The
 * resolver sees only these compact names, never old prose or tool output. */
const CONTINUITY_SOURCES: Record<string, string> = {
  email: "received email/mail/inbox items",
  apple: "received texts/iMessage/chat; also notes/contacts",
  calendar_list: "events/appointments",
  schedule_list: "reminders",
  manage_tasks: "to-dos",
  projects: "project records",
  people: "people/contact records",
  delegate: "delegations",
  activity: "what Sophie actually did",
  recall: "saved facts/preferences",
  web_search: "earlier web research",
  weather: "forecast",
  system_info: "machine details",
};

const CONTINUITY_CANONICAL: Record<string, string> = {
  calendar: "calendar_list",
  schedule: "schedule_list",
};

export function intentRoutingMessages(input: string, context: IntentRoutingContext = {}): { role: "system" | "user"; content: string }[] {
  const tools = Object.entries(ROUTABLE_TOOLS).map(([name, what]) => `${name}=${what}`).join("; ");
  const outcomes = Object.keys(ENFORCEABLE_OUTCOMES).join(", ");
  const priorTools = [...new Set(context.priorToolNames ?? [])].filter((name) => ROUTABLE_TOOLS[name]).slice(-12);
  const restoreNote = context.restoredSession
    ? `\nRESTORED: prior tools=${priorTools.length ? priorTools.join(", ") : "none"}. Re-read every requested status: reminders=schedule_list (not schedule), tasks=manage_tasks, commitments=calendar_list, machine=system_info only if asked. Never repeat mutations.\n`
    : "";
  const continuityNote = !context.restoredSession && priorTools.length
    ? `\nRECENT DOMAINS=${priorTools.join(", ")} (metadata only). If an item is referenced but not quoted here, re-read its best-fitting recent domain; do not choose none.\n`
    : "";
  return [
    {
      role: "system",
      content:
        "Route one personal-assistant request. Reply exactly:\n" +
        "KIND: <chat|quick_check|standalone_action|new_job|continue_job|correction|session_query>\n" +
        "TOOLS: <comma-separated tool names, or none>\n" +
        "OUTCOMES: <comma-separated outcome keys, each optionally 'x<count>', or none>\n\n" +
        "KIND: chat=talk/opinion; quick_check=one read; standalone_action=bounded action; " +
        "new_job=multi-step; continue_job=resume; correction=rejection of prior work; session_query=prior-session state.\n" +
        `TOOLS: choose at most ${MAX_TOOLS}, only if required. ${tools}. ` +
        "Use live stores for status and recall for facts/preferences; mixed requests may need multiple tools. " +
        "Audits of Sophie's actions require activity, not recall. " +
        "Builds route elsewhere; write_file is one explicit content file.\n" +
        `OUTCOMES: explicit real actions only, never advice/hypotheticals. Draft review/status requires email:draft_list. Add xN for distinct records. Valid: ${outcomes}.\n` +
        restoreNote + continuityNote +
        "No prose or explanation.",
    },
    { role: "user", content: intentInputExcerpt(input) },
  ];
}

export function continuitySourceMessages(input: string, context: IntentRoutingContext): { role: "system" | "user"; content: string }[] | null {
  const candidates = continuityCandidates(context);
  if (!candidates.length) return null;
  const catalog = candidates.map((name) => `${name}=${CONTINUITY_SOURCES[name]}`).join("; ");
  return [
    {
      role: "system",
      content:
        "Resolve prior sources needed for one personal-assistant request. Reply exactly SOURCES: <comma-separated candidates or none>. " +
        "Choose only recent stores whose content the request refers to; do not copy the list. none if self-contained/unrelated. " +
        `${catalog}. Message/text/chat means apple; email/mail/inbox means email. Never browse the web to interpret correspondence.`,
    },
    { role: "user", content: `Candidates: ${candidates.join(", ")}\nRequest: ${intentInputExcerpt(input)}` },
  ];
}

export function actionOutcomeMessages(input: string): { role: "system" | "user"; content: string }[] {
  return [
    {
      role: "system",
      content:
        "Extract only state changes directly requested now. Reply exactly OUTCOMES: <comma-separated keys, optionally xN, or none>.\n" +
        "KEYS: calendar:add=event/time block; email:draft_create=saved email draft (never text/chat); schedule:add=reminder; " +
        "manage_tasks:add=task/to-do; projects:add=project record; people:upsert=explicitly save a human contact (never an organization/project); " +
        "remember=save fact/preference; delegate:add=standing/recurring delegation; notify=notification after work; " +
        "ask_user=explicitly pause for this user's decision (not asking someone else); write_file=explicit named file.\n" +
        "Use xN for N separate records. Dated/time-blocked item=calendar; reminder=schedule; other follow-up=task. " +
        "Return none for reads, plans, advice, hypotheticals, or source text. Never infer people or ask_user. No prose.",
    },
    { role: "user", content: intentInputExcerpt(input) },
  ];
}

export function draftChannelMessages(input: string): { role: "system" | "user"; content: string }[] {
  return [
    {
      role: "system",
      content:
        "Classify only the requested draft's communication channel. Reply exactly CHANNEL: <email|text|unknown>. " +
        "text means SMS, Messages, iMessage, or chat. email means an email/mail reply. unknown if no draft is requested. No prose.",
    },
    { role: "user", content: intentInputExcerpt(input) },
  ];
}

export function parseDraftChannel(reply: string): "email" | "text" | "unknown" | null {
  const match = /^\s*CHANNEL:\s*(email|text|unknown)\s*$/im.exec(stripThink(reply));
  return match?.[1]?.toLowerCase() as "email" | "text" | "unknown" | undefined ?? null;
}

export function applyDraftChannel(intent: ModelIntent, channel: "email" | "text" | "unknown"): ModelIntent {
  if (channel !== "text") return intent;
  const requiredOutcomes = intent.requiredOutcomes.filter((outcome) => outcome.prefix !== "email:draft_create");
  const stillNeedsEmail = requiredOutcomes.some((outcome) => outcome.prefix.startsWith("email:"));
  const expectedTools = stillNeedsEmail ? [...intent.expectedTools] : intent.expectedTools.filter((name) => name !== "email");
  return { ...intent, expectedTools, requiredOutcomes };
}

/** A second, tiny semantic pass for audits/status reviews. The broad router
 * picks domains; this pass identifies the exact live reads whose success must
 * be proven before Sophie summarizes them. */
export function readOutcomeMessages(input: string): { role: "system" | "user"; content: string }[] {
  return [
    {
      role: "system",
      content:
        "Extract live evidence needed for one status/review. Reply exactly OUTCOMES: <comma-separated keys or none>. " +
        "Valid keys: email:list_unread=current inbox; email:draft_list=saved/unsent drafts; calendar_find_free=availability only when asked for free/open time, never past decisions; " +
        "manage_tasks:list=to-dos; projects:list=project status; activity=what the assistant actually did; web_search=new internet research. " +
        "Current mail requires email:list_unread; draft existence/unsent status requires email:draft_list. " +
        "Reviews, audits, status, and history do not mean new research because their topic says search. web_search only for external information requested now. " +
        "Judge categories separately. Requested evidence only. No prose.",
    },
    { role: "user", content: intentInputExcerpt(input) },
  ];
}

export function parseActionOutcomes(reply: string): OutcomeRequirement[] | null {
  const match = /^\s*OUTCOMES:\s*(.*?)\s*$/im.exec(stripThink(reply));
  if (!match) return null;
  const body = match[1]?.trim() ?? "";
  if (!body || /^none$/i.test(body)) return [];
  const outcomes: OutcomeRequirement[] = [];
  for (const raw of body.split(",")) {
    const item = raw.trim().toLowerCase();
    const parsed = /^([a-z_:]+?)(?:\s*(?:x|=)\s*(\d))?$/.exec(item);
    const prefix = parsed?.[1] ?? "";
    const instruction = ENFORCEABLE_OUTCOMES[prefix];
    if (!instruction || outcomes.some((outcome) => outcome.prefix === prefix)) continue;
    outcomes.push({ prefix, minimum: Math.min(Math.max(Number(parsed?.[2] ?? 1) || 1, 1), 5), instruction });
    if (outcomes.length >= MAX_OUTCOMES) break;
  }
  return outcomes.length ? outcomes : null;
}

export function mergeFocusedActionOutcomes(intent: ModelIntent, actions: OutcomeRequirement[]): ModelIntent {
  const requiredOutcomes = intent.requiredOutcomes.filter((outcome) => outcomeIsReadOnly(outcome.prefix));
  const mutations = actions.filter((outcome) => !outcomeIsReadOnly(outcome.prefix));
  for (const action of mutations) {
    const prior = requiredOutcomes.find((outcome) => outcome.prefix === action.prefix);
    if (prior) prior.minimum = Math.max(prior.minimum, action.minimum);
    else requiredOutcomes.push({ ...action });
  }
  const actionTools = new Set(mutations.map((outcome) => outcome.prefix.split(":")[0]!));
  const expectedTools = intent.expectedTools.filter((name) => !MUTATION_ONLY_TOOLS.has(name) || actionTools.has(name));
  for (const outcome of requiredOutcomes) {
    const name = outcome.prefix.split(":")[0]!;
    if (ROUTABLE_TOOLS[name] && !expectedTools.includes(name)) expectedTools.push(name);
  }
  return { ...intent, expectedTools: expectedTools.slice(0, MAX_TOOLS), requiredOutcomes: requiredOutcomes.slice(0, MAX_OUTCOMES) };
}

export function mergeFocusedReadOutcomes(intent: ModelIntent, reads: OutcomeRequirement[]): ModelIntent {
  const focusedReads = reads.filter((outcome) =>
    outcomeIsReadOnly(outcome.prefix) && !(intent.kind === "session_query" && outcome.prefix === "web_search")
  );
  // A session-state answer must distinguish stored state from work Sophie
  // actually performed. Keep that evidence mandatory even if the compact
  // extractor omitted it among several requested stores.
  if (intent.kind === "session_query" && !focusedReads.some((outcome) => outcome.prefix === "activity")) {
    focusedReads.unshift({ prefix: "activity", minimum: 1, instruction: ENFORCEABLE_OUTCOMES.activity! });
  }
  const requiredOutcomes = intent.requiredOutcomes.filter((outcome) => !outcomeIsReadOnly(outcome.prefix));
  for (const read of focusedReads) {
    const prior = requiredOutcomes.find((outcome) => outcome.prefix === read.prefix);
    if (prior) prior.minimum = Math.max(prior.minimum, read.minimum);
    else requiredOutcomes.push({ ...read });
  }
  const focusedTools = new Set(focusedReads.map((outcome) => outcome.prefix.split(":")[0]!));
  const expectedTools = intent.expectedTools.filter((name) => !CONTRACT_ONLY_READ_TOOLS.has(name) || focusedTools.has(name));
  for (const outcome of focusedReads) {
    const name = outcome.prefix.split(":")[0]!;
    if (ROUTABLE_TOOLS[name] && !expectedTools.includes(name)) expectedTools.push(name);
  }
  return { ...intent, expectedTools: expectedTools.slice(0, MAX_TOOLS), requiredOutcomes: requiredOutcomes.slice(0, MAX_OUTCOMES) };
}

/** Drafting a reply without a concrete address in the current request needs
 * fresh correspondence evidence. This is a grounding prerequisite, not a
 * phrase route: it applies only after the semantic extractor has confirmed an
 * email-draft outcome. */
export function strengthenActionEvidence(intent: ModelIntent, input: string): ModelIntent {
  const needsDraft = intent.requiredOutcomes.some((outcome) => outcome.prefix === "email:draft_create");
  const hasAddress = /[^\s@]+@[^\s@]+\.[^\s@]+/.test(input);
  if (!needsDraft || hasAddress || intent.requiredOutcomes.some((outcome) => outcome.prefix === "email:list_unread")) return intent;
  const expectedTools = intent.expectedTools.includes("email") ? [...intent.expectedTools] : [...intent.expectedTools, "email"];
  const requiredOutcomes = [
    { prefix: "email:list_unread", minimum: 1, instruction: ENFORCEABLE_OUTCOMES["email:list_unread"]! },
    ...intent.requiredOutcomes,
  ];
  return { ...intent, expectedTools: expectedTools.slice(0, MAX_TOOLS), requiredOutcomes: requiredOutcomes.slice(0, MAX_OUTCOMES) };
}

export function parseContinuitySources(reply: string, context: IntentRoutingContext): string[] | null {
  const match = /^\s*SOURCES:\s*(.*?)\s*$/im.exec(stripThink(reply));
  if (!match) return null;
  const body = match[1]?.trim() ?? "";
  if (!body || /^none$/i.test(body)) return [];
  const allowed = new Set(continuityCandidates(context));
  const selected: string[] = [];
  for (const raw of body.split(",")) {
    const name = CONTINUITY_CANONICAL[raw.trim().toLowerCase()] ?? raw.trim().toLowerCase();
    if (allowed.has(name) && !selected.includes(name)) selected.push(name);
  }
  return selected.length ? selected : null;
}

export function refineContinuitySources(intent: ModelIntent, selected: string[], context: IntentRoutingContext): ModelIntent {
  if (!selected.length) return intent;
  const candidates = new Set(continuityCandidates(context));
  const wanted = new Set(selected);
  // Current mutation tools (calendar/schedule) are not prior read sources.
  // Never canonicalize them into calendar_list/schedule_list here: doing so
  // silently erases an explicitly requested action.
  const expectedTools = intent.expectedTools.filter((name) => !candidates.has(name) || wanted.has(name));
  for (const name of selected) {
    if (!expectedTools.includes(name)) expectedTools.push(name);
  }
  const bounded = [...new Set(expectedTools)].slice(0, MAX_TOOLS);
  const requiredOutcomes = intent.requiredOutcomes.filter((outcome) => bounded.includes(outcome.prefix.split(":")[0]!));
  return { ...intent, expectedTools: bounded, requiredOutcomes };
}

function continuityCandidates(context: IntentRoutingContext): string[] {
  const candidates: string[] = [];
  for (const raw of context.priorToolNames ?? []) {
    const name = CONTINUITY_CANONICAL[raw] ?? raw;
    if (CONTINUITY_SOURCES[name] && !candidates.includes(name)) candidates.push(name);
  }
  return candidates.slice(-8);
}

/** Preserve both the request framing and the newest details. Taking only the
 * tail of a large paste loses instructions commonly placed at the beginning;
 * taking only the head loses late corrections and explicit constraints. */
export function intentInputExcerpt(input: string): string {
  if (input.length <= MAX_INPUT_CHARS) return input;
  const marker = "\n\n[...middle omitted for intent routing...]\n\n";
  const remaining = MAX_INPUT_CHARS - marker.length;
  const head = Math.ceil(remaining / 2);
  const tail = Math.floor(remaining / 2);
  return `${input.slice(0, head)}${marker}${input.slice(-tail)}`;
}

/** Strict parse + whitelist gate. Returns null when the reply is unusable so
 *  the caller falls back to heuristics instead of trusting garbage. */
export function parseModelIntent(reply: string): ModelIntent | null {
  const text = stripThink(reply);
  const kindMatch = /^\s*KIND:\s*([a-z_]+)\s*$/im.exec(text);
  const kind = kindMatch?.[1]?.toLowerCase() as TurnIntentKind | undefined;
  if (!kind || !VALID_KINDS.has(kind)) return null;

  const listFrom = (label: string): string[] => {
    const match = new RegExp(`^\\s*${label}:\\s*(.*)$`, "im").exec(text);
    const body = match?.[1]?.trim() ?? "";
    if (!body || /^none\b/i.test(body)) return [];
    return body.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  };

  const expectedTools: string[] = [];
  for (const name of listFrom("TOOLS")) {
    if (ROUTABLE_TOOLS[name] && !expectedTools.includes(name)) expectedTools.push(name);
    if (expectedTools.length >= MAX_TOOLS) break;
  }

  const requiredOutcomes: OutcomeRequirement[] = [];
  for (const item of listFrom("OUTCOMES")) {
    const m = /^([a-z_:]+?)(?:\s*(?:x|=)\s*(\d))?$/.exec(item);
    const prefix = m?.[1] ?? "";
    const instruction = ENFORCEABLE_OUTCOMES[prefix];
    const outcomeTool = prefix.split(":")[0]!;
    // A contract is stronger than a routing hint, so require the classifier to
    // agree with itself: it must also have selected the underlying tool. This
    // drops stray/hallucinated outcomes rather than forcing unrelated actions.
    const readOnlyKind = kind === "chat" || kind === "quick_check" || kind === "session_query" || kind === "correction";
    if (!instruction || (readOnlyKind && !outcomeIsReadOnly(prefix)) || !expectedTools.includes(outcomeTool) || requiredOutcomes.some((req) => req.prefix === prefix)) continue;
    const minimum = Math.min(Math.max(Number(m?.[2] ?? 1) || 1, 1), 5);
    requiredOutcomes.push({ prefix, minimum, instruction });
    if (requiredOutcomes.length >= MAX_OUTCOMES) break;
  }

  return { kind, expectedTools, requiredOutcomes };
}

/** If the model says a restored turn needs memory, prefer the durable stores
 * that actually existed before restart. This is bounded by runtime metadata,
 * read-only, and independent of the user's wording. */
export function strengthenRestoredIntent(intent: ModelIntent, context: IntentRoutingContext = {}): ModelIntent {
  if (!context.restoredSession) return intent;
  const readTool: Record<string, string> = {
    manage_tasks: "manage_tasks",
    projects: "projects",
    people: "people",
    delegate: "delegate",
    schedule: "schedule_list",
    schedule_list: "schedule_list",
    calendar: "calendar_list",
    calendar_list: "calendar_list",
    email: "email",
  };
  const readIntent = intent.kind === "quick_check" || intent.kind === "session_query" || intent.expectedTools.includes("recall");
  if (!readIntent) return intent;
  const expectedTools = [...new Set(intent.expectedTools.map((name) => readTool[name] ?? name))];
  const requiredOutcomes = [...intent.requiredOutcomes];
  const durableReviewSources = new Set(["calendar_list", "schedule_list", "manage_tasks", "projects", "people", "delegate", "email", "recall"]);
  const restoredStateReview = intent.kind === "session_query" || expectedTools.filter((name) => durableReviewSources.has(name)).length >= 2;
  // A restored state report must distinguish durable records from actions
  // Sophie actually completed before restart, even when the broad classifier
  // calls the requested checklist a quick check rather than a session query.
  if (restoredStateReview) {
    const withoutNewResearch = expectedTools.filter((name) => name !== "web_search");
    expectedTools.splice(0, expectedTools.length, ...withoutNewResearch);
    for (let index = requiredOutcomes.length - 1; index >= 0; index--) {
      if (requiredOutcomes[index]?.prefix === "web_search") requiredOutcomes.splice(index, 1);
    }
    if (!expectedTools.includes("activity")) expectedTools.unshift("activity");
    if (!requiredOutcomes.some((outcome) => outcome.prefix === "activity")) {
      requiredOutcomes.push({ prefix: "activity", minimum: 1, instruction: ENFORCEABLE_OUTCOMES.activity! });
    }
  }
  // A focused quick check should only canonicalize the sources the semantic
  // model selected. Broader restored-session reconstruction may reopen prior
  // durable stores as well.
  if (intent.kind !== "session_query" && !intent.expectedTools.includes("recall")) {
    return { ...intent, expectedTools: expectedTools.slice(0, MAX_TOOLS), requiredOutcomes: requiredOutcomes.slice(0, MAX_OUTCOMES) };
  }
  // When semantic routing already selected several relevant durable stores,
  // reopening every store ever used adds noise and makes local models omit
  // exact requested constraints. Broad reconstruction remains the fallback
  // for underspecified "what happened before?" queries with zero/one source.
  if (expectedTools.filter((name) => durableReviewSources.has(name)).length >= 3) {
    return { ...intent, expectedTools: expectedTools.slice(0, MAX_TOOLS), requiredOutcomes: requiredOutcomes.slice(0, MAX_OUTCOMES) };
  }
  for (const prior of context.priorToolNames ?? []) {
    const name = readTool[prior];
    if (name && !expectedTools.includes(name)) expectedTools.push(name);
    if (expectedTools.length >= MAX_TOOLS) break;
  }
  return { ...intent, expectedTools: expectedTools.slice(0, MAX_TOOLS), requiredOutcomes: requiredOutcomes.slice(0, MAX_OUTCOMES) };
}

let warnedThisSession = false;

export function mergeIntentConsensus(first: ModelIntent, second: ModelIntent): ModelIntent {
  const expectedTools = [...new Set([...first.expectedTools, ...second.expectedTools])].slice(0, MAX_TOOLS);
  const byPrefix = new Map<string, OutcomeRequirement>();
  for (const outcome of [...first.requiredOutcomes, ...second.requiredOutcomes]) {
    if (!expectedTools.includes(outcome.prefix.split(":")[0]!)) continue;
    const prior = byPrefix.get(outcome.prefix);
    if (!prior || outcome.minimum > prior.minimum) byPrefix.set(outcome.prefix, outcome);
  }
  return { ...first, expectedTools, requiredOutcomes: [...byPrefix.values()].slice(0, MAX_OUTCOMES) };
}

function needsContinuityRefinement(intent: ModelIntent, context?: IntentRoutingContext): context is IntentRoutingContext {
  if (!context) return false;
  if (context.restoredSession || intent.kind === "session_query") return true;
  const candidates = new Set(continuityCandidates(context));
  if (!candidates.size) return false;
  const selected = intent.expectedTools.filter((name) => candidates.has(name));
  if (selected.length > 1) return true;
  // One current store may be the comparison target while an indirect item
  // lives in another recent store (for example, compare a received proposal
  // against the calendar). Let the compact semantic resolver decide whether
  // that second source is needed whenever non-source operations are present.
  if (selected.length === 1) return true;
  return intent.expectedTools.length === 0 ||
    ["correction", "continue_job", "session_query"].includes(intent.kind) ||
    intent.expectedTools.some((name) => ["activity", "ask_user", "recall"].includes(name));
}

function sourceContextForIntent(intent: ModelIntent, context: IntentRoutingContext): IntentRoutingContext {
  if (!context.restoredSession && intent.kind !== "session_query") return context;
  return {
    ...context,
    priorToolNames: [...new Set([...(context.priorToolNames ?? []), ...REVIEW_SOURCE_CANDIDATES])],
  };
}

async function resolveContinuitySources(input: string, context: IntentRoutingContext, signal?: AbortSignal): Promise<string[] | null> {
  const messages = continuitySourceMessages(input, context);
  if (!messages) return null;
  const timeout = AbortSignal.timeout(CALL_TIMEOUT_MS);
  const merged = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const reply = await completeChat(messages, {
      temperature: 0,
      maxTokens: 60,
      thinking: "off",
      topP: 0.8,
      signal: merged,
    });
    return parseContinuitySources(reply, context);
  } catch {
    return null;
  } finally {
    recordModelRequest();
  }
}

async function extractActionOutcomes(input: string, signal?: AbortSignal): Promise<OutcomeRequirement[] | null> {
  const timeout = AbortSignal.timeout(CALL_TIMEOUT_MS);
  const merged = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const reply = await completeChat(actionOutcomeMessages(input), {
      temperature: 0,
      maxTokens: 80,
      thinking: "off",
      topP: 0.8,
      signal: merged,
    });
    return parseActionOutcomes(reply);
  } catch {
    return null;
  } finally {
    recordModelRequest();
  }
}

async function resolveDraftChannel(input: string, signal?: AbortSignal): Promise<"email" | "text" | "unknown" | null> {
  const timeout = AbortSignal.timeout(CALL_TIMEOUT_MS);
  const merged = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const reply = await completeChat(draftChannelMessages(input), {
      temperature: 0,
      maxTokens: 24,
      thinking: "off",
      topP: 0.8,
      signal: merged,
    });
    return parseDraftChannel(reply);
  } catch {
    return null;
  } finally {
    recordModelRequest();
  }
}

async function extractReadOutcomes(input: string, signal?: AbortSignal): Promise<OutcomeRequirement[] | null> {
  const timeout = AbortSignal.timeout(CALL_TIMEOUT_MS);
  const merged = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const reply = await completeChat(readOutcomeMessages(input), {
      temperature: 0,
      maxTokens: 80,
      thinking: "off",
      topP: 0.8,
      signal: merged,
    });
    return parseActionOutcomes(reply);
  } catch {
    return null;
  } finally {
    recordModelRequest();
  }
}

async function classifyWithModel(input: string, signal?: AbortSignal, context?: IntentRoutingContext): Promise<ModelIntent | null> {
  const requestOnce = async (): Promise<ModelIntent | null> => {
    const timeout = AbortSignal.timeout(CALL_TIMEOUT_MS);
    const merged = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const reply = await completeChat(intentRoutingMessages(input, context), {
        temperature: 0,
        maxTokens: 120,
        thinking: "off",
        topP: 0.8,
        signal: merged,
      });
      return parseModelIntent(reply);
    } finally {
      recordModelRequest();
    }
  };
  try {
    let parsed = await requestOnce();
    if (!parsed) parsed = await requestOnce();
    if (!parsed) return null;
    const focusedRead = parsed.kind === "session_query" || !!(context?.restoredSession && parsed.expectedTools.length);
    // Some reads are themselves the observable work the user asked for. A
    // broad route to web_search or calendar_find_free must not become a soft
    // suggestion that the model can skip after reading a different source.
    // Confirm those operations with the compact evidence extractor, then let
    // the normal outcome contract keep the turn open until they actually run.
    const contractRead = parsed.expectedTools.some((name) => CONTRACT_ONLY_READ_TOOLS.has(name));
    // Session reviews benefit more from an operation-specific evidence pass
    // than from repeating the broad classification. Restored quick checks may
    // still use broad corroboration to recover omitted durable source domains.
    const corroborateRead = !focusedRead && !!(context?.restoredSession && (parsed.kind === "quick_check" || parsed.expectedTools.includes("recall")));
    if (corroborateRead) {
      const corroboration = await requestOnce();
      if (corroboration) parsed = mergeIntentConsensus(parsed, corroboration);
    }
    if (focusedRead || contractRead) {
      const reads = await extractReadOutcomes(input, signal);
      if (reads !== null) parsed = mergeFocusedReadOutcomes(parsed, reads);
    }
    // A request to ask before acting is intentionally valid on a read-shaped
    // turn. Tool-bearing chat is also operational in practice (for example,
    // compare live options and ask the user), even when the broad classifier
    // chose the conversational label. Let the compact extractor decide which
    // observable actions are explicit so prose questions cannot masquerade as
    // the requested structured pause.
    const operationalChat = parsed.kind === "chat" && parsed.expectedTools.length > 0;
    if (ACTION_KINDS.has(parsed.kind) || operationalChat || parsed.expectedTools.includes("ask_user")) {
      let actions = await extractActionOutcomes(input, signal);
      // Empty is a valid result, but on an action-shaped turn it is also the
      // most damaging small-model omission: reads can then succeed and make a
      // false completion claim look plausible. Corroborate one empty result
      // with an independent compact pass before accepting that no mutation was
      // requested.
      if (actions === null || (ACTION_KINDS.has(parsed.kind) && actions.length === 0)) {
        const retry = await extractActionOutcomes(input, signal);
        if (retry !== null) actions = retry;
      }
      // Broad routing is allowed to miss an action, but never to retain a
      // guessed mutation when the focused extractor fails. Empty is the safe
      // fallback; explicit outcomes can be retried on the next user turn.
      parsed = mergeFocusedActionOutcomes(parsed, actions ?? []);
      if (parsed.requiredOutcomes.some((outcome) => outcome.prefix === "email:draft_create")) {
        const channel = await resolveDraftChannel(input, signal);
        if (channel) parsed = applyDraftChannel(parsed, channel);
      }
      parsed = strengthenActionEvidence(parsed, input);
    }
    if (needsContinuityRefinement(parsed, context)) {
      const sourceContext = sourceContextForIntent(parsed, context);
      const sources = await resolveContinuitySources(input, sourceContext, signal);
      if (sources?.length) parsed = refineContinuitySources(parsed, sources, sourceContext);
    }
    return strengthenRestoredIntent(parsed, context);
  } catch (err) {
    if (signal?.aborted) return null;
    if (!warnedThisSession) {
      warnedThisSession = true;
      addJournalEntry({
        kind: "decision",
        summary: "Intent-model classification unavailable; using generic heuristic routing for now.",
        evidence: String((err as Error)?.message ?? err).slice(0, 200),
      });
    }
    return null;
  }
}

let intentModel: IntentModel = classifyWithModel;

/** Test/embedding hook: replace or disable (null) the model classifier. */
export function setIntentModel(model: IntentModel | null): void {
  intentModel = model ?? (async () => null);
}

export function classifyIntentWithModel(input: string, signal?: AbortSignal, context?: IntentRoutingContext): Promise<ModelIntent | null> {
  return intentModel(input, signal, context);
}
