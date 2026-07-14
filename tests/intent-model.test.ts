import { describe, expect, test } from "bun:test";
import {
  ROUTABLE_TOOLS,
  actionOutcomeMessages,
  applyDraftChannel,
  continuitySourceMessages,
  draftChannelMessages,
  intentInputExcerpt,
  intentRoutingMessages,
  mergeIntentConsensus,
  mergeFocusedActionOutcomes,
  mergeFocusedReadOutcomes,
  parseActionOutcomes,
  parseContinuitySources,
  parseDraftChannel,
  parseModelIntent,
  readOutcomeMessages,
  refineContinuitySources,
  strengthenActionEvidence,
  strengthenRestoredIntent,
} from "../src/agent/intent_model.ts";
import { messagesTokens } from "../src/agent/context.ts";
import { ENFORCEABLE_OUTCOMES } from "../src/agent/outcome_contract.ts";
import { getTool } from "../src/tools/registry.ts";

describe("intent model reply parsing", () => {
  test("parses a well-formed three-line classification", () => {
    const parsed = parseModelIntent("KIND: standalone_action\nTOOLS: email, calendar_list, schedule\nOUTCOMES: schedule:add");
    expect(parsed?.kind).toBe("standalone_action");
    expect(parsed?.expectedTools).toEqual(["email", "calendar_list", "schedule"]);
    expect(parsed?.requiredOutcomes.map((r) => r.prefix)).toEqual(["schedule:add"]);
    expect(parsed?.requiredOutcomes[0]?.instruction).toBe(ENFORCEABLE_OUTCOMES["schedule:add"]);
  });

  test("drops unknown tools and outcome keys instead of trusting them", () => {
    const parsed = parseModelIntent("KIND: standalone_action\nTOOLS: email, notify, made_up_tool, bash\nOUTCOMES: rm_rf:everything, notify");
    expect(parsed?.expectedTools).toEqual(["email", "notify"]);
    expect(parsed?.requiredOutcomes.map((r) => r.prefix)).toEqual(["notify"]);
  });

  test("drops an outcome when the classifier did not also select its tool", () => {
    const parsed = parseModelIntent(
      "KIND: quick_check\nTOOLS: apple, calendar_list\nOUTCOMES: activity, manage_tasks:list",
    );
    expect(parsed?.expectedTools).toEqual(["apple", "calendar_list"]);
    expect(parsed?.requiredOutcomes).toEqual([]);
  });

  test("honors explicit multiplicity with a sane cap", () => {
    const parsed = parseModelIntent("KIND: standalone_action\nTOOLS: projects, people\nOUTCOMES: projects:add x2, people:upsert x9");
    expect(parsed?.requiredOutcomes.find((r) => r.prefix === "projects:add")?.minimum).toBe(2);
    expect(parsed?.requiredOutcomes.find((r) => r.prefix === "people:upsert")?.minimum).toBe(5);
    expect(parseActionOutcomes("OUTCOMES: schedule:add=1, manage_tasks:add=2")?.map((r) => `${r.prefix}x${r.minimum}`)).toEqual([
      "schedule:addx1",
      "manage_tasks:addx2",
    ]);
  });

  test("handles none, duplicates, and stray thinking tags", () => {
    const parsed = parseModelIntent("<think>routing...</think>\nKIND: chat\nTOOLS: none\nOUTCOMES: none");
    expect(parsed).toEqual({ kind: "chat", expectedTools: [], requiredOutcomes: [] });
    const deduped = parseModelIntent("KIND: standalone_action\nTOOLS: weather, weather, notify\nOUTCOMES: notify, notify");
    expect(deduped?.expectedTools).toEqual(["weather", "notify"]);
    expect(deduped?.requiredOutcomes).toHaveLength(1);
  });

  test("read-only intent kinds cannot force unrequested mutations", () => {
    const parsed = parseModelIntent(
      "KIND: chat\nTOOLS: email, manage_tasks, calendar_find_free\nOUTCOMES: email:draft_create, manage_tasks:add, calendar_find_free",
    )!;
    expect(parsed.requiredOutcomes.map((outcome) => outcome.prefix)).toEqual(["calendar_find_free"]);
  });

  test("read-only reviews may require a real saved-draft read", () => {
    const parsed = parseModelIntent(
      "KIND: session_query\nTOOLS: email, activity\nOUTCOMES: email:draft_list, activity",
    )!;
    expect(parsed.requiredOutcomes.map((outcome) => outcome.prefix)).toEqual(["email:draft_list", "activity"]);
  });

  test("focused semantic action extraction replaces guessed mutations and adds their tools", () => {
    const actions = parseActionOutcomes("OUTCOMES: calendar:add x2, email:draft_create, made_up")!;
    const intent = parseModelIntent(
      "KIND: new_job\nTOOLS: calendar_find_free, manage_tasks\nOUTCOMES: manage_tasks:add",
    )!;
    const merged = mergeFocusedActionOutcomes(intent, actions);
    expect(merged.requiredOutcomes.map((outcome) => `${outcome.prefix}x${outcome.minimum}`)).toEqual([
      "calendar:addx2",
      "email:draft_createx1",
    ]);
    expect(merged.expectedTools).toContain("calendar");
    expect(merged.expectedTools).toContain("email");
    expect(parseActionOutcomes("OUTCOMES: none")).toEqual([]);
    expect(messagesTokens(actionOutcomeMessages("Create a task."))).toBeLessThan(320);
  });

  test("focused extraction removes broad guessed contact and confirmation actions", () => {
    const broad = parseModelIntent(
      "KIND: new_job\nTOOLS: people, manage_tasks, ask_user\nOUTCOMES: people:upsert, manage_tasks:add, ask_user",
    )!;
    const focused = mergeFocusedActionOutcomes(broad, parseActionOutcomes("OUTCOMES: manage_tasks:add")!);
    expect(focused.expectedTools).toEqual(["manage_tasks"]);
    expect(focused.requiredOutcomes.map((outcome) => outcome.prefix)).toEqual(["manage_tasks:add"]);
  });

  test("focused extraction can enforce an explicit structured pause on a read turn", () => {
    const intent = parseModelIntent("KIND: chat\nTOOLS: calendar_list, ask_user\nOUTCOMES: none")!;
    const actions = parseActionOutcomes("OUTCOMES: ask_user")!;
    const merged = mergeFocusedActionOutcomes(intent, actions);
    expect(merged.requiredOutcomes.map((outcome) => outcome.prefix)).toEqual(["ask_user"]);
    expect(merged.expectedTools).toEqual(["calendar_list", "ask_user"]);
    expect(actionOutcomeMessages("Check availability and confirm with me before booking.")[0]!.content).toContain("explicitly pause for this user's decision");
  });

  test("focused review extraction requires exact stores and drops accidental new research", () => {
    const intent = parseModelIntent(
      "KIND: session_query\nTOOLS: email, calendar_list, projects, web_search, activity\nOUTCOMES: web_search, activity",
    )!;
    const reads = parseActionOutcomes("OUTCOMES: email:list_unread, email:draft_list, projects:list, activity, web_search")!;
    const merged = mergeFocusedReadOutcomes(intent, reads);
    expect(merged.expectedTools).toEqual(["email", "calendar_list", "projects", "activity"]);
    expect(merged.requiredOutcomes.map((outcome) => outcome.prefix)).toEqual([
      "email:list_unread",
      "email:draft_list",
      "projects:list",
      "activity",
    ]);
    expect(messagesTokens(readOutcomeMessages("Review current inbox, drafts, tasks, and prior work."))).toBeLessThan(250);
  });

  test("focused read extraction turns explicit external research into observable work", () => {
    const intent = parseModelIntent(
      "KIND: standalone_action\nTOOLS: web_search, system_info\nOUTCOMES: none",
    )!;
    const reads = parseActionOutcomes("OUTCOMES: web_search")!;
    const merged = mergeFocusedReadOutcomes(intent, reads);
    expect(merged.expectedTools).toEqual(["web_search", "system_info"]);
    expect(merged.requiredOutcomes.map((outcome) => outcome.prefix)).toEqual(["web_search"]);
  });

  test("an email draft without a supplied address re-reads correspondence first", () => {
    const intent = parseModelIntent("KIND: standalone_action\nTOOLS: email\nOUTCOMES: email:draft_create")!;
    const strengthened = strengthenActionEvidence(intent, "Draft a reply to the sender, but do not send it.");
    expect(strengthened.requiredOutcomes.map((outcome) => outcome.prefix)).toEqual(["email:list_unread", "email:draft_create"]);
    expect(strengthenActionEvidence(intent, "Draft to person@example.com, but do not send it.").requiredOutcomes.map((outcome) => outcome.prefix)).toEqual(["email:draft_create"]);
  });

  test("semantic draft-channel resolution never turns a text draft into email state", () => {
    const intent = parseModelIntent("KIND: standalone_action\nTOOLS: apple, email\nOUTCOMES: email:draft_create")!;
    const textDraft = applyDraftChannel(intent, parseDraftChannel("CHANNEL: text")!);
    expect(textDraft.expectedTools).toEqual(["apple"]);
    expect(textDraft.requiredOutcomes).toEqual([]);
    expect(applyDraftChannel(intent, parseDraftChannel("CHANNEL: email")!)).toEqual(intent);
    expect(parseDraftChannel("I think this is a text.")).toBeNull();
    expect(messagesTokens(draftChannelMessages("Draft a reply."))).toBeLessThan(100);
  });

  test("every session-state review requires actual activity evidence", () => {
    const intent = parseModelIntent("KIND: session_query\nTOOLS: calendar_list, email\nOUTCOMES: email:list_unread")!;
    const merged = mergeFocusedReadOutcomes(intent, parseActionOutcomes("OUTCOMES: email:list_unread")!);
    expect(merged.expectedTools).toContain("activity");
    expect(merged.requiredOutcomes.map((outcome) => outcome.prefix)).toEqual(["activity", "email:list_unread"]);
  });

  test("rejects garbage rather than guessing", () => {
    expect(parseModelIntent("Sure! I think this is probably a chat message.")).toBeNull();
    expect(parseModelIntent("KIND: world_domination\nTOOLS: none\nOUTCOMES: none")).toBeNull();
    expect(parseModelIntent("")).toBeNull();
  });

  test("long-input routing retains both opening instructions and late constraints", () => {
    const input = `OPENING INSTRUCTION ${"middle ".repeat(800)} LATE CONSTRAINT`;
    const excerpt = intentInputExcerpt(input);
    expect(excerpt).toStartWith("OPENING INSTRUCTION");
    expect(excerpt).toEndWith("LATE CONSTRAINT");
    expect(excerpt).toContain("middle omitted for intent routing");
    expect(excerpt.length).toBeLessThanOrEqual(2400);
  });

  test("routing prompt stays small enough for local models", () => {
    expect(messagesTokens(intentRoutingMessages("Help me sort out tomorrow."))).toBeLessThan(600);
  });

  test("a restored session supplies only compact prior-tool metadata", () => {
    const messages = intentRoutingMessages("What is still pending?", {
      restoredSession: true,
      priorToolNames: ["email", "manage_tasks", "schedule", "not_a_tool"],
    });
    expect(messages[0]!.content).toContain("RESTORED:");
    expect(messages[0]!.content).toContain("email, manage_tasks, schedule");
    expect(messages[0]!.content).not.toContain("not_a_tool");
    expect(messagesTokens(messages)).toBeLessThan(700);
  });

  test("continuity source resolution is compact and strictly limited to recent stores", () => {
    const context = { priorToolNames: ["email", "calendar", "web_search", "not_a_tool"] };
    const messages = continuitySourceMessages("Evaluate the item I just received.", context)!;
    expect(messagesTokens(messages)).toBeLessThan(200);
    expect(messages[0]!.content).toContain("email=received email/mail/inbox items");
    expect(messages[0]!.content).toContain("Message/text/chat means apple");
    expect(messages[0]!.content).toContain("calendar_list=events/appointments");
    expect(messages[0]!.content).not.toContain("not_a_tool");
    expect(parseContinuitySources("SOURCES: email, not_a_tool", context)).toEqual(["email"]);
    expect(parseContinuitySources("SOURCES: none", context)).toEqual([]);
    expect(parseContinuitySources("email", context)).toBeNull();
  });

  test("semantic continuity refinement removes unrelated recent domains", () => {
    const context = { priorToolNames: ["email", "calendar_list", "web_search"] };
    const intent = parseModelIntent(
      "KIND: correction\nTOOLS: activity, email, calendar_list, web_search\nOUTCOMES: activity, web_search",
    )!;
    const refined = refineContinuitySources(intent, ["email"], context);
    expect(refined.expectedTools).toEqual(["activity", "email"]);
    expect(refined.requiredOutcomes.map((outcome) => outcome.prefix)).toEqual(["activity"]);
  });

  test("continuity refinement never converts a requested mutation into a read", () => {
    const context = { priorToolNames: ["email", "calendar_list"] };
    const intent = parseModelIntent(
      "KIND: new_job\nTOOLS: email, calendar, calendar_list\nOUTCOMES: email:draft_create, calendar:add",
    )!;
    const refined = refineContinuitySources(intent, ["email"], context);
    expect(refined.expectedTools).toEqual(["email", "calendar"]);
    expect(refined.requiredOutcomes.map((outcome) => outcome.prefix)).toEqual(["email:draft_create", "calendar:add"]);
  });

  test("restored recall expands only to canonical stores that were actually used", () => {
    const intent = parseModelIntent("KIND: session_query\nTOOLS: recall, calendar_list\nOUTCOMES: none")!;
    expect(strengthenRestoredIntent(intent, {
      restoredSession: true,
      priorToolNames: ["email", "manage_tasks", "schedule", "calendar_list"],
    }).expectedTools).toEqual(["activity", "recall", "calendar_list", "email", "manage_tasks", "schedule_list"]);
  });

  test("restored session queries reopen prior canonical stores without requiring recall", () => {
    const intent = parseModelIntent("KIND: session_query\nTOOLS: calendar_list, web_search\nOUTCOMES: web_search")!;
    const strengthened = strengthenRestoredIntent(intent, {
      restoredSession: true,
      priorToolNames: ["email", "manage_tasks", "schedule"],
    });
    expect(strengthened.expectedTools).toEqual(["activity", "calendar_list", "email", "manage_tasks", "schedule_list"]);
    expect(strengthened.requiredOutcomes.map((outcome) => outcome.prefix)).toEqual(["activity"]);
  });

  test("restored ordinary chat does not reopen personal stores", () => {
    const intent = parseModelIntent("KIND: chat\nTOOLS: none\nOUTCOMES: none")!;
    expect(strengthenRestoredIntent(intent, {
      restoredSession: true,
      priorToolNames: ["email", "manage_tasks", "schedule"],
    }).expectedTools).toEqual([]);
  });

  test("restored quick checks canonicalize selected mutations without opening unrelated stores", () => {
    const intent = parseModelIntent("KIND: quick_check\nTOOLS: calendar_list, manage_tasks, schedule\nOUTCOMES: manage_tasks:list")!;
    expect(strengthenRestoredIntent(intent, {
      restoredSession: true,
      priorToolNames: ["email", "projects"],
    }).expectedTools).toEqual(["activity", "calendar_list", "manage_tasks", "schedule_list"]);
  });

  test("restored read consensus unions sources while preserving enforceable outcomes", () => {
    const first = parseModelIntent("KIND: quick_check\nTOOLS: calendar_list, manage_tasks\nOUTCOMES: manage_tasks:list")!;
    const second = parseModelIntent("KIND: quick_check\nTOOLS: schedule_list, system_info\nOUTCOMES: none")!;
    expect(mergeIntentConsensus(first, second)).toMatchObject({
      expectedTools: ["calendar_list", "manage_tasks", "schedule_list", "system_info"],
      requiredOutcomes: [expect.objectContaining({ prefix: "manage_tasks:list" })],
    });
  });
});

describe("runtime gate stays in sync with the real registry", () => {
  test("every routable tool is a registered tool", () => {
    for (const name of Object.keys(ROUTABLE_TOOLS)) {
      expect(getTool(name), `ROUTABLE_TOOLS lists unregistered tool: ${name}`).toBeTruthy();
    }
  });

  test("every enforceable outcome maps to a registered tool", () => {
    for (const prefix of Object.keys(ENFORCEABLE_OUTCOMES)) {
      const tool = prefix.split(":")[0]!;
      expect(getTool(tool), `ENFORCEABLE_OUTCOMES references unregistered tool: ${tool}`).toBeTruthy();
    }
  });
});
