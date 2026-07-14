/**
 * The dream pass — nightly memory consolidation, borrowed from the best of the
 * "second brain" agent-memory projects but built Sophie's way: the runtime does
 * everything it can deterministically, and the model's judgment is applied only
 * where judgment is genuinely needed — and even then only through validated,
 * capped directives it can propose but never enforce.
 *
 * One pass:
 *   1. Extraction  — distill buffered observations into memories (extraction.ts)
 *   2. Sweep       — deterministic: drop expired/vague, merge near-duplicates,
 *                    prune stale never-recalled runtime lint
 *   3. Review      — LLM proposes DROP / REWRITE / MERGE / SUPERSEDES over
 *                    numbered capsules; the runtime validates every directive
 *                    (index bounds, size bounds, vocabulary overlap with the
 *                    original, drop caps, user-sourced records protected) and
 *                    applies only what survives
 *   4. Compact     — the legacy keyword fact store gets the same dedup sweep
 *   5. Mirror      — a human-readable memory-report.md so what Sophie believes
 *                    is always one `open` away (the auditability the Obsidian
 *                    projects get right)
 *
 * Scheduled opportunistically: maybeRunMemoryUpkeep() fires after turns, runs
 * extraction when enough observations are buffered, and a full dream at most
 * once per DREAM_INTERVAL. Everything is fire-and-forget and failure-tolerant:
 * a dead model server degrades the pass to its deterministic phases.
 */
import { join } from "node:path";
import { completeChat } from "../llm/client.ts";
import { stripThink } from "../agent/context.ts";
import { addJournalEntry } from "../agent/tasks.ts";
import { config } from "../config.ts";
import { readJsonWithRecovery, writePrivateFileAtomic } from "../system/atomic-file.ts";
import type { EngineMemory, EngineMemoryScope } from "./engine.ts";
import { MAX_CAPSULE_CHARS, oneLine, readEngineStore, writeEngineStore } from "./engine_store.ts";
import { compactFactStore, listMemories, memoryHomeDir, tokenize } from "./facts.ts";
import { pendingObservationCount } from "./observations.ts";
import { runExtractionPass } from "./extraction.ts";

export interface DreamSweepStats {
  expired: number;
  vague: number;
  duplicates: number;
  staleJunk: number;
}

export interface DreamReviewStats {
  reviewed: number;
  dropped: number;
  rewritten: number;
  merged: number;
  superseded: number;
}

export interface DreamReport {
  ranAt: number;
  extracted: number;
  sweep: DreamSweepStats;
  review: DreamReviewStats;
  llmReviewed: boolean;
  legacyFactsMerged: number;
  remaining: { global: number; project: number };
}

const DREAM_INTERVAL_MS = 20 * 60 * 60 * 1000; // ~daily, tolerant of uneven usage
const EXTRACTION_THRESHOLD = 10; // buffered observations that justify a between-dreams pass
const STALE_JUNK_DAYS = 45;
const REVIEW_BATCH = 40;
const MAX_REVIEW_BATCHES_PER_SCOPE = 2;
/** A review reply may drop at most this share of a batch — a hallucinating or
 *  over-eager model must never be able to hollow out the store in one night. */
const MAX_DROP_RATIO = 0.34;
/** A rewrite/merge must share at least this share of the original's key tokens,
 *  so review can compress and clarify but never invent new "facts". */
const MIN_REWRITE_OVERLAP = 0.3;
/** Fulls longer than this get replaced by the (≤180 char) rewrite — this is the
 *  "summarize longer memories" half of REWRITE. */
const SUMMARIZE_FULL_OVER_CHARS = 400;

function jaccard(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const sb = new Set(b);
  const inter = a.filter((x) => sb.has(x)).length;
  return inter / (a.length + b.length - inter);
}

// ── phase 2: deterministic sweep ─────────────────────────────────────────────

