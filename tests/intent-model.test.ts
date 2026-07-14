import { describe, expect, test } from "bun:test";
import { ROUTABLE_TOOLS, intentInputExcerpt, intentRoutingMessages, parseModelIntent } from "../src/agent/intent_model.ts";
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
      "KIND: standalone_action\nTOOLS: apple, calendar_list\nOUTCOMES: activity, manage_tasks:add",
    );
    expect(parsed?.expectedTools).toEqual(["apple", "calendar_list"]);
    expect(parsed?.requiredOutcomes).toEqual([]);
  });

  test("read-only intent kinds cannot force unrequested mutations", () => {
    const parsed = parseModelIntent("KIND: quick_check\nTOOLS: calendar, email\nOUTCOMES: calendar:update");
    expect(parsed?.requiredOutcomes).toEqual([]);
  });

  test("read-only kinds may still require read-only evidence", () => {
    const parsed = parseModelIntent("KIND: session_query\nTOOLS: activity, email\nOUTCOMES: activity, email:draft_list");
    expect(parsed?.requiredOutcomes.map((r) => r.prefix)).toEqual(["activity", "email:draft_list"]);
  });

  test("honors explicit multiplicity with a sane cap", () => {
    const parsed = parseModelIntent("KIND: standalone_action\nTOOLS: projects, people\nOUTCOMES: projects:add x2, people:upsert x9");
    expect(parsed?.requiredOutcomes.find((r) => r.prefix === "projects:add")?.minimum).toBe(2);
    expect(parsed?.requiredOutcomes.find((r) => r.prefix === "people:upsert")?.minimum).toBe(5);
  });

  test("handles none, duplicates, and stray thinking tags", () => {
    const parsed = parseModelIntent("<think>routing...</think>\nKIND: chat\nTOOLS: none\nOUTCOMES: none");
    expect(parsed).toEqual({ kind: "chat", expectedTools: [], requiredOutcomes: [] });
    const deduped = parseModelIntent("KIND: standalone_action\nTOOLS: weather, weather, notify\nOUTCOMES: notify, notify");
    expect(deduped?.expectedTools).toEqual(["weather", "notify"]);
    expect(deduped?.requiredOutcomes).toHaveLength(1);
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

  test("routing context adds only compact metadata, never extra model passes", () => {
    const restored = intentRoutingMessages("What's still open?", { restoredSession: true, priorToolNames: ["email", "manage_tasks", "bash"] });
    expect(restored[0]!.content).toContain("RESTORED");
    expect(restored[0]!.content).toContain("email, manage_tasks");
    expect(restored[0]!.content).not.toContain("bash"); // non-routable names are filtered
    const continuity = intentRoutingMessages("Reply to that message.", { priorToolNames: ["apple"] });
    expect(continuity[0]!.content).toContain("RECENT DOMAINS=apple");
    expect(intentRoutingMessages("hello")[0]!.content).not.toContain("RECENT DOMAINS");
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
