import { AsyncLocalStorage } from "node:async_hooks";
import { config, type Mode } from "../config.ts";
import type { AgentJob, JournalEntry, Objective, Task } from "./tasks.ts";

export interface AgentRuntimeState {
  mode: Mode;
  tasks: Task[];
  objective: Objective | null;
  journal: JournalEntry[];
  currentJob: AgentJob | null;
  taskListeners: Set<(t: Task[]) => void>;
  modeListeners: Set<(m: Mode) => void>;
}

export function createAgentRuntime(): AgentRuntimeState {
  return {
    mode: config.defaultMode,
    tasks: [],
    objective: null,
    journal: [],
    currentJob: null,
    taskListeners: new Set(),
    modeListeners: new Set(),
  };
}

const defaultRuntime = createAgentRuntime();
const storage = new AsyncLocalStorage<AgentRuntimeState>();

export function getDefaultRuntime(): AgentRuntimeState {
  return defaultRuntime;
}

export function activeRuntime(): AgentRuntimeState {
  return storage.getStore() ?? defaultRuntime;
}

export function runWithRuntime<T>(runtime: AgentRuntimeState, fn: () => T): T {
  return storage.run(runtime, fn);
}
