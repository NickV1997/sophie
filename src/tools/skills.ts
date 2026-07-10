import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { addJournalEntry } from "../agent/tasks.ts";
import { allSkills, getSkill, reloadSkills } from "../skills/registry.ts";
import type { Tool } from "./types.ts";

/**
 * Loads a skill's full procedure into context on demand. Sophie sees only the
 * skill catalog in her system prompt; when a task matches one, she calls this to
 * pull the step-by-step instructions, then follows them.
 */
export const loadSkill: Tool = {
  name: "load_skill",
  description:
    "Load the full step-by-step instructions for one of your skills (listed in " +
    "your Skills catalog). Call this the moment a task matches a skill, then " +
    "follow the returned procedure exactly.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "The exact skill name from the catalog." },
    },
    required: ["name"],
  },
  summarize: (a) => `${a.name}`,
  risk: () => "safe",
  async execute(args) {
    const skill = getSkill(String(args.name ?? "").trim());
    if (!skill) {
      const available = allSkills().map((s) => s.name).join(", ") || "none";
      return {
        content: `No skill named "${args.name}". Available skills: ${available}.`,
        isError: true,
      };
    }
    addJournalEntry({
      kind: "decision",
      tool: "load_skill",
      summary: `Loaded skill ${skill.name}.`,
      evidence: skill.source,
    });
    return {
      content: [
        `# Skill: ${skill.name}`,
        skill.description ? `Purpose: ${skill.description}` : "",
        skill.when ? `Use when: ${skill.when}` : "",
        "Follow this procedure for this task. Keep only the relevant steps in working memory.",
        "",
        skill.body,
      ].filter(Boolean).join("\n"),
      display: "loaded",
    };
  },
};

function slug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export const saveSkill: Tool = {
  name: "save_skill",
  description:
    "Create or update a reusable Sophie skill in ~/.sophie/skills. Use after a complex task reveals a repeatable workflow, or when the user asks Sophie to remember a procedure as a skill. Keep skills concise and procedural.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Stable skill name, lowercase kebab-case." },
      description: { type: "string", description: "One-line catalog description." },
      when: { type: "string", description: "Trigger: when to load this skill." },
      body: { type: "string", description: "Markdown procedure: concrete steps and rules." },
      overwrite: { type: "boolean", description: "Overwrite a same-named user skill. Default false." },
    },
    required: ["name", "description", "when", "body"],
  },
  summarize: (a) => `save skill ${a.name}`,
  risk: () => "safe",
  async execute(args) {
    const name = slug(String(args.name ?? ""));
    const description = String(args.description ?? "").trim();
    const when = String(args.when ?? "").trim();
    const body = String(args.body ?? "").trim();
    if (!name || !description || !when || !body) {
      return { content: "name, description, when, and body are required.", isError: true };
    }
    if (body.length > 12_000) {
      return { content: "Skill body is too large. Keep it under 12,000 characters.", isError: true };
    }
    const dir = join(homedir(), ".sophie", "skills");
    const path = join(dir, `${name}.md`);
    if (existsSync(path) && !args.overwrite) {
      return {
        content: `Skill already exists at ${path}. Pass overwrite=true to replace it after reading the existing skill.`,
        isError: true,
        display: "exists",
      };
    }
    mkdirSync(dir, { recursive: true });
    const text = [
      "---",
      `name: ${name}`,
      `description: ${JSON.stringify(description)}`,
      `when: ${JSON.stringify(when)}`,
      "---",
      "",
      body,
      "",
    ].join("\n");
    writeFileSync(path, text);
    reloadSkills();
    addJournalEntry({
      kind: "decision",
      tool: "save_skill",
      summary: `Saved reusable skill ${name}.`,
      evidence: path,
    });
    return {
      content: `Saved skill ${name} to ${path}. It is now available through load_skill.`,
      display: name,
    };
  },
};
