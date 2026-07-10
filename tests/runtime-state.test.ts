import { describe, expect, test } from "bun:test";
import { getMode, setMode } from "../src/agent/mode.ts";
import { createAgentRuntime, runWithRuntime } from "../src/agent/runtime.ts";
import { beginObjective, clearTasks, getObjective, getTasks, setTasks } from "../src/agent/tasks.ts";

describe("agent runtime state", () => {
  test("mode and task state can be isolated per runtime", () => {
    const a = createAgentRuntime();
    const b = createAgentRuntime();

    runWithRuntime(a, () => {
      setMode("build");
      beginObjective("Build A");
      setTasks([{ content: "A task", status: "in_progress" }]);
    });

    runWithRuntime(b, () => {
      setMode("plan");
      beginObjective("Plan B");
      setTasks([{ content: "B task", status: "pending" }]);
    });

    runWithRuntime(a, () => {
      expect(getMode()).toBe("build");
      expect(getObjective()?.content).toBe("Build A");
      expect(getTasks()[0]?.content).toBe("A task");
      clearTasks();
    });

    runWithRuntime(b, () => {
      expect(getMode()).toBe("plan");
      expect(getObjective()?.content).toBe("Plan B");
      expect(getTasks()[0]?.content).toBe("B task");
      clearTasks();
    });
  });
});

