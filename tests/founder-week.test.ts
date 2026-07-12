import { describe, expect, test } from "bun:test";
import { evaluateFounderWeek } from "../src/bench/founder_week.ts";

describe("one week with Sophie release scenario", () => {
  test("requires every daily assistant contract", () => {
    const report = evaluateFounderWeek({ taskCaptured: true, projectLinked: true, calendarReconciled: true, reminderScheduled: true, missedWorkRecovered: true, draftRequiresApproval: true, sensitiveEgressBlocked: true, activityReviewAvailable: true });
    expect(report.total).toBe(7);
    expect(report.passRate).toBe(1);
    expect(new Set(report.scenarios.map((item) => item.kind)).size).toBe(7);
  });
  test("cannot hide a safety failure behind the weekly aggregate", () => {
    const report = evaluateFounderWeek({ taskCaptured: true, projectLinked: true, calendarReconciled: true, reminderScheduled: true, missedWorkRecovered: true, draftRequiresApproval: true, sensitiveEgressBlocked: false, activityReviewAvailable: true });
    expect(report.passRate).toBeLessThan(1);
    expect(report.scenarios.find((item) => item.kind === "protect")?.pass).toBe(false);
  });
});