export function sweepRecords(records: EngineMemory[], now = Date.now()): { records: EngineMemory[]; stats: DreamSweepStats } {
  const stats: DreamSweepStats = { expired: 0, vague: 0, duplicates: 0, staleJunk: 0 };
  const alive: EngineMemory[] = [];
  for (const rec of records) {
    if (rec.expiresAt && rec.expiresAt <= now) {
      stats.expired++;
      continue;
    }
    if (rec.keys.length < 2 || rec.capsule.length < 8) {
      stats.vague++;
      continue;
    }
    const ageDays = (now - rec.createdAt) / 86_400_000;
    const junk =
      rec.source !== "user" &&
      rec.source !== "verifier" &&
      rec.useCount === 0 &&
      rec.confidence < 0.7 &&
      ageDays > STALE_JUNK_DAYS;
    if (junk) {
      stats.staleJunk++;
      continue;
    }
    alive.push(rec);
  }
  // Cross-record duplicate merge, same kind only. Save-time dedup catches
  // repeats against ONE store snapshot; drifted phrasings accumulate anyway.
  const out: EngineMemory[] = [];
  for (const rec of alive) {
    const twin = out.find(
      (r) => r.kind === rec.kind && (r.capsule.toLowerCase() === rec.capsule.toLowerCase() || jaccard(r.keys, rec.keys) >= 0.62),
    );
    if (!twin) {
      out.push(rec);
      continue;
    }
    stats.duplicates++;
    // Keep the better-evidenced phrasing; fold the loser's history in.
    const winnerIsTwin = twin.confidence !== rec.confidence ? twin.confidence > rec.confidence : twin.lastUsedAt >= rec.lastUsedAt;
    const winner = winnerIsTwin ? twin : rec;
    const loser = winnerIsTwin ? rec : twin;
    const merged: EngineMemory = {
      ...winner,
      useCount: twin.useCount + rec.useCount,
      successCount: twin.successCount + rec.successCount,
      failureCount: twin.failureCount + rec.failureCount,
      utility: Math.max(twin.utility, rec.utility),
      keys: [...new Set([...winner.keys, ...loser.keys])].slice(0, 40),
      tags: [...new Set([...winner.tags, ...loser.tags])].slice(0, 16),
      createdAt: Math.min(twin.createdAt, rec.createdAt),
      lastUsedAt: Math.max(twin.lastUsedAt, rec.lastUsedAt),
    };
    out[out.indexOf(twin)] = merged;
  }
  return { records: out, stats };
}

// ── phase 3: validated LLM review ────────────────────────────────────────────

export type ReviewDirective =
  | { op: "drop"; a: number }
  | { op: "rewrite"; a: number; text: string }
  | { op: "merge"; a: number; b: number; text: string }
  | { op: "supersedes"; a: number; b: number };

/** Parse review reply lines; anything that doesn't match exactly is ignored. */
export function parseReviewDirectives(reply: string): ReviewDirective[] {
  const out: ReviewDirective[] = [];
  for (const raw of stripThink(reply).split("\n")) {
    const line = raw.trim();
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^DROP\s+(\d+)\s*(?:—|-|$)/i))) out.push({ op: "drop", a: Number(m[1]) });
    else if ((m = line.match(/^REWRITE\s+(\d+)\s*:\s*(.+)$/i))) out.push({ op: "rewrite", a: Number(m[1]), text: m[2]!.trim() });
    else if ((m = line.match(/^MERGE\s+(\d+)\s+(\d+)\s*:\s*(.+)$/i))) out.push({ op: "merge", a: Number(m[1]), b: Number(m[2]), text: m[3]!.trim() });
    else if ((m = line.match(/^SUPERSEDES\s+(\d+)\s+(\d+)\s*$/i))) out.push({ op: "supersedes", a: Number(m[1]), b: Number(m[2]) });
  }
  return out;
}

