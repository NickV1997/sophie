import { afterEach, describe, expect, test } from "bun:test";
import {
  addJournalEntry,
  beginObjective,
  clearTasks,
  getCurrentJob,
  getJournal,
  getObjective,
  getTasks,
  setObjective,
  setTasks,
  tasksForPrompt,
} from "../src/agent/tasks.ts";

afterEach(() => clearTasks());

describe("task jobs", () => {
  test("beginObjective creates an active job and tags objective/tasks/journal", () => {
    beginObjective("Build a tiny app");
    setTasks([{ content: "Inspect project", status: "in_progress" }]);
    addJournalEntry({ kind: "tool_call", tool: "list_dir", summary: "listed files" });

    const job = getCurrentJob();
    expect(job?.status).toBe("active");
    expect(job?.phase).toBe("gather");
    expect(getObjective()?.jobId).toBe(job?.id);
    expect(getTasks()[0]?.jobId).toBe(job?.id);
    expect(getJournal()[0]?.jobId).toBe(job?.id);
    expect(tasksForPrompt()).toContain(job!.id);
  });

  test("objective completion updates the active job status", () => {
    beginObjective("Verify app");
    setObjective({ content: "Verify app", status: "completed", evidence: "typecheck passed" });
    expect(getCurrentJob()?.status).toBe("completed");
    expect(getCurrentJob()?.phase).toBe("completed");
    expect(getObjective()?.status).toBe("completed");
  });

  test("clearTasks clears active job state", () => {
    beginObjective("Old work");
    setTasks([{ content: "Do old work", status: "pending" }]);
    clearTasks();
    expect(getCurrentJob()).toBeNull();
    expect(getObjective()).toBeNull();
    expect(getTasks()).toEqual([]);
  });
});
