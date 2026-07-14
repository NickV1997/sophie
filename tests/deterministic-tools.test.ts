import { beforeEach, describe, expect, test } from "bun:test";
import { deterministicToolCallForInput, deterministicToolCallForMissingInput, deterministicToolCallsForMissingInput } from "../src/agent/deterministic_tools.ts";
import { heuristicTurnIntent, type TurnIntent } from "../src/agent/intent.ts";
import { setIntentModel } from "../src/agent/intent_model.ts";
import { ENFORCEABLE_OUTCOMES } from "../src/agent/outcome_contract.ts";

beforeEach(() => setIntentModel(null));

// Deterministic execution serves the routing decision it is given (from the
// intent model, or the generic heuristic fallback used here); it never decides
// relevance from the wording itself.
function call(input: string) {
  const result = deterministicToolCallForInput(input, heuristicTurnIntent(input));
  return result ? { name: result.name, arguments: result.arguments } : null;
}

const intentWith = (expectedTools: string[]): TurnIntent => ({
  kind: "standalone_action",
  requiresAction: true,
  shouldTrackTasks: false,
  confidence: 0.85,
  restrictTools: false,
  expectedTools,
});

describe("deterministic tool execution", () => {
  test("routes live date questions to current_time", () => {
    expect(call("What is today's date and day of the week?")).toEqual({ name: "current_time", arguments: {} });
  });

  test("routes system questions to system_info", () => {
    expect(call("What operating system and shell am I running?")).toEqual({ name: "system_info", arguments: {} });
  });

  test("builds calc expressions for explicit arithmetic asks", () => {
    expect(call("What is 18% of 249.99?")).toEqual({ name: "calc", arguments: { expression: "0.18*249.99" } });
    expect(call("Convert 100 fahrenheit to celsius.")).toEqual({ name: "calc", arguments: { expression: "(100-32)*5/9" } });
  });

  test("leaves non-explicit math to the model instead of guessing", () => {
    // No literal expression to extract — the deterministic layer must decline.
    expect(deterministicToolCallForInput("How many seconds are in a week?", intentWith(["calc"]))).toBeNull();
  });

  test("routes city weather questions with a location argument", () => {
    expect(call("Will it rain in London tomorrow?")).toEqual({ name: "weather", arguments: { location: "London" } });
  });

  test("routes remaining expected tools after partial success", () => {
    const input = "Give me the current date/time, local weather, and calculate 17.5% of 2480.";
    const intent = intentWith(["current_time", "weather", "calc"]);
    const result = deterministicToolCallForMissingInput(input, intent, new Set(["current_time", "weather"]));
    expect(result ? { name: result.name, arguments: result.arguments } : null).toEqual({
      name: "calc",
      arguments: { expression: "0.175*2480" },
    });
  });

  test("routes exact simple file creation and schedule queries", () => {
    expect(deterministicToolCallForInput("Create a file called hello.txt containing the text 'Hello Sophie'.", intentWith(["write_file"]))).toMatchObject({ name: "write_file", arguments: { path: "hello.txt", content: "Hello Sophie" } });
    expect(deterministicToolCallForInput("What scheduled jobs or reminders do I currently have?", intentWith(["schedule_list"]))?.name).toBe("schedule_list");
  });

  test("fills intent-model-selected briefing sources in order", () => {
    const input = "Review today's calendar, unread email, and recent messages";
    const intent = intentWith(["email", "apple", "calendar_list"]);
    expect(deterministicToolCallForMissingInput(input, intent, new Set())?.name).toBe("email");
    expect(deterministicToolCallForMissingInput(input, intent, new Set(["email"]))?.name).toBe("apple");
    expect(deterministicToolCallForMissingInput(input, intent, new Set(["email", "apple"]))?.name).toBe("calendar_list");
    expect(deterministicToolCallsForMissingInput(input, intent, new Set()).map((c) => c.name)).toEqual(["email", "apple", "calendar_list"]);
  });

  test("reads saved drafts when the semantic contract requires draft status", () => {
    const intent: TurnIntent = {
      ...intentWith(["email"]),
      kind: "session_query",
      requiredOutcomes: [{
        prefix: "email:draft_list",
        minimum: 1,
        instruction: ENFORCEABLE_OUTCOMES["email:draft_list"]!,
      }],
    };
    expect(deterministicToolCallForInput("Review what we accomplished and which draft is ready.", intent)).toMatchObject({
      name: "email",
      arguments: { action: "draft_list" },
    });
  });

  test("preflights both inbox and draft operations when a review requires both", () => {
    const intent: TurnIntent = {
      ...intentWith(["email"]),
      kind: "session_query",
      requiredOutcomes: ["email:list_unread", "email:draft_list"].map((prefix) => ({
        prefix,
        minimum: 1,
        instruction: ENFORCEABLE_OUTCOMES[prefix]!,
      })),
    };
    expect(deterministicToolCallsForMissingInput("Review current opportunities and unsent drafts.", intent, new Set()).map((item) => item.arguments.action)).toEqual([
      "list_unread",
      "draft_list",
    ]);
  });

  test("a named weekday reads the week rather than only today", () => {
    expect(deterministicToolCallForInput("What is my Tuesday commitment?", intentWith(["calendar_list"]))?.arguments).toEqual({ range: "week" });
  });

  test("no expected tools means no deterministic call, whatever the wording", () => {
    const intent = intentWith([]);
    expect(deterministicToolCallForMissingInput("Review the payment update and the bank-change email now.", intent, new Set())).toBeNull();
  });
});