function validRewriteText(text: string, originalKeys: string[]): boolean {
  if (text.length < 12 || text.length > MAX_CAPSULE_CHARS) return false;
  const keys = tokenize(text);
  if (keys.length < 3) return false;
  const original = new Set(originalKeys);
  const overlap = keys.filter((k) => original.has(k)).length;
  return overlap / keys.length >= MIN_REWRITE_OVERLAP;
}

/**
 * Apply directives to a reviewed batch — pure, so tests can hammer it. Indices
 * are 1-based (as shown to the model). Each record participates in at most one
 * directive; invalid or over-cap directives are silently skipped.
 */
export function applyReviewDirectives(records: EngineMemory[], directives: ReviewDirective[]): { records: EngineMemory[]; stats: DreamReviewStats } {
  const stats: DreamReviewStats = { reviewed: records.length, dropped: 0, rewritten: 0, merged: 0, superseded: 0 };
  const result: (EngineMemory | null)[] = [...records];
  const touched = new Set<number>();
  const maxDrops = Math.ceil(records.length * MAX_DROP_RATIO);
  const inRange = (n: number) => Number.isInteger(n) && n >= 1 && n <= records.length;

  for (const d of directives) {
    if (!inRange(d.a) || touched.has(d.a)) continue;
    const a = result[d.a - 1];
    if (!a) continue;

    if (d.op === "drop") {
      // The user's own explicit statements are never the model's to discard.
      if (a.source === "user") continue;
      if (stats.dropped >= maxDrops) continue;
      result[d.a - 1] = null;
      touched.add(d.a);
      stats.dropped++;
      continue;
    }

    if (d.op === "rewrite") {
      if (!validRewriteText(d.text, a.keys)) continue;
      const capsule = oneLine(d.text, MAX_CAPSULE_CHARS);
      result[d.a - 1] = {
        ...a,
        capsule,
        // A verbose full is exactly what REWRITE exists to shrink; short fulls
        // keep their original detail under the sharper capsule.
        full: a.full.length > SUMMARIZE_FULL_OVER_CHARS ? capsule : a.full,
        keys: [...new Set([...a.keys, ...tokenize(capsule)])].slice(0, 40),
      };
      touched.add(d.a);
      stats.rewritten++;
      continue;
    }

    if (!inRange(d.b) || d.b === d.a || touched.has(d.b)) continue;
    const b = result[d.b - 1];
    if (!b) continue;

    if (d.op === "merge") {
      if (a.kind !== b.kind) continue;
      if (!validRewriteText(d.text, [...a.keys, ...b.keys])) continue;
      const capsule = oneLine(d.text, MAX_CAPSULE_CHARS);
      result[d.a - 1] = {
        ...(a.confidence >= b.confidence ? a : b),
        capsule,
        full: capsule,
        keys: [...new Set([...a.keys, ...b.keys, ...tokenize(capsule)])].slice(0, 40),
        tags: [...new Set([...a.tags, ...b.tags])].slice(0, 16),
        useCount: a.useCount + b.useCount,
        successCount: a.successCount + b.successCount,
        failureCount: a.failureCount + b.failureCount,
        createdAt: Math.min(a.createdAt, b.createdAt),
        lastUsedAt: Math.max(a.lastUsedAt, b.lastUsedAt),
      };
      result[d.b - 1] = null;
      touched.add(d.a).add(d.b);
      stats.merged++;
      continue;
    }

    // supersedes: the records contradict; regardless of which one the model
    // called current, the RUNTIME decides — the newer record survives.
    if (a.kind !== b.kind) continue;
    const newer = a.createdAt >= b.createdAt ? d.a : d.b;
    const older = newer === d.a ? d.b : d.a;
    if (result[older - 1]?.source === "user" && result[newer - 1]?.source !== "user") continue;
    result[older - 1] = null;
    touched.add(d.a).add(d.b);
    stats.superseded++;
  }

  return { records: result.filter((r): r is EngineMemory => r !== null), stats };
}

