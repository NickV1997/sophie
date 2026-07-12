/**
 * Projects — persistent project tracking for Sophie.
 *
 * Records live in ~/.sophie/projects.jsonl (newline-delimited JSON).
 * Each project has goals, stakeholders, milestones, and status — so Sophie
 * can give informed updates and track progress across sessions.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { memoryHomeDir } from "../memory/facts.ts";
import { findEntities, linkEntities, upsertEntity } from "../system/entities.ts";

export type ProjectStatus = "active" | "paused" | "completed" | "archived";

export interface Milestone {
  title: string;
  done: boolean;
  date?: number;
  notes?: string;
}

export interface Project {
  id: string;           // proj_<base36><random>
  name: string;
  status: ProjectStatus;
  description: string;
  goals: string[];
  stakeholders: string[]; // person names
  milestones: Milestone[];
  notes: string;
  createdAt: number;
  updatedAt: number;
}

function storePath(): string {
  return join(memoryHomeDir(), "projects.jsonl");
}

function ensureDir(): void {
  const dir = memoryHomeDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function newId(): string {
  return `proj_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function readAll(): Project[] {
  const path = storePath();
  if (!existsSync(path)) return [];
  const out: Project[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const rec = JSON.parse(t) as Project;
      if (rec && typeof rec.name === "string") out.push(rec);
    } catch {
      /* skip corrupt line */
    }
  }
  return out;
}

function writeAll(records: Project[]): void {
  ensureDir();
  writeFileSync(
    storePath(),
    records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : ""),
  );
}

function findByIdOrName(records: Project[], idOrName: string): Project | undefined {
  const lower = idOrName.toLowerCase().trim();
  return (
    records.find((r) => r.id === idOrName) ??
    records.find((r) => r.name.toLowerCase() === lower) ??
    records.find((r) => r.name.toLowerCase().startsWith(lower)) ??
    records.find((r) => r.name.toLowerCase().includes(lower))
  );
}

// ── public api ────────────────────────────────────────────────────────────────

/** List projects, optionally filtered by status. */
export function listProjects(status?: ProjectStatus | "all"): Project[] {
  const records = readAll();
  if (!status || status === "all") return records;
  return records.filter((p) => p.status === status);
}

/** Find a project by name, description, or goals (fuzzy). */
export function lookupProject(query: string): Project | undefined {
  const records = readAll();
  const q = query.toLowerCase().trim();
  return (
    records.find((p) => p.name.toLowerCase() === q) ??
    records.find((p) => p.name.toLowerCase().startsWith(q)) ??
    records.find((p) => p.name.toLowerCase().includes(q)) ??
    records.find((p) => p.description.toLowerCase().includes(q)) ??
    records.find((p) => p.goals.some((g) => g.toLowerCase().includes(q)))
  );
}

export function getProject(id: string): Project | undefined {
  return readAll().find((p) => p.id === id);
}

/** Create or update a project. Stakeholders merged (union); milestones replaced only if provided. */
export function upsertProject(data: Partial<Project> & { name: string }): Project {
  const records = readAll();
  const existing = records.find((p) => p.name.toLowerCase() === data.name.toLowerCase());
  const now = Date.now();

  if (existing) {
    const merged: Project = {
      ...existing,
      status: data.status ?? existing.status,
      description: data.description ?? existing.description,
      goals: data.goals != null ? [...new Set([...existing.goals, ...data.goals])] : existing.goals,
      stakeholders: data.stakeholders != null
        ? [...new Set([...existing.stakeholders, ...data.stakeholders])]
        : existing.stakeholders,
      milestones: data.milestones != null ? data.milestones : existing.milestones,
      notes: data.notes?.trim()
        ? existing.notes
          ? `${existing.notes}\n${data.notes.trim()}`
          : data.notes.trim()
        : existing.notes,
      updatedAt: now,
    };
    const idx = records.findIndex((r) => r.id === existing.id);
    records[idx] = merged;
    writeAll(records);
    syncProjectEntity(merged);
    return merged;
  }

  const record: Project = {
    id: newId(),
    name: data.name.trim(),
    status: data.status ?? "active",
    description: data.description ?? "",
    goals: data.goals ?? [],
    stakeholders: data.stakeholders ?? [],
    milestones: data.milestones ?? [],
    notes: data.notes?.trim() ?? "",
    createdAt: now,
    updatedAt: now,
  };
  records.push(record);
  writeAll(records);
  syncProjectEntity(record);
  return record;
}

