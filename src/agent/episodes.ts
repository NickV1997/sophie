import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentJob, JournalEntry, Objective, Task } from "./tasks.ts";

export interface EpisodeSnapshot {
  job: AgentJob;
  sessionId: string;
  cwd: string;
  updatedAt: number;
  objective: Objective | null;
  tasks: Task[];
  journal: JournalEntry[];
}

export interface EpisodeMeta {
  id: string;
  title: string;
  status: string;
  cwd: string;
  sessionId: string;
  updatedAt: number;
  openTasks: number;
}

function episodeDir(): string {
  return process.env.SOPHIE_EPISODES_DIR || join(homedir(), ".sophie", "episodes");
}

function ensureDir(): void {
  const DIR = episodeDir();
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
}

export function saveEpisodeSnapshot(snapshot: EpisodeSnapshot): void {
  ensureDir();
  writeFileSync(join(episodeDir(), `${snapshot.job.id}.json`), JSON.stringify(snapshot));
}

export function loadEpisode(id: string): EpisodeSnapshot | null {
  const path = join(episodeDir(), `${id}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as EpisodeSnapshot;
  } catch {
    return null;
  }
}

export function listEpisodes(): EpisodeMeta[] {
  const DIR = episodeDir();
  if (!existsSync(DIR)) return [];
  const out: EpisodeMeta[] = [];
  for (const file of readdirSync(DIR)) {
    if (!file.endsWith(".json")) continue;
    try {
      const snapshot = JSON.parse(readFileSync(join(DIR, file), "utf8")) as EpisodeSnapshot;
      out.push({
        id: snapshot.job.id,
        title: snapshot.job.title,
        status: snapshot.job.status,
        cwd: snapshot.cwd,
        sessionId: snapshot.sessionId,
        updatedAt: snapshot.updatedAt,
        openTasks: snapshot.tasks.filter((t) => t.status !== "completed").length,
      });
    } catch {
      /* skip corrupt episode */
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function searchVerifiedEpisodes(query: string, limit = 5): string[] {
  const q = query.toLowerCase().trim();
  if (!q) return [];
  const words = q.split(/\s+/).filter((w) => w.length > 2);
  const matches: { score: number; text: string; updatedAt: number }[] = [];
  for (const meta of listEpisodes()) {
    const episode = loadEpisode(meta.id);
    if (!episode) continue;
    const haystack = [
      episode.job.title,
      episode.objective?.content ?? "",
      ...episode.tasks.map((t) => `${t.content} ${t.note ?? ""}`),
      ...episode.journal.map((j) => `${j.summary} ${j.evidence ?? ""}`),
    ].join(" ").toLowerCase();
    const score = words.reduce((n, word) => n + (haystack.includes(word) ? 1 : 0), 0);
    if (!score) continue;
    const verified = episode.journal
      .filter((j) => j.kind === "verification" && !j.isError)
      .slice(-3)
      .map((j) => `verification: ${j.summary}${j.evidence ? ` | ${j.evidence}` : ""}`);
    if (!verified.length) continue;
    matches.push({
      score,
      updatedAt: episode.updatedAt,
      text: [`job ${episode.job.id}: ${episode.job.title}`, ...verified].join("\n"),
    });
  }
  return matches
    .sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt)
    .slice(0, limit)
    .map((m) => m.text);
}
