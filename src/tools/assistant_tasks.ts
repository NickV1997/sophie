import {
  assistantTasksPath,
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

function dueWeekdayConflict(due: string | undefined, context: string): string | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(due ?? "");
  if (!iso) return null;
  const names = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const mentioned = [...context.toLowerCase().matchAll(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/g)].map((m) => m[1]!);
  if (!mentioned.length) return null;
  const actual = names[new Date(`${iso[1]}-${iso[2]}-${iso[3]}T12:00:00Z`).getUTCDay()]!;
  return mentioned.includes(actual) ? null : `Due date ${due} is ${actual}, but the task text says ${[...new Set(mentioned)].join("/")}.`;
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
      tasks: {
        type: "array",
        description: "For action:add, validate and create several tasks in one call. Prefer this over repeating manage_tasks calls.",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            priority: { type: "string", enum: ["low", "normal", "high"] },
            due: {
              type: "string",
              description: "Optional due date/time. Copy the source wording exactly; natural weekdays such as 'Friday' are valid. Never convert a relative weekday to an invented ISO date.",
            },
            notes: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
            project: { type: "string" },
          },
          required: ["title"],
        },
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
        description: "Optional due date/time. Copy the source wording exactly; natural weekdays such as 'Friday' are valid. Use ISO only when the source supplied or a clock tool verified that date.",
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
  risk: (args) => ["delete", "clear_completed"].includes(String(args.action)) ? "caution" : "safe",
  async execute(args) {
    const action = String(args.action ?? "list");

    if (action === "add") {
      const batch = Array.isArray(args.tasks) && args.tasks.length
        ? args.tasks.slice(0, 20).map((item) => item as Record<string, unknown>)
        : [args as Record<string, unknown>];
      const prepared = batch.map((item) => ({
        title: text(item.title),
        priority: priority(item.priority),
        due: text(item.due),
        notes: text(item.notes),
        tags: tags(item.tags),
        project: text(item.project),
      }));
      if (prepared.some((item) => !item.title)) return { content: "Every task needs a title; no tasks were added.", isError: true, display: "missing title" };
      const conflict = prepared.map((item) => dueWeekdayConflict(item.due, `${item.title ?? ""} ${item.notes ?? ""}`)).find(Boolean);
      if (conflict) return { content: `${conflict} No tasks were added; preserve the source's date/weekday or verify it first.`, isError: true, display: "date conflict" };
      const added = prepared.map((item) => addAssistantTask({ ...item, title: item.title! }));
      return {
        content: `Added ${added.length} long-term task${added.length === 1 ? "" : "s"} in ${displayPath(assistantTasksPath())}:\n${added.map(renderTask).join("\n")}`,
        display: `added ${added.length} task${added.length === 1 ? "" : "s"}`,
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
        ? `Long-term tasks (${displayPath(assistantTasksPath())}):\n${list.map(renderTask).join("\n")}`
        : `No matching long-term tasks in ${displayPath(assistantTasksPath())}.`,
      display: `${list.length} task${list.length === 1 ? "" : "s"}`,
    };
  },
};