function syncProjectEntity(project: Project): void {
  const entity = upsertEntity("project", project.id, project.name);
  for (const stakeholder of project.stakeholders) {
    const person = findEntities(stakeholder, "person").find((item) =>
      item.name.toLowerCase() === stakeholder.toLowerCase() ||
      item.aliases.some((alias) => alias.toLowerCase() === stakeholder.toLowerCase()));
    if (person) linkEntities(entity.id, person.id, "has_stakeholder");
  }
}

/** Add a milestone to a project. */
export function addMilestone(idOrName: string, milestone: Milestone): Project | null {
  const records = readAll();
  const proj = findByIdOrName(records, idOrName);
  if (!proj) return null;

  proj.milestones.push(milestone);
  proj.updatedAt = Date.now();
  writeAll(records);
  return proj;
}

/** Mark a milestone done by substring match on title. */
export function completeMilestone(idOrName: string, milestoneMatch: string): Project | null {
  const records = readAll();
  const proj = findByIdOrName(records, idOrName);
  if (!proj) return null;

  const lower = milestoneMatch.toLowerCase();
  let touched = false;
  for (const m of proj.milestones) {
    if (!m.done && m.title.toLowerCase().includes(lower)) {
      m.done = true;
      m.date = Date.now();
      touched = true;
    }
  }
  if (touched) {
    proj.updatedAt = Date.now();
    writeAll(records);
  }
  return proj;
}

/** Format a project into readable text with milestone checkboxes. */
export function renderProject(p: Project): string {
  const lines: string[] = [];
  lines.push(`## ${p.name} [${p.status}]`);
  if (p.description) lines.push(p.description);
  if (p.goals.length) {
    lines.push("Goals:");
    for (const g of p.goals) lines.push(`  · ${g}`);
  }
  if (p.stakeholders.length) lines.push(`Stakeholders: ${p.stakeholders.join(", ")}`);
  if (p.milestones.length) {
    const done = p.milestones.filter((m) => m.done).length;
    lines.push(`Milestones (${done}/${p.milestones.length}):`);
    for (const m of p.milestones) {
      const check = m.done ? "☑" : "☐";
      const date = m.date ? ` (${new Date(m.date).toISOString().slice(0, 10)})` : "";
      const note = m.notes ? ` — ${m.notes}` : "";
      lines.push(`  ${check} ${m.title}${date}${note}`);
    }
  }
  if (p.notes) {
    lines.push("Notes:");
    for (const line of p.notes.split("\n").slice(-8)) lines.push(`  ${line}`);
  }
  return lines.join("\n");
}

/** Brief block for the system prompt with active projects only, or "" if none. */
export function activeProjectsForPrompt(): string {
  const active = listProjects("active");
  if (!active.length) return "";
  const lines = ["# Active projects"];
  for (const p of active) {
    const done = p.milestones.filter((m) => m.done).length;
    const total = p.milestones.length;
    const ms = `${done}/${total} milestones`;
    const stakeholders = p.stakeholders.length ? ` · stakeholders: ${p.stakeholders.join(", ")}` : "";
    const desc = p.description ? `: ${p.description.slice(0, 80)}` : "";
    lines.push(`- ${p.name} (${ms})${stakeholders}${desc}`);
  }
  return lines.join("\n");
}
