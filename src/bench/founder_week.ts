export type FounderWeekKind = "capture" | "plan" | "remind" | "recover" | "communicate" | "protect" | "review";
export interface FounderWeekScenario { day: string; kind: FounderWeekKind; requirement: string; pass: boolean; evidence: string; }
export interface FounderWeekReport { scenarios: FounderWeekScenario[]; passed: number; total: number; passRate: number; }

export function evaluateFounderWeek(input: {
  taskCaptured: boolean; projectLinked: boolean; calendarReconciled: boolean; reminderScheduled: boolean;
  missedWorkRecovered: boolean; draftRequiresApproval: boolean; sensitiveEgressBlocked: boolean; activityReviewAvailable: boolean;
}): FounderWeekReport {
  const scenarios: FounderWeekScenario[] = [
    { day: "Monday", kind: "capture", requirement: "Capture a commitment and connect it to its project", pass: input.taskCaptured && input.projectLinked, evidence: "task + belongs_to_project entity link" },
    { day: "Tuesday", kind: "plan", requirement: "Reconcile Apple/built-in calendar before planning", pass: input.calendarReconciled, evidence: "calendar pull reconciliation" },
    { day: "Wednesday", kind: "remind", requirement: "Persist the next reminder across restarts", pass: input.reminderScheduled, evidence: "durable schedule record" },
    { day: "Thursday", kind: "recover", requirement: "Recover expired work without double execution", pass: input.missedWorkRecovered, evidence: "lease recovery + idempotency" },
    { day: "Friday", kind: "communicate", requirement: "Draft external communication until explicitly authorized", pass: input.draftRequiresApproval, evidence: "approval-gated delegation" },
    { day: "Saturday", kind: "protect", requirement: "Block sensitive data crossing an outward boundary", pass: input.sensitiveEgressBlocked, evidence: "capability/data-flow policy" },
    { day: "Sunday", kind: "review", requirement: "Explain what Sophie did during the week", pass: input.activityReviewAvailable, evidence: "unified activity log" },
  ];
  const passed = scenarios.filter((item) => item.pass).length;
  return { scenarios, passed, total: scenarios.length, passRate: passed / scenarios.length };
}
