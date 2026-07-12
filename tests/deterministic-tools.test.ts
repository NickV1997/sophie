import { describe, expect, test } from "bun:test";
import { deterministicToolCallForInput, deterministicToolCallForMissingInput } from "../src/agent/deterministic_tools.ts";
import { classifyTurnIntent } from "../src/agent/intent.ts";

const noState = { objective: null, tasks: [] };

function call(input: string) {
  const result = deterministicToolCallForInput(input, classifyTurnIntent(input, noState));
  return result ? { name: result.name, arguments: result.arguments } : null;
}

describe("deterministic tool routing", () => {
  test("routes live date questions to current_time", () => {
    expect(call("What is today's date and day of the week?")).toEqual({ name: "current_time", arguments: {} });
  });

  test("routes system questions to system_info", () => {
    expect(call("What operating system and shell am I running?")).toEqual({ name: "system_info", arguments: {} });
  });

  test("builds calc expressions for common arithmetic asks", () => {
    expect(call("What is 18% of 249.99?")).toEqual({ name: "calc", arguments: { expression: "0.18*249.99" } });
    expect(call("Convert 100 fahrenheit to celsius.")).toEqual({ name: "calc", arguments: { expression: "(100-32)*5/9" } });
    expect(call("How many seconds are in a week?")).toEqual({ name: "calc", arguments: { expression: "7*24*60*60" } });
  });

  test("routes city weather questions with a location argument", () => {
    expect(call("Will it rain in London tomorrow?")).toEqual({ name: "weather", arguments: { location: "London" } });
  });

  test("routes remaining deterministic tools after partial success", () => {
    const input = "Give me the current date/time, local weather, and calculate 17.5% of 2480.";
    const intent = classifyTurnIntent(input, noState);
    const result = deterministicToolCallForMissingInput(input, intent, new Set(["current_time", "weather"]));
    expect(result ? { name: result.name, arguments: result.arguments } : null).toEqual({
      name: "calc",
      arguments: { expression: "0.175*2480" },
    });
  });

  test("routes exact simple file creation and schedule queries", () => {
    const fileIntent: any = { expectedTools: ["write_file"] };
    expect(deterministicToolCallForInput("Create a file called hello.txt containing the text 'Hello Sophie'.", fileIntent)).toMatchObject({ name: "write_file", arguments: { path: "hello.txt", content: "Hello Sophie" } });
    const scheduleIntent: any = { expectedTools: ["schedule_list"] };
    expect(deterministicToolCallForInput("What scheduled jobs or reminders do I currently have?", scheduleIntent)?.name).toBe("schedule_list");
  });

  test("fills missing real-world briefing sources deterministically", () => {
    const input = "Review today's calendar, unread email, and recent messages";
    const intent = classifyTurnIntent(input, noState);
    expect(deterministicToolCallForMissingInput(input, intent, new Set())?.name).toBe("email");
    expect(deterministicToolCallForMissingInput(input, intent, new Set(["email"]))?.name).toBe("apple");
    expect(deterministicToolCallForMissingInput(input, intent, new Set(["email", "apple"]))?.name).toBe("calendar_list");
  });

  test("does not turn draft requests into inbox reads", () => {
    const input = "Draft an email to Dana but do not send it";
    const intent = classifyTurnIntent(input, noState);
    expect(deterministicToolCallForMissingInput(input, intent, new Set())).toBeNull();
  });
});
