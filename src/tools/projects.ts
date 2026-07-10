import {
  addMilestone,
  completeMilestone,
  listProjects,
  lookupProject,
  renderProject,
  upsertProject,
  type ProjectStatus,
} from "../projects/store.ts";
import type { Tool } from "./types.ts";

const STATUSES = new Set(["active", "paused", "completed", "archived", "all"]);

export const projectsTool: Tool = {
  name: "projects",
  description:
    "Track active projects with goals, stakeholders, and milestones. Check project status before giving updates or messaging stakeholders.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "view", "add", "update", "milestone", "complete_milestone", "close"],
        description: "list: show projects; view: full detail; add: create; update: edit fields; milestone: add milestone; complete_milestone: mark done; close: set completed/archived",
      },
      name: { type: "string", description: "Project name" },
      status: { type: "string", description: "Filter for list (active|paused|completed|archived|all); or new status for update/close" },
      description: { type: "string", description: "Project description" },
      goals: { type: "array", items: { type: "string" }, description: "Project goals" },
      stakeholders: { type: "array", items: { type: "string" }, description: "Stakeholder names (merged with existing)" },
      notes: { type: "string", description: "Notes to append" },
      milestone: { type: "string", description: "Milestone title (for milestone action) or substring match (for complete_milestone)" },
      milestone_date: { type: "string", description: "ISO date for the milestone (optional)" },
      milestone_notes: { type: "string", description: "Notes for the milestone" },
    },
    required: ["action"],
  },
  summarize(args) {
    const name = args.name ? ` · ${args.name}` : "";
    return `${args.action}${name}`;
  },
  risk(args) {
    const safe = new Set(["list", "view"]);
    return safe.has(args.action) ? "safe" : "caution";
  },
  async execute(args) {
    const action = String(args.action ?? "").trim();

    if (action === "list") {
      const rawStatus = args.status ? String(args.status).trim() : "active";
      if (!STATUSES.has(rawStatus)) {
        return { content: `Invalid status "${rawStatus}". Use: active, paused, completed, archived, all.`, isError: true };
      }
      const projects = listProjects(rawStatus === "all" ? "all" : rawStatus as ProjectStatus);
      if (!projects.length) {
        return { content: rawStatus === "all" ? "No projects yet." : `No ${rawStatus} projects.` };
      }
      return { content: projects.map(renderProject).join("\n\n---\n\n") };
    }

    if (action === "view") {
      const name = String(args.name ?? "").trim();
      if (!name) return { content: "name is required.", isError: true };
      const proj = lookupProject(name);
      if (!proj) return { content: `No project found matching "${name}".`, isError: true };
      return { content: renderProject(proj) };
    }

    if (action === "add") {
      const name = String(args.name ?? "").trim();
      if (!name) return { content: "name is required.", isError: true };
      const proj = upsertProject({
        name,
        description: args.description != null ? String(args.description) : undefined,
        goals: Array.isArray(args.goals) ? args.goals.map(String) : undefined,
        stakeholders: Array.isArray(args.stakeholders) ? args.stakeholders.map(String) : undefined,
        notes: args.notes != null ? String(args.notes) : undefined,
      });
      return { content: `Project created.\n\n${renderProject(proj)}`, display: proj.name };
    }

    if (action === "update") {
      const name = String(args.name ?? "").trim();
      if (!name) return { content: "name is required.", isError: true };
      const existing = lookupProject(name);
      if (!existing) return { content: `No project found matching "${name}".`, isError: true };

      const proj = upsertProject({
        name: existing.name, // use canonical name for the merge
        status: args.status != null ? String(args.status) as ProjectStatus : undefined,
        description: args.description != null ? String(args.description) : undefined,
        stakeholders: Array.isArray(args.stakeholders) ? args.stakeholders.map(String) : undefined,
        notes: args.notes != null ? String(args.notes) : undefined,
      });
      return { content: `Updated.\n\n${renderProject(proj)}`, display: proj.name };
    }

    if (action === "milestone") {
      const name = String(args.name ?? "").trim();
      const milestoneTitle = String(args.milestone ?? "").trim();
      if (!name || !milestoneTitle) return { content: "name and milestone are required.", isError: true };

      let date: number | undefined;
      if (args.milestone_date) {
        const d = new Date(String(args.milestone_date));
        if (!Number.isFinite(d.getTime())) return { content: `Invalid milestone_date "${args.milestone_date}".`, isError: true };
        date = d.getTime();
      }

      const proj = addMilestone(name, {
        title: milestoneTitle,
        done: false,
        date,
        notes: args.milestone_notes != null ? String(args.milestone_notes) : undefined,
      });
      if (!proj) return { content: `No project found matching "${name}".`, isError: true };
      return { content: `Milestone added.\n\n${renderProject(proj)}`, display: milestoneTitle };
    }

    if (action === "complete_milestone") {
      const name = String(args.name ?? "").trim();
      const milestoneMatch = String(args.milestone ?? "").trim();
      if (!name || !milestoneMatch) return { content: "name and milestone are required.", isError: true };

      const proj = completeMilestone(name, milestoneMatch);
      if (!proj) return { content: `No project found matching "${name}".`, isError: true };
      return { content: `Milestone marked done.\n\n${renderProject(proj)}`, display: milestoneMatch };
    }

    if (action === "close") {
      const name = String(args.name ?? "").trim();
      if (!name) return { content: "name is required.", isError: true };
      const rawStatus = args.status ? String(args.status).trim() : "completed";
      if (!["completed", "archived"].includes(rawStatus)) {
        return { content: `status must be "completed" or "archived".`, isError: true };
      }
      const existing = lookupProject(name);
      if (!existing) return { content: `No project found matching "${name}".`, isError: true };
      const proj = upsertProject({ name: existing.name, status: rawStatus as ProjectStatus });
      return { content: `Project set to ${proj.status}.\n\n${renderProject(proj)}`, display: proj.name };
    }

    return { content: `Unknown action "${action}". Valid: list, view, add, update, milestone, complete_milestone, close.`, isError: true };
  },
};
