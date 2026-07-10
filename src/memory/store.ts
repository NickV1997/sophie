import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { displayPath } from "../system/paths.ts";
import { ensureMigrated } from "./facts.ts";

/**
 * SOPHIE.md — Sophie's PERSONA file (who she is, her goal, her personality).
 * Short and always pinned into the byte-stable system prefix, so the KV cache is
 * never disturbed and a small model spends its context on the task, not trivia.
 * The bulk of what Sophie "knows" lives in the structured, keyword-retrieved
 * fact store (see ./facts.ts) and is injected only when relevant.
 *
 * Two scopes:
 *   - user:    ~/.sophie/SOPHIE.md   (default persona; user-editable)
 *   - project: <cwd>/SOPHIE.md       (project-specific persona / house notes)
 */
export type MemoryScope = "user" | "project";

export const MEMORY_DIR = join(homedir(), ".sophie");
export const USER_MEMORY = join(MEMORY_DIR, "SOPHIE.md");

/** Chars of persona we inline before truncating — kept tight on purpose. */
const MAX_PERSONA = 1200;

/** Default persona used when no SOPHIE.md exists (or the legacy one was retired). */
export const DEFAULT_PERSONA = `You are Sophie, a local-first personal AI assistant running on the user's own machine, in their terminal. You are warm, direct, and genuinely useful across anything: conversation, research, writing, planning, coding, and operating this computer.

Your goal: be the assistant a person actually wants at their side all day — quick, grounded, and quietly capable. Your intelligence comes less from what you remember and more from using your tools and skills precisely, and from grounding what you say in real data.`;

export function projectMemoryPath(cwd: string): string {
  return join(cwd, "SOPHIE.md");
}

export function memoryPath(scope: MemoryScope, cwd: string): string {
  return scope === "project" ? projectMemoryPath(cwd) : USER_MEMORY;
}

/** True if this file is the retired flat "list of facts" format, not a persona. */
function looksLegacy(text: string): boolean {
  return /Each line is a fact/i.test(text) || /^- \(\d{4}-\d{2}-\d{2}\)/m.test(text);
}

/** Raw persona content for the TUI editor (a starter template if none exists). */
export function readMemoryFile(scope: MemoryScope, cwd: string): string {
  const path = memoryPath(scope, cwd);
  if (!existsSync(path)) {
    return scope === "user"
      ? `# Sophie — persona\n\n${DEFAULT_PERSONA}\n`
      : `# Sophie — project persona / house notes\n\nProject-specific notes about how Sophie should behave in this folder.\n`;
  }
  const raw = readFileSync(path, "utf8");
  // Never show the retired fact-list as if it were editable persona.
  return looksLegacy(raw) ? `# Sophie — persona\n\n${DEFAULT_PERSONA}\n` : raw;
}

/** Save edited persona back to disk (creates ~/.sophie if needed). */
export function writeMemoryFile(scope: MemoryScope, cwd: string, content: string): void {
  const path = memoryPath(scope, cwd);
  if (scope === "user" && !existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true });
  writeFileSync(path, content.endsWith("\n") ? content : `${content}\n`);
}

function readPersona(path: string): string {
  if (!existsSync(path)) return "";
  const raw = readFileSync(path, "utf8").trim();
  if (!raw || looksLegacy(raw)) return "";
  // Drop a leading markdown title so the persona reads as prose.
  return raw.replace(/^#[^\n]*\n+/, "").trim();
}

function clip(text: string): string {
  return text.length <= MAX_PERSONA ? text : `${text.slice(0, MAX_PERSONA).trimEnd()}…`;
}

/**
 * The identity/persona block for the system prompt. Combines the user persona
 * (SOPHIE.md, or the default) with any project-specific persona. Always short.
 */
export function personaForPrompt(cwd: string): string {
  ensureMigrated(); // retire the legacy fact list into the structured store, once
  const user = readPersona(USER_MEMORY) || DEFAULT_PERSONA;
  const project = readPersona(projectMemoryPath(cwd));
  const parts = [clip(user)];
  if (project) parts.push(`\n# This project\n${clip(project)} (from ${displayPath(projectMemoryPath(cwd))})`);
  return parts.join("\n");
}
