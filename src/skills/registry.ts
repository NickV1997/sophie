import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "../config.ts";

/**
 * Skills are short, on-demand procedures (markdown checklists) that teach Sophie
 * how to do a class of task well with her tools. The system prompt only ever
 * carries the compact catalog (name + description); the full body is loaded on
 * demand via the load_skill tool. This keeps context lean for a small model —
 * detailed know-how appears only when a task actually needs it.
 */
export interface Skill {
  name: string;
  description: string;
  when: string;
  body: string;
  source: string;
}

/** Repo skills ship with Sophie; user skills let people add their own. */
const SKILL_DIRS = [join(REPO_ROOT, "skills"), join(homedir(), ".sophie", "skills")];

let cache: Map<string, Skill> | null = null;

function parse(raw: string, file: string): Skill | null {
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return null;
  const meta: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i === -1) continue;
    const key = line.slice(0, i).trim();
    let val = line.slice(i + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
      val = val.slice(1, -1);
    meta[key] = val;
  }
  if (!meta.name) return null;
  return {
    name: meta.name,
    description: meta.description ?? "",
    when: meta.when ?? "",
    body: m[2].trim(),
    source: file,
  };
}

function load(): Map<string, Skill> {
  if (cache) return cache;
  cache = new Map();
  for (const dir of SKILL_DIRS) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      const skill = parse(readFileSync(join(dir, f), "utf8"), join(dir, f));
      if (skill) cache.set(skill.name, skill); // later dirs (user) override earlier
    }
  }
  return cache;
}

export function allSkills(): Skill[] {
  return [...load().values()];
}

export function reloadSkills(): void {
  cache = null;
}

export function getSkill(name: string): Skill | undefined {
  return load().get(name);
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clip(text: string, max: number): string {
  const s = oneLine(text);
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** Compact, always-on catalog for the system prompt. One bounded line per skill.
 *
 * The catalog's only job is routing: let the model recognize a match and call
 * load_skill; the full body (with detailed when-to-use and steps) arrives on
 * load. So each line carries a single trigger clause — the `when` condition,
 * which is exactly the "should I reach for this?" signal — and falls back to the
 * description only when a skill omits `when`. Previously every line printed BOTH
 * the description and the `when`, which restated the same routing signal twice
 * and roughly doubled the catalog's per-round context cost for no added
 * selection accuracy. */
export function skillCatalog(max = 24): string {
  const skills = allSkills();
  if (!skills.length) return "(no skills installed)";
  const shown = skills.slice(0, max).map((s) => {
    const trigger = clip(s.when || s.description || "procedure", 120);
    return `- ${s.name}: ${trigger}`;
  });
  const remaining = skills.length - shown.length;
  return remaining > 0 ? `${shown.join("\n")}\n- … ${remaining} more skills available by exact name` : shown.join("\n");
}
