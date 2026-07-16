/**
 * Model-based turn intent classification — the replacement for phrase-list
 * routing. ONE small, thinking-off call asks the local model what kind of turn
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
 *
 * Deliberately NOT here: corroboration re-asks, secondary extraction passes,
 * or merge pipelines that paper over single-call misses. One call, one parse,
 * one gate. If the model misroutes a turn, the escape hatches downstream
 * (undisclosed tools still execute, restrictions lift on first violation)
 * absorb it — routing accuracy is the model's job, not the runtime's.
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
  email: "inbox and drafts",
  apple: "Apple contacts (find/browse/save), iMessages, Notes, Reminders",
  calendar_list: "read events",
  calendar_find_free: "find free slots",
  calendar: "add/change event",
  schedule: "add reminder",
  schedule_list: "read reminders",
  manage_tasks: "stored to-dos, not prose plans",
  projects: "stored projects, not prose plans",
  people: "Sophie's relationship notes, NOT Apple contacts",
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

export function intentRoutingMessages(input: string, context: IntentRoutingContext = {}): { role: "system" | "user"; content: string }[] {
  const tools = Object.entries(ROUTABLE_TOOLS).map(([name, what]) => `${name}=${what}`).join("; ");
  const outcomes = Object.keys(ENFORCEABLE_OUTCOMES).join(", ");
  const priorTools = [...new Set(context.priorToolNames ?? [])].filter((name) => ROUTABLE_TOOLS[name]).slice(-12);
  const contextNote = context.restoredSession
    ? `\nRESTORED: this session was restored from disk; earlier tools used=${priorTools.length ? priorTools.join(", ") : "none"}. Prefer re-reading live stores over assuming remembered state; never repeat past mutations.\n`
    : priorTools.length
      ? `\nRECENT DOMAINS=${priorTools.join(", ")} (metadata only). If the request references an earlier item not quoted in it, include that item's source domain.\n`
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
        `TOOLS: choose at most ${MAX_TOOLS}, only if required. ${tools}. Builds route elsewhere.\n` +
        "OUTCOMES: explicit real actions the user requested this turn — never advice, questions, or hypotheticals. " +
        "email:draft_create only when the draft is an email, never a text/iMessage. Add xN for N distinct records. " +
        `Valid: ${outcomes}.\n` +
        contextNote +
        "No prose or explanation.",
    },
    { role: "user", content: intentInputExcerpt(input) },
  ];
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
    // Read-shaped kinds may only carry read-only evidence contracts — a
    // conversational turn can never be forced into a mutation.
    const readOnlyKind = kind === "chat" || kind === "quick_check" || kind === "session_query" || kind === "correction";
    if (!instruction || (readOnlyKind && !outcomeIsReadOnly(prefix)) || !expectedTools.includes(outcomeTool) || requiredOutcomes.some((req) => req.prefix === prefix)) continue;
    const minimum = Math.min(Math.max(Number(m?.[2] ?? 1) || 1, 1), 5);
    requiredOutcomes.push({ prefix, minimum, instruction });
    if (requiredOutcomes.length >= MAX_OUTCOMES) break;
  }

  return { kind, expectedTools, requiredOutcomes };
}

let warnedThisSession = false;

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
    // One retry strictly for an unparseable reply (format noise), never to
    // second-guess a parseable classification.
    return (await requestOnce()) ?? (await requestOnce());
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
