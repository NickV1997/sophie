import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MEMORY_DIR } from "../memory/store.ts";
import { displayPath } from "../system/paths.ts";

export type AssistantTaskStatus = "open" | "in_progress" | "done" | "cancelled";
export type AssistantTaskPriority = "low" | "normal" | "high";

export interface AssistantTask {
  id: string;
  title: string;
  status: AssistantTaskStatus;
  priority: AssistantTaskPriority;
  createdAt: string;
  updatedAt: string;
  due?: string;
  notes?: string;
  tags?: string[];
  project?: string;
  completedAt?: string;
}

export const ASSISTANT_TASKS_PATH = join(MEMORY_DIR, "tasks.json");

const STATUSES: AssistantTaskStatus[] = ["open", "in_progress", "done", "cancelled"];
const PRIORITIES: AssistantTaskPriority[] = ["low", "normal", "high"];

function nowIso(): string {
  return new Date().toISOString();
}

function ensureDir(): void {
  if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true });
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tags = value
    .map((tag) => (typeof tag === "string" ? tag.trim().toLowerCase() : ""))
    .filter(Boolean);
  return tags.length ? [...new Set(tags)] : undefined;
}

function normalizeTask(raw: any): AssistantTask | null {
  const title = normalizeString(raw?.title);
  if (!title) return null;
  const updatedAt = normalizeString(raw?.updatedAt) ?? nowIso();
  const status: AssistantTaskStatus = STATUSES.includes(raw?.status) ? raw.status : "open";
  const priority: AssistantTaskPriority = PRIORITIES.includes(raw?.priority) ? raw.priority : "normal";
  return {
    id: normalizeString(raw?.id) ?? `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    title,
    status,
    priority,
    createdAt: normalizeString(raw?.createdAt) ?? updatedAt,
    updatedAt,
    ...(normalizeString(raw?.due) ? { due: normalizeString(raw.due) } : {}),
    ...(normalizeString(raw?.notes) ? { notes: normalizeString(raw.notes) } : {}),
    ...(normalizeTags(raw?.tags) ? { tags: normalizeTags(raw.tags) } : {}),
    ...(normalizeString(raw?.project) ? { project: normalizeString(raw.project) } : {}),
    ...(normalizeString(raw?.completedAt) ? { completedAt: normalizeString(raw.completedAt) } : {}),
  };
}

export function readAssistantTasks(): AssistantTask[] {
  if (!existsSync(ASSISTANT_TASKS_PATH)) return [];
  try {
    const parsed = JSON.parse(readFileSync(ASSISTANT_TASKS_PATH, "utf8"));
    const list: unknown[] = Array.isArray(parsed?.tasks) ? parsed.tasks : Array.isArray(parsed) ? parsed : [];
    return list.map(normalizeTask).filter((task): task is AssistantTask => task !== null);
  } catch {
    return [];
  }
}

export function writeAssistantTasks(tasks: AssistantTask[]): void {
  ensureDir();
  const sorted = [...tasks].sort((a, b) => {
    const statusRank = (task: AssistantTask) => (task.status === "in_progress" ? 0 : task.status === "open" ? 1 : 2);
    const priorityRank = (task: AssistantTask) => (task.priority === "high" ? 0 : task.priority === "normal" ? 1 : 2);
    return (
      statusRank(a) - statusRank(b) ||
      priorityRank(a) - priorityRank(b) ||
      a.updatedAt.localeCompare(b.updatedAt)
    );
  });
  writeFileSync(ASSISTANT_TASKS_PATH, `${JSON.stringify({ tasks: sorted }, null, 2)}\n`);
}

export function addAssistantTask(input: {
  title: string;
  priority?: AssistantTaskPriority;
  due?: string;
  notes?: string;
  tags?: string[];
  project?: string;
}): AssistantTask {
  const timestamp = nowIso();
  const task: AssistantTask = {
    id: `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    title: input.title.trim(),
    status: "open",
    priority: input.priority ?? "normal",
    createdAt: timestamp,
    updatedAt: timestamp,
    ...(input.due ? { due: input.due.trim() } : {}),
    ...(input.notes ? { notes: input.notes.trim() } : {}),
    ...(input.tags?.length ? { tags: [...new Set(input.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))] } : {}),
    ...(input.project ? { project: input.project.trim() } : {}),
  };
  writeAssistantTasks([...readAssistantTasks(), task]);
  return task;
}