function reviewPrompt(batch: EngineMemory[], now: number): { role: "system" | "user"; content: string }[] {
  const lines = batch.map((r, i) => {
    const ageDays = Math.max(0, Math.round((now - r.createdAt) / 86_400_000));
    return `${i + 1}. [${r.kind}] ${r.capsule} (${ageDays}d old, recalled ${r.useCount}x)`;
  });
  return [
    {
      role: "system",
      content:
        "You are reviewing an assistant's long-term memories about its user for a nightly cleanup. " +
        "Judge each numbered memory. Reply ONLY with directive lines:\n" +
        "DROP <n> — nonsense, one-off trivia, or useless noise\n" +
        "REWRITE <n>: <one clearer, more descriptive sentence> — keeps the same meaning, just sharper\n" +
        "MERGE <n> <m>: <one combined sentence> — two memories of the same kind saying the same thing\n" +
        "SUPERSEDES <n> <m> — they contradict and one is outdated\n" +
        "Memories you don't mention are kept as-is. Most memories should be kept. " +
        "Never invent information that is not already in a memory. If no changes are needed, reply exactly: NONE. /no_think",
    },
    { role: "user", content: `Memories:\n${lines.join("\n")}` },
  ];
}

async function reviewScope(scope: EngineMemoryScope, cwd: string, stats: DreamReviewStats): Promise<boolean> {
  let records = readEngineStore(scope, cwd);
  if (records.length < 2) return false;
  // Least-recently-used first: that end of the store is where junk lives.
  const order = [...records].sort((x, y) => x.lastUsedAt - y.lastUsedAt);
  const now = Date.now();
  let reviewedAny = false;
  for (let b = 0; b < MAX_REVIEW_BATCHES_PER_SCOPE; b++) {
    const batch = order.slice(b * REVIEW_BATCH, (b + 1) * REVIEW_BATCH);
    if (batch.length < 2) break;
    const reply = await completeChat(reviewPrompt(batch, now), { temperature: 0.2, maxTokens: 900, thinking: "off" });
    const { records: kept, stats: s } = applyReviewDirectives(batch, parseReviewDirectives(reply));
    stats.reviewed += s.reviewed;
    stats.dropped += s.dropped;
    stats.rewritten += s.rewritten;
    stats.merged += s.merged;
    stats.superseded += s.superseded;
    // Fold the reviewed batch back into the (possibly larger) store.
    const batchIds = new Set(batch.map((r) => r.id));
    records = [...readEngineStore(scope, cwd).filter((r) => !batchIds.has(r.id)), ...kept];
    writeEngineStore(scope, cwd, records);
    reviewedAny = true;
  }
  return reviewedAny;
}

// ── phase 5: human-readable mirror ───────────────────────────────────────────

const KIND_ORDER: EngineMemory["kind"][] = ["user", "preference", "environment", "sophie", "procedure", "failure", "convention", "fact"];
const KIND_TITLE: Record<EngineMemory["kind"], string> = {
  user: "About the user",
  preference: "Preferences",
  environment: "Environment",
  sophie: "About Sophie",
  procedure: "Procedures that worked",
  failure: "Failure patterns",
  convention: "Conventions & lessons",
  fact: "Facts",
};

export function memoryReportPath(): string {
  return join(memoryHomeDir(), "memory-report.md");
}

function renderScope(title: string, records: EngineMemory[]): string[] {
  const lines = [`## ${title} (${records.length})`, ""];
  for (const kind of KIND_ORDER) {
    const rows = records.filter((r) => r.kind === kind).sort((x, y) => y.confidence - x.confidence);
    if (!rows.length) continue;
    lines.push(`### ${KIND_TITLE[kind]}`);
    for (const r of rows) {
      const meta = [`confidence ${r.confidence.toFixed(2)}`, `recalled ${r.useCount}x`, r.source];
      lines.push(`- ${r.capsule} _(${meta.join(", ")})_`);
    }
    lines.push("");
  }
  return lines;
}

