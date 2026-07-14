import { beforeEach, describe, expect, test } from "bun:test";
import {
  ENFORCEABLE_OUTCOMES,
  missingOutcomes,
  recordDeniedOutcome,
  recordSuccessfulOutcome,
  type OutcomeRequirement,
} from "../src/agent/outcome_contract.ts";
import { applyResponseConstraints, responseConstraintsForInput } from "../src/agent/response_constraints.ts";
import { deterministicToolCallsForMissingInput } from "../src/agent/deterministic_tools.ts";
import type { TurnIntent } from "../src/agent/intent.ts";
import { setIntentModel } from "../src/agent/intent_model.ts";

beforeEach(() => setIntentModel(null));

const parsed = (name: string, args: Record<string, unknown>) => ({ name, arguments: args, raw: "" });
const req = (prefix: string, minimum = 1): OutcomeRequirement => ({ prefix, minimum, instruction: ENFORCEABLE_OUTCOMES[prefix]! });

describe("personal-assistant outcome contracts", () => {
  test("requires a saved email draft, not inline prose", () => {
    const requirements = [req("email:draft_create")];
    const successes = new Set<string>();
    expect(missingOutcomes(requirements, successes)).toHaveLength(1);
    recordSuccessfulOutcome(successes, parsed("email", { action: "draft_create", to: ["pat@example.com"] }));
    expect(missingOutcomes(requirements, successes)).toEqual([]);
  });

  test("counts every requested project/contact/task outcome", () => {
    const requirements = [req("projects:add", 2), req("people:upsert", 2), req("manage_tasks:add", 2)];
    const successes = new Set<string>();
    for (const name of ["Northstar", "Maple"]) recordSuccessfulOutcome(successes, parsed("projects", { action: "add", name }));
    for (const name of ["Dana", "Luis"]) recordSuccessfulOutcome(successes, parsed("people", { action: "upsert", name }));
    expect(missingOutcomes(requirements, successes)).toHaveLength(1); // tasks still missing
    for (const title of ["launch", "monthly report"]) recordSuccessfulOutcome(successes, parsed("manage_tasks", { action: "add", title }));
    expect(missingOutcomes(requirements, successes)).toEqual([]);
  });

  test("counts every item in validated batch calls", () => {
    const requirements = [req("projects:add", 2), req("people:upsert", 2), req("manage_tasks:add", 2)];
    const successes = new Set<string>();
    recordSuccessfulOutcome(successes, parsed("projects", { action: "add", projects: [{ name: "Northstar" }, { name: "Maple" }] }));
    recordSuccessfulOutcome(successes, parsed("people", { action: "upsert", people: [{ name: "Dana" }, { name: "Luis" }] }));
    recordSuccessfulOutcome(successes, parsed("manage_tasks", { action: "add", tasks: [{ title: "launch" }, { title: "monthly report" }] }));
    expect(missingOutcomes(requirements, successes)).toEqual([]);
    expect(successes).toContain("projects:add:northstar");
    expect(successes).toContain("people:upsert:luis");
  });

  test("one successful call is never double-counted toward a multi-record contract", () => {
    const requirements = [req("projects:add", 2)];
    const successes = new Set<string>();
    recordSuccessfulOutcome(successes, parsed("projects", { action: "add", name: "Northstar" }));
    expect(missingOutcomes(requirements, successes)).toHaveLength(1);
  });

  test("a denied consequential action closes its contract truthfully", () => {
    const requirements = [req("calendar:update")];
    const successes = new Set<string>();
    recordDeniedOutcome(successes, parsed("calendar", { action: "update", title: "protected block" }));
    expect(missingOutcomes(requirements, successes)).toEqual([]);
  });

  test("routes all intent-model-selected briefing reads in one preflight batch", () => {
    const intent: TurnIntent = {
      kind: "standalone_action",
      requiresAction: true,
      shouldTrackTasks: false,
      confidence: 0.85,
      restrictTools: false,
      expectedTools: ["weather", "email", "apple", "calendar_list"],
    };
    const calls = deterministicToolCallsForMissingInput("Review today's calendar, unread email, recent messages, and weather.", intent, new Set());
    expect(calls.map((c) => c.name)).toEqual(["weather", "email", "apple", "calendar_list"]);
  });
});

describe("personal-assistant response constraints", () => {
  test("enforces an explicit three-step limit without inventing word caps", () => {
    const input = "Tell me exactly what to do in three short steps.";
    expect(responseConstraintsForInput(input)).toEqual({ maxBullets: 3 });
    const verbose = Array.from({ length: 8 }, (_, i) => `${i + 1}. Step ${i + 1} says do not share your password with anyone.`).join("\n");
    const out = applyResponseConstraints(verbose, input);
    expect((out.match(/^\s*\d+[.)]\s+/gm) ?? []).length).toBe(3);
  });

  test("honors explicit word, line, and sentence counts", () => {
    expect(responseConstraintsForInput("Summarize in no more than 40 words.")).toEqual({ maxWords: 40 });
    const out = applyResponseConstraints(Array.from({ length: 12 }, (_, i) => `Line ${i + 1}`).join("\n"), "I only need a five-line summary.");
    expect(out.split("\n")).toHaveLength(5);
  });

  test("vague brevity words are style, not a hidden truncation contract", () => {
    expect(responseConstraintsForInput("keep it brief and use plain language")).toEqual({});
    const text = "First sentence. Second sentence. Third sentence.";
    expect(applyResponseConstraints(text, "keep it brief")).toBe(text);
  });

  test("does not cut a decimal amount at the period", () => {
    expect(applyResponseConstraints("$317.80 remains after both bills. Extra sentence.", "Answer in one sentence.")).toBe("$317.80 remains after both bills.");
  });
});