export function updateAssistantTask(id: string, patch: Partial<Omit<AssistantTask, "id" | "createdAt">>): AssistantTask | null {
  const tasks = readAssistantTasks();
  const idx = tasks.findIndex((task) => task.id === id);
  if (idx === -1) return null;
  const previous = tasks[idx];
  const timestamp = nowIso();
  const status = patch.status ?? previous.status;
  const completedAt =
    status === "done" ? previous.completedAt ?? timestamp :
    status === "cancelled" ? previous.completedAt :
    undefined;
  const next: AssistantTask = {
    ...previous,
    ...patch,
    title: patch.title?.trim() || previous.title,
    updatedAt: timestamp,
    ...(completedAt ? { completedAt } : {}),
  };
  if (!patch.due && patch.due !== undefined) delete next.due;
  if (!patch.notes && patch.notes !== undefined) delete next.notes;
  if (!patch.tags?.length && patch.tags !== undefined) delete next.tags;
  if (!patch.project && patch.project !== undefined) delete next.project;
  if (status !== "done") delete next.completedAt;
  tasks[idx] = next;
  writeAssistantTasks(tasks);
  return next;
}

export function deleteAssistantTask(id: string): boolean {
  const tasks = readAssistantTasks();
  const next = tasks.filter((task) => task.id !== id);
  if (next.length === tasks.length) return false;
  writeAssistantTasks(next);
  return true;
}

export function searchAssistantTasks(args: {
  status?: AssistantTaskStatus | "all";
  query?: string;
  tag?: string;
  project?: string;
  includeDone?: boolean;
  limit?: number;
} = {}): AssistantTask[] {
  const query = args.query?.trim().toLowerCase();
  const tag = args.tag?.trim().toLowerCase();
  const project = args.project?.trim().toLowerCase();
  const limit = Math.min(Math.max(args.limit ?? 20, 1), 100);
  return readAssistantTasks()
    .filter((task) => {
      if (args.status && args.status !== "all" && task.status !== args.status) return false;
      if (!args.status && !args.includeDone && (task.status === "done" || task.status === "cancelled")) return false;
      if (tag && !task.tags?.includes(tag)) return false;
      if (project && task.project?.toLowerCase() !== project) return false;
      if (query) {
        const haystack = [task.id, task.title, task.notes, task.due, task.project, ...(task.tags ?? [])]
          .filter(Boolean)
          .join("\n")
          .toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    })
    .slice(0, limit);
}

export function assistantTasksForPrompt(cwd: string): string {
  const tasks = searchAssistantTasks({ includeDone: false, limit: 15 });
  if (!tasks.length) return "";
  const currentProject = displayPath(cwd);
  const lines = tasks.map((task) => {
    const due = task.due ? ` due=${task.due}` : "";
    const tags = task.tags?.length ? ` tags=${task.tags.join(",")}` : "";
    const project = task.project ? ` project=${task.project}` : "";
    const note = task.notes ? ` — ${task.notes.replace(/\s+/g, " ").slice(0, 160)}` : "";
    return `- ${task.id} [${task.status}/${task.priority}] ${task.title}${due}${project}${tags}${note}`;
  });
  return [
    "# Long-term assistant tasks",
    `Persistent tasks from ${displayPath(ASSISTANT_TASKS_PATH)}. These are not the live execution checklist; use manage_tasks to add, update, finish, cancel, or search them. Current project: ${currentProject}.`,
    ...lines,
  ].join("\n");
}
