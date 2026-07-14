import { describe, expect, test } from "bun:test";
import { GENERALIZATION_TEMPLATE_IDS, generateGeneralizationScenarios } from "../src/bench/gen_scenarios.ts";
import { getTool } from "../src/tools/registry.ts";

const gen = generateGeneralizationScenarios;

describe("generalization corpus generation", () => {
  test("same seed generates the identical corpus (reproducible runs)", () => {
    expect(JSON.stringify(gen(7))).toBe(JSON.stringify(gen(7)));
    expect(JSON.stringify(gen(123456))).toBe(JSON.stringify(gen(123456)));
  });

  test("different seeds change both wording and expected values", () => {
    const a = gen(1); const b = gen(2);
    const prompts = (s: ReturnType<typeof gen>) => s.flatMap((x) => x.turns.map((t) => t.prompt));
    const differing = prompts(a).filter((p, i) => p !== prompts(b)[i]).length;
    expect(differing).toBeGreaterThanOrEqual(Math.floor(prompts(a).length * 0.7));
    const answers = (s: ReturnType<typeof gen>) => s.flatMap((x) => x.turns.flatMap((t) => t.checks.filter((c) => c.kind === "answer" || c.kind === "memory").map((c) => c.value)));
    expect(answers(a)).not.toEqual(answers(b));
  });

  test("every template is generated exactly once with unique ids", () => {
    const ids = gen(3).map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual([...GENERALIZATION_TEMPLATE_IDS].sort());
  });

  test("phrasings vary across seeds within one template", () => {
    const prompts = new Set(
      [1, 2, 3, 4, 5, 6, 7, 8].map((seed) => gen(seed).find((s) => s.id === "reminder-exact")!.turns[0]!.prompt),
    );
    expect(prompts.size).toBeGreaterThanOrEqual(3);
  });

  test("derived answer checks are grounded in the generated world or prompt", () => {
    for (const seed of [5, 91, 4402]) {
      for (const scenario of gen(seed)) {
        const worldText = JSON.stringify(scenario.seed) + scenario.turns.map((t) => t.prompt).join(" ");
        for (const turn of scenario.turns) {
          for (const check of turn.checks.filter((c) => (c.kind === "answer" || c.kind === "memory") && /\d/.test(c.value))) {
            // Numeric expectations (times, amounts, codes) must appear in the
            // world/prompt — they are read or computed, never canned. Sums are
            // computed from world amounts, so verify those arithmetically.
            const alternatives = check.value.split("|");
            if (scenario.id === "sum-grounding") {
              const amounts = [...worldText.matchAll(/\$(\d+\.\d{2})/g)].map((m) => Number(m[1]));
              const total = (Math.round(amounts[0]! * 100) + Math.round(amounts[1]! * 100)) / 100;
              expect(check.value).toBe(total.toFixed(2));
            } else {
              expect(
                alternatives.some((alt) => worldText.includes(alt)),
                `${scenario.id}/${turn.id} expects "${check.value}" but the generated world never contains it`,
              ).toBe(true);
            }
          }
        }
      }
    }
  });

  test("trap template forbids every baited mutation while demanding the real answer", () => {
    const trap = gen(11).find((s) => s.id === "read-only-trap")!;
    const banned = trap.turns[0]!.checks.filter((c) => c.kind === "no_tool").map((c) => c.value);
    expect(banned).toEqual(expect.arrayContaining(["schedule:add", "manage_tasks:add", "calendar:add"]));
    expect(trap.turns[0]!.checks.some((c) => c.kind === "answer" && /\d/.test(c.value))).toBe(true);
  });

  test("every tool/no_tool check references a registered tool", () => {
    for (const scenario of gen(17)) {
      for (const turn of scenario.turns) {
        for (const check of turn.checks.filter((c) => c.kind === "tool" || c.kind === "no_tool")) {
          const name = check.value.split(/[:|=]/)[0]!;
          expect(getTool(name), `${scenario.id} references unregistered tool ${name}`).toBeTruthy();
        }
      }
    }
  });

  test("every scenario keeps at least one critical (safety or world-state) check", () => {
    for (const scenario of gen(29)) {
      const checks = scenario.turns.flatMap((t) => t.checks);
      expect(checks.some((c) => c.critical), `${scenario.id} has no critical check`).toBe(true);
    }
  });

  test("appointment weekday names match the actual generated event dates", () => {
    for (const seed of [2, 33, 777]) {
      const trap = gen(seed).find((s) => s.id === "read-only-trap")!;
      const event = trap.seed.events[0]!;
      const weekday = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][new Date(event.start.slice(0, 10) + "T12:00:00Z").getUTCDay()]!;
      const mentionsWeekday = /Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday/.exec(trap.turns[0]!.prompt);
      if (mentionsWeekday) expect(mentionsWeekday[0]).toBe(weekday);
    }
  });
});
