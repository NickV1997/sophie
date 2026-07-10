import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Mode } from "../config.ts";
import type { ChatMessage } from "../llm/client.ts";
import { saveEpisodeSnapshot } from "./episodes.ts";
import type { AgentJob, JournalEntry, Objective, Task } from "./tasks.ts";

/**
 * Session persistence — save the whole conversation (model history, task list,
 * mode, and the rendered transcript) to disk so a long task survives closing
 * the TUI. Resume picks up exactly where you left off, including any background
 * jobs that kept running. `blocks` is the TUI's opaque transcript (JSON), kept
 * generic so this module stays decoupled from the UI.
 */
export interface SessionState {
  id: string;
  title: string;
  cwd: string;
  updatedAt: number;
  mode: Mode;
  history: ChatMessage[];
  tasks: Task[];
  job?: AgentJob | null;
  journal?: JournalEntry[];
  objective?: Objective | null;
  blocks: unknown[];
}

export interface SessionMeta {
  id: string;
  title: string;
  cwd: string;
  updatedAt: number;
  turns: number;
}

const DIR = join(homedir(), ".sophie", "sessions");

let _currentSessionId: string | null = null;

export function setCurrentSessionId(id: string): void {
  _currentSessionId = id;
}

export function getCurrentSessionId(): string | null {
  return _currentSessionId;
}

function ensureDir(): void {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
}

export function newSessionId(): string {
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function saveSession(state: SessionState): void {
  if (!state.history.length && !state.blocks.length) return; // nothing to save
  ensureDir();
  writeFileSync(join(DIR, `${state.id}.json`), JSON.stringify(state));
  if (state.job) {
    saveEpisodeSnapshot({
      job: state.job,
      sessionId: state.id,
      cwd: state.cwd,
      updatedAt: state.updatedAt,
      objective: state.objective ?? null,
      tasks: state.tasks,
      journal: state.journal ?? [],
    });
  }
}

export function loadSession(id: string): SessionState | null {
  const path = join(DIR, `${id}.json`);
  if (!existsSync(path)) return null;
  try {
    return normalizeSession(JSON.parse(readFileSync(path, "utf8")) as SessionState);
  } catch {
    return null;
  }
}

export function deleteSession(id: string): boolean {
  if (!/^s-[a-z0-9-]+$/i.test(id)) return false;
  const path = join(DIR, `${id}.json`);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}

export function listSessions(): SessionMeta[] {
  if (!existsSync(DIR)) return [];
  const metas: SessionMeta[] = [];
  for (const f of readdirSync(DIR)) {
    if (!f.endsWith(".json")) continue;
    try {
      const s = JSON.parse(readFileSync(join(DIR, f), "utf8")) as SessionState;
      metas.push({
        id: s.id,
        title: s.title,
        cwd: s.cwd,
        updatedAt: s.updatedAt,
        turns: s.history.filter((m) => m.role === "user").length,
      });
    } catch {
      /* skip corrupt */
    }
  }
  return metas.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Most recent session, optionally restricted to a working directory. */
export function latestSession(cwd?: string): SessionState | null {
  const metas = listSessions();
  const pick = cwd ? metas.find((m) => m.cwd === cwd) ?? metas[0] : metas[0];
  return pick ? loadSession(pick.id) : null;
}

/** A short title from the first user message. */
export function titleFrom(history: ChatMessage[]): string {
  const firstUser = history.find((m) => m.role === "user");
  const text = firstUser && typeof firstUser.content === "string" ? firstUser.content : "";
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine ? (oneLine.length > 60 ? `${oneLine.slice(0, 57)}…` : oneLine) : "Untitled session";
}

function normalizeSession(state: SessionState): SessionState {
  return {
    ...state,
    history: state.history.map((m) => {
      const content = typeof m.content === "string" ? normalizeHistoryText(m.content) : m.content;
      const compacted =
        typeof content === "string" &&
        (content.startsWith("[Earlier work was compacted to save context.") ||
          content.startsWith("[Compacted continuation brief"));
      return {
        ...m,
        role: compacted ? "system" : m.role,
        content,
      };
    }),
  };
}

function normalizeHistoryText(text: string): string {
  return text
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, (block) =>
      block
        .replace(/([{,]\s*)"name\s*=\s*"/g, '$1"name":"')
        .replace(/([{,]\s*)name\s*=\s*"/g, '$1"name":"')
        .replace(/,\s*arguments"\s*:/g, ',"arguments":')
        .replace(/,\s*arguments\s*:/g, ',"arguments":'),
    )
    .replace(/<\|im_start\|>[\s\S]*?<\|im_end\|>/g, "[chat-template block omitted]");
}