/** Write the audit mirror: everything Sophie believes, grouped and readable. */
export function writeMemoryReport(cwd: string, report?: DreamReport): void {
  const global = readEngineStore("global", cwd);
  const project = readEngineStore("project", cwd);
  const legacy = [...listMemories("user", cwd), ...listMemories("project", cwd)];
  const lines = [
    "# Sophie memory report",
    "",
    `Generated ${new Date().toISOString()} by the dream pass. Read-only mirror —`,
    "to change a memory, tell Sophie (\"remember ...\", \"forget ...\").",
    "",
  ];
  if (report) {
    lines.push(
      "## Last dream pass",
      `- extracted ${report.extracted} new memories from buffered observations`,
      `- swept: ${report.sweep.duplicates} duplicates merged, ${report.sweep.staleJunk} stale + ${report.sweep.vague} vague + ${report.sweep.expired} expired removed`,
      report.llmReviewed
        ? `- model review: ${report.review.reviewed} reviewed → ${report.review.dropped} dropped, ${report.review.rewritten} rewritten, ${report.review.merged} merged, ${report.review.superseded} superseded`
        : "- model review: skipped (server unavailable) — deterministic phases only",
      `- legacy fact store: ${report.legacyFactsMerged} near-duplicates merged`,
      "",
    );
  }
  lines.push(...renderScope("Global memories", global));
  if (project.length) lines.push(...renderScope(`Project memories (${cwd})`, project));
  if (legacy.length) {
    lines.push(`## Keyword facts (${legacy.length})`, "");
    for (const r of legacy) lines.push(`- ${r.text} _(${r.type}, recalled ${r.useCount}x)_`);
    lines.push("");
  }
  writePrivateFileAtomic(memoryReportPath(), lines.join("\n"));
}

// ── orchestration & scheduling ───────────────────────────────────────────────

interface DreamState {
  lastRunAt: number;
  lastReport?: DreamReport;
}

function statePath(): string {
  return join(memoryHomeDir(), "dream.state.json");
}

export function lastDreamAt(): number {
  return readJsonWithRecovery<DreamState>(statePath())?.lastRunAt ?? 0;
}

/** Last dream run + its report, for the webapp memory page. */
export function readDreamState(): { lastRunAt: number; lastReport?: DreamReport } | null {
  return readJsonWithRecovery<DreamState>(statePath());
}

/** Run one full dream pass. Never throws; a dead model server just degrades
 *  the pass to its deterministic phases. */
export async function runDreamPass(cwd: string, opts: { llm?: boolean } = {}): Promise<DreamReport> {
  const report: DreamReport = {
    ranAt: Date.now(),
    extracted: 0,
    sweep: { expired: 0, vague: 0, duplicates: 0, staleJunk: 0 },
    review: { reviewed: 0, dropped: 0, rewritten: 0, merged: 0, superseded: 0 },
    llmReviewed: false,
    legacyFactsMerged: 0,
    remaining: { global: 0, project: 0 },
  };
  const useLlm = opts.llm ?? true;

  // 1. extraction — anything the day buffered becomes candidate memories first,
  //    so the sweep and review below clean the NEW memories too.
  if (useLlm) {
    try {
      const extraction = await runExtractionPass(cwd, { minObservations: 1 });
      report.extracted = extraction?.saved ?? 0;
    } catch {
      /* keep dreaming */
    }
  }

  // 2. deterministic sweep, both scopes.
  for (const scope of ["global", "project"] as EngineMemoryScope[]) {
    const swept = sweepRecords(readEngineStore(scope, cwd));
    report.sweep.expired += swept.stats.expired;
    report.sweep.vague += swept.stats.vague;
    report.sweep.duplicates += swept.stats.duplicates;
    report.sweep.staleJunk += swept.stats.staleJunk;
    writeEngineStore(scope, cwd, swept.records);
  }

  // 3. validated model review.
  if (useLlm) {
    try {
      const g = await reviewScope("global", cwd, report.review);
      const p = await reviewScope("project", cwd, report.review);
      report.llmReviewed = g || p;
    } catch {
      report.llmReviewed = false;
    }
  }

  // 4. legacy keyword store compaction.
  try {
    report.legacyFactsMerged = compactFactStore(cwd);
  } catch {
    /* best effort */
  }

  report.remaining = {
    global: readEngineStore("global", cwd).length,
    project: readEngineStore("project", cwd).length,
  };

  // 5. audit mirror + state.
  try {
    writeMemoryReport(cwd, report);
  } catch {
    /* the mirror is a convenience, never a blocker */
  }
  writePrivateFileAtomic(statePath(), `${JSON.stringify({ lastRunAt: report.ranAt, lastReport: report } satisfies DreamState, null, 2)}\n`);
  addJournalEntry({
    kind: "decision",
    summary: `Dream pass consolidated memory (${report.remaining.global} global / ${report.remaining.project} project remain).`,
    evidence: `extracted ${report.extracted}, merged ${report.sweep.duplicates + report.review.merged}, dropped ${report.sweep.staleJunk + report.sweep.vague + report.sweep.expired + report.review.dropped}, rewritten ${report.review.rewritten}, superseded ${report.review.superseded}`,
  });
  return report;
}

