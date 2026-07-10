import {
  addJournalEntry,
  getCurrentJob,
  getJournal,
  getObjective,
  getTasks,
  setObjective,
  setTasks,
  type ObjectiveStatus,
  type Task,
  type TaskStatus,
} from "../agent/tasks.ts";
import { hasVerifierEvidence, missingVerifierMessage, needsVerifierEvidence } from "../agent/verification.ts";
import type { Tool } from "./types.ts";

const STATUSES: TaskStatus[] = ["pending", "in_progress", "completed"];
const OBJECTIVE_STATUSES: ObjectiveStatus[] = ["active", "completed", "blocked"];

function normalize(raw: any, previous?: Task): Task | null {
  const content = typeof raw?.content === "string" ? raw.content.trim() : "";
  if (!content) return null;
  const status: TaskStatus = STATUSES.includes(raw?.status) ? raw.status : "pending";
  const note = typeof raw?.note === "string" && raw.note.trim() ? raw.note.trim() : undefined;
  const phase = typeof raw?.phase === "string" && raw.phase.trim() ? raw.phase.trim() : previous?.phase;
  const now = Date.now();
  const changed =
    !previous ||
    previous.content !== content ||
    previous.status !== status ||
    previous.note !== note ||
    previous.phase !== phase;
  const attempts =
    status === "in_progress" && previous?.status !== "in_progress"
      ? (previous?.attempts ?? 0) + 1
      : previous?.attempts;
  const completedAt =
    status === "completed"
      ? previous?.completedAt ?? now
      : undefined;
  return {
    content,
    status,
    ...(note ? { note } : {}),
    ...(phase ? { phase } : {}),
    updatedAt: changed ? now : previous?.updatedAt,
    ...(completedAt ? { completedAt } : {}),
    ...(attempts ? { attempts } : {}),
  };
}

export const updateTasks: Tool = {
  name: "update_tasks",
  description:
    "Create or update your task list for a multi-step job. Pass the COMPLETE " +
    "list every time (it replaces the previous one), with exactly one task " +
    "'in_progress'; mark it 'completed' the instant it's done and advance the " +
    "next. Put a step's key finding in its optional 'note' (notes survive " +
    "compaction). Before stopping a job, set objective_status 'completed' with " +
    "objective_evidence (how you verified) or 'blocked' with the exact blocker. " +
    "Pass an empty list only to intentionally clear the plan.",
  parameters: {
    type: "object",
    properties: {
      objective: {
        type: "string",
        description: "The user's final end goal; set/update when planning.",
      },
      objective_status: {
        type: "string",
        enum: ["active", "completed", "blocked"],
        description: "completed only after verification; blocked only with a concrete blocker.",
      },
      objective_evidence: {
        type: "string",
        description: "Proof of completion, or the concrete blocker.",
      },
      tasks: {
        type: "array",
        description: "The full, ordered task list.",
        items: {
          type: "object",
          properties: {
            content: { type: "string", description: "Short imperative step." },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "completed"],
            },
            note: {
              type: "string",
              description: "Optional short finding (survives compaction).",
            },
            phase: {
              type: "string",
              description: "Optional milestone this step belongs to in a build, e.g. 'Phase 1: Scaffold'.",
            },
          },
          required: ["content", "status"],
        },
      },
    },
    required: ["tasks"],
  },
  summarize: (a) => {
    const list = Array.isArray(a.tasks) ? a.tasks : [];
    const done = list.filter((t: any) => t?.status === "completed").length;
    return `${done}/${list.length} done`;
  },
  risk: () => "safe",
  async execute(args) {
    const objectiveText = typeof args.objective === "string" ? args.objective.trim() : "";
    const objectiveStatus: ObjectiveStatus = OBJECTIVE_STATUSES.includes(args.objective_status)
      ? args.objective_status
      : getObjective()?.status ?? "active";
    const objectiveEvidence =
      typeof args.objective_evidence === "string" && args.objective_evidence.trim()
        ? args.objective_evidence.trim()
        : getObjective()?.evidence;
    const incoming = Array.isArray(args.tasks) ? args.tasks : [];
    const prevByContent = new Map(getTasks().map((t) => [t.content, t]));
    const next = incoming
      .map((raw) => normalize(raw, prevByContent.get(typeof raw?.content === "string" ? raw.content.trim() : "")))
      .filter((t): t is Task => t !== null);

    if ((objectiveStatus === "completed" || objectiveStatus === "blocked") && !objectiveEvidence) {
      return {
        content:
          `Refusing to mark objective ${objectiveStatus} without objective_evidence. ` +
          "Provide concrete verification evidence or the exact blocker.",
        isError: true,
        display: "missing evidence",
      };
    }
    const candidateObjective =
      objectiveText || args.objective_status || args.objective_evidence
        ? {
            content: objectiveText || getObjective()?.content || "Complete the user's requested job.",
            status: objectiveStatus,
            ...(objectiveEvidence ? { evidence: objectiveEvidence } : {}),
          }
        : getObjective();
    if (
      objectiveStatus === "completed" &&
      needsVerifierEvidence(candidateObjective, next) &&
      !hasVerifierEvidence(getCurrentJob(), getJournal())
    ) {
      return {
        content:
          missingVerifierMessage(getJournal()) +
          " Run a verifier that passes before completion.",
        isError: true,
        display: "missing verifier",
      };
    }
    if (objectiveText || args.objective_status || args.objective_evidence) {
      setObjective({
        content: objectiveText || getObjective()?.content || "Complete the user's requested job.",
        status: objectiveStatus,
        ...(objectiveEvidence ? { evidence: objectiveEvidence } : {}),
      });
      if (objectiveStatus === "completed") {
        addJournalEntry({ kind: "verification", summary: "Final objective marked completed.", evidence: objectiveEvidence });
      } else if (objectiveStatus === "blocked") {
        addJournalEntry({ kind: "blocker", summary: "Final objective marked blocked.", evidence: objectiveEvidence, isError: true });
      }
    }

    setTasks(next);

    const tasks = getTasks();
    const objective = getObjective();
    if (!tasks.length) {
      return {
        content: objective
          ? `Task list cleared.\nFinal objective: ${objective.status} — ${objective.content}${objective.evidence ? `\nEvidence/blocker: ${objective.evidence}` : ""}`
          : "Task list cleared.",
        display: objective ? `objective ${objective.status}` : "cleared",
      };
    }

    const inProgress = tasks.filter((t) => t.status === "in_progress").length;
    const view = tasks
      .map((t, i) => `${i + 1}. [${t.status === "completed" ? "x" : t.status === "in_progress" ? "~" : " "}] ${t.content}`)
      .join("\n");
    const note =
      inProgress > 1
        ? "\n\nNote: keep only ONE task in_progress at a time."
        : inProgress === 0 && tasks.some((t) => t.status === "pending")
          ? "\n\nNote: set the next task to in_progress before working it."
          : "";
    const done = tasks.filter((t) => t.status === "completed").length;
    const objectiveView = objective
      ? `Final objective: ${objective.status} — ${objective.content}${objective.evidence ? `\nEvidence/blocker: ${objective.evidence}` : ""}\n\n`
      : "";
    return { content: `${objectiveView}Task list updated:\n${view}${note}`, display: `${done}/${tasks.length} done` };
  },
};
