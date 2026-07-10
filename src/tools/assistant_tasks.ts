import {
  ASSISTANT_TASKS_PATH,
  addAssistantTask,
  deleteAssistantTask,
  searchAssistantTasks,
  updateAssistantTask,
  type AssistantTask,
  type AssistantTaskPriority,
  type AssistantTaskStatus,
} from "../assistant_tasks/store.ts";
import { displayPath } from "../system/paths.ts";
import type { Tool } from "./types.ts";

const STATUSES: AssistantTaskStatus[] = ["open", "in_progress", "done", "cancelled"];
const PRIORITIES: AssistantTaskPriority[] = ["low", "normal", "high"];

function status(value: unknown): AssistantTaskStatus | undefined {
  return STATUSES.includes(value as AssistantTaskStatus) ? (value as AssistantTaskStatus) : undefined;
}

function priority(value: unknown): AssistantTaskPriority | undefined {
  return PRIORITIES.includes(value as AssistantTaskPriority) ? (value as AssistantTaskPriority) : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function tags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.map((v) => (typeof v === "string" ? v.trim().toLowerCase() : "")).filter(Boolean);
  return out.length ? [...new Set(out)] : undefined;
}

function renderTask(task: AssistantTask): string {
  const due = task.due ? ` due=${task.due}` : "";
  const tagList = task.tags?.length ? ` tags=${task.tags.join(",")}` : "";
  const project = task.project ? ` project=${task.project}` : "";
  const note = task.notes ? `\n  note: ${task.notes}` : "";
  return `- ${task.id} [${task.status}/${task.priority}] ${task.title}${due}${project}${tagList}${note}`;
}

export const manageTasks: Tool = {
  name: "manage_tasks",
  description:
    "Manage Sophie's long-term assistant task list across sessions. Use this for " +
    "durable personal-assistant tasks, reminders, follow-ups, ideas, and things " +
    "Sophie should remember to do later. This is separate from update_tasks, " +
    "which is only the live checklist for the current multi-step job.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["add", "list", "update", "delete", "clear_completed"],
        description: "Operation to perform.",
      },
      id: {
        type: "string",
        description: "Task id for update/delete.",
      },
      title: {
        type: "string",
        description: "Task title for add/update.",
      },
      status: {
        type: "string",
        enum: ["open", "in_progress", "done", "cancelled", "all"],
        description: "Task status. For list, omit to show open/in_progress only.",
      },
      priority: {
        type: "string",
        enum: ["low", "normal", "high"],
        description: "Task priority.",
      },
      due: {
        type: "string",
        description: "Optional due date/time as a clear string, preferably ISO date like 2026-07-10.",
      },
      notes: {
        type: "string",
        description: "Short context Sophie will need later.",
      },
      tags: {
        type: "array",
        description: "Optional lowercase labels like calendar, telegram, crypto, sophie.",
        items: { type: "string" },
      },
      project: {
        type: "string",
        description: "Optional project/path/context this task belongs to.",
      },
      query: {
        type: "string",
        description: "Search text for list.",
      },
      tag: {
        type: "string",
        description: "Filter list by tag.",
      },
      limit: {
        type: "number",
        description: "Maximum list results. Default 20, max 100.",
      },
    },
    required: ["action"],
  },
  summarize: (args) => {
    const action = String(args.action ?? "list");
    if (action === "add") return `add "${String(args.title ?? "").slice(0, 48)}"`;
    if (action === "update") return `update ${args.id ?? ""}`;
    if (action === "delete") return `delete ${args.id ?? ""}`;
    return action;
  },
  risk: () => "safe",
  async execute(args) {
    const action = String(args.action ?? "list");

    if (action === "add") {
      const title = text(args.title);
      if (!title) return { content: "Cannot add a task without a title.", isError: true, display: "missing title" };
      const task = addAssistantTask({
        title,
        priority: priority(args.priority),
        due: text(args.due),
        notes: text(args.notes),
        tags: tags(args.tags),
        project: text(args.project),
      });
      return {
        content: `Added long-term task in ${displayPath(ASSISTANT_TASKS_PATH)}:\n${renderTask(task)}`,
        display: `added ${task.id}`,
      };
    }

    if (action === "update") {
      const id = text(args.id);
      if (!id) return { content: "Cannot update a task without an id.", isError: true, display: "missing id" };
      const patch: Partial<Omit<AssistantTask, "id" | "createdAt">> = {};
      const nextStatus = status(args.status);
      const nextPriority = priority(args.priority);
      const title = text(args.title);
      if (title) patch.title = title;
      if (nextStatus) patch.status = nextStatus;
      if (nextPriority) patch.priority = nextPriority;
      if ("due" in args) patch.due = text(args.due);
      if ("notes" in args) patch.notes = text(args.notes);
      if ("tags" in args) patch.tags = tags(args.tags);
      if ("project" in args) patch.project = text(args.project);
      const task = updateAssistantTask(id, patch);
      if (!task) return { content: `No long-term task found with id ${id}.`, isError: true, display: "not found" };
      return { content: `Updated long-term task:\n${renderTask(task)}`, display: `${task.status} ${task.id}` };
    }

    if (action === "delete") {
      const id = text(args.id);
      if (!id) return { content: "Cannot delete a task without an id.", isError: true, display: "missing id" };
      const ok = deleteAssistantTask(id);
      if (!ok) return { content: `No long-term task found with id ${id}.`, isError: true, display: "not found" };
      return { content: `Deleted long-term task ${id}.`, display: `deleted ${id}` };
    }

    if (action === "clear_completed") {
      const done = searchAssistantTasks({ status: "done", includeDone: true, limit: 100 });
      for (const task of done) deleteAssistantTask(task.id);
      return { content: `Deleted ${done.length} completed long-term task(s).`, display: `${done.length} cleared` };
    }

    if (action !== "list") {
      return { content: `Unknown manage_tasks action "${action}".`, isError: true, display: "bad action" };
    }

    const requestedStatus = args.status === "all" ? "all" : status(args.status);
    const list = searchAssistantTasks({
      status: requestedStatus,
      query: text(args.query),
      tag: text(args.tag),
      project: text(args.project),
      includeDone: requestedStatus === "all",
      limit: Math.min(Math.max(Number(args.limit ?? 20) || 20, 1), 100),
    });
    return {
      content: list.length
        ? `Long-term tasks (${displayPath(ASSISTANT_TASKS_PATH)}):\n${list.map(renderTask).join("\n")}`
        : `No matching long-term tasks in ${displayPath(ASSISTANT_TASKS_PATH)}.`,
      display: `${list.length} task${list.length === 1 ? "" : "s"}`,
    };
  },
};