let upkeepInFlight = false;

/**
 * Post-turn hook: fire-and-forget memory upkeep. Runs a between-dreams
 * extraction when enough observations have buffered, and the full dream pass
 * at most once per interval. Must never block or fail a turn.
 */
export function maybeRunMemoryUpkeep(cwd: string): void {
  if (!config.dream || upkeepInFlight) return;
  const last = lastDreamAt();
  if (!last) {
    // Brand-new store: nothing to consolidate yet. Start the clock so the
    // first real dream happens roughly a day of use from now.
    writePrivateFileAtomic(statePath(), `${JSON.stringify({ lastRunAt: Date.now() } satisfies DreamState, null, 2)}\n`);
    return;
  }
  const dreamDue = Date.now() - last > DREAM_INTERVAL_MS;
  const extractionDue = pendingObservationCount() >= EXTRACTION_THRESHOLD;
  if (!dreamDue && !extractionDue) return;
  upkeepInFlight = true;
  void (async () => {
    try {
      if (dreamDue) await runDreamPass(cwd);
      else await runExtractionPass(cwd, { minObservations: EXTRACTION_THRESHOLD });
    } catch {
      /* upkeep is invisible unless it works */
    } finally {
      upkeepInFlight = false;
    }
  })();
}

/** Milliseconds from `from` until the next local occurrence of HH:00. */
export function msUntilNextHour(hour: number, from = new Date()): number {
  const next = new Date(from.getFullYear(), from.getMonth(), from.getDate(), hour, 0, 0, 0);
  if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - from.getTime();
}

const NIGHTLY_HOUR = 3;
/** The 3 AM run steps aside if a dream already happened this recently. */
const NIGHTLY_MIN_GAP_MS = 2 * 60 * 60 * 1000;

/**
 * While the session is open, run the dream pass every night at 3 AM local time
 * (in addition to the opportunistic post-turn upkeep, which the staleness gate
 * keeps from doubling up). The timer is unref'd so it never holds the process
 * open; returns a stopper for session cleanup.
 */
export function startNightlyDreamSchedule(cwd: string): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const arm = () => {
    if (stopped) return;
    timer = setTimeout(async () => {
      try {
        if (config.dream && !upkeepInFlight && Date.now() - lastDreamAt() > NIGHTLY_MIN_GAP_MS) {
          upkeepInFlight = true;
          try {
            await runDreamPass(cwd);
          } finally {
            upkeepInFlight = false;
          }
        }
      } catch {
        /* nightly upkeep must never disturb the session */
      }
      arm();
    }, msUntilNextHour(NIGHTLY_HOUR));
    timer.unref?.();
  };
  arm();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

/** Test helper. */
export function resetDreamLatch(): void {
  upkeepInFlight = false;
}
