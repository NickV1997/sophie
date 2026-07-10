import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Structured, keyword-retrieved fact memory — the bulk of what Sophie "knows".
 *
 * Unlike the persona (SOPHIE.md, always pinned), these facts are NOT injected
 * wholesale. Each turn we extract keywords from the user's message, score the
 * store, and inject only the top few matches into the ephemeral trailing
 * message — so the model never sees "the user likes pizza" while fixing a bug,
 * and the byte-stable system prefix (and its KV cache) is never disturbed.
 *
 * Storage: newline-delimited JSON (one MemoryRecord per line).
 *   - user:    ~/.sophie/memory.jsonl
 *   - project: <cwd>/.sophie/memory.jsonl
 */

export type MemoryScope = "user" | "project";
export type MemoryType = "fact" | "preference" | "convention";

export interface MemoryRecord {
  id: string;
  /** The remembered fact, one clear sentence. */
  text: string;
  /** Normalized keyword tokens (from text + explicit keys) used for retrieval. */
  keys: string[];
  scope: MemoryScope;
  type: MemoryType;
  /** Stable upsert key for self-managed facts (e.g. "location"); absent for free facts. */
  slot?: string;
  /** Base importance 0..1 — nudges scoring so pinned-ish facts win ties. */
  salience: number;
  /** How many times this memory has been recalled-and-used (reinforcement). */
  useCount: number;
  createdAt: number;
  lastUsedAt: number;
}

// Resolved lazily (not at module load) so a relocated store — tests, or a user
// pointing SOPHIE_HOME elsewhere — is always respected.
export function memoryHomeDir(): string {
  const base = process.env.SOPHIE_HOME;
  return base ? join(base, ".sophie") : join(homedir(), ".sophie");
}
const homeDir = memoryHomeDir;

function userStorePath(): string {
  return join(homeDir(), "memory.jsonl");
}
function projectStorePath(cwd: string): string {
  return join(cwd, ".sophie", "memory.jsonl");
}
function storePath(scope: MemoryScope, cwd: string): string {
  return scope === "project" ? projectStorePath(cwd) : userStorePath();
}

// ── tokenization ────────────────────────────────────────────────────────────

const STOP = new Set([
  "the", "and", "for", "are", "was", "were", "with", "this", "that", "them", "then",
  "there", "here", "have", "has", "had", "will", "would", "should", "could", "can",
  "you", "your", "our", "his", "her", "its", "their", "who", "what", "when", "where",
  "why", "how", "not", "but", "all", "any", "get", "got", "let", "put", "use", "used",
  "want", "need", "like", "just", "into", "out", "off", "over", "from", "about", "some",
  "one", "two", "his", "she", "him", "they", "been", "being", "does", "did", "doing",
  "make", "made", "also", "than", "too", "very", "now", "new", "old", "way", "day",
]);

/** Lowercase alphanum tokens ≥3 chars, stop-words dropped, plural 's' folded, unique. */
export function tokenize(text: string): string[] {
  const raw = text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
  const out = new Set<string>();
  for (const w of raw) {
    if (STOP.has(w)) continue;
    // Fold a trailing plural 's' so "bugs" matches "bug" (keep words like "css").
    const norm = w.length >= 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w;
    out.add(norm);
  }
  return [...out];
}

// ── io ───────────────────────────────────────────────────────────────────────

function readStore(scope: MemoryScope, cwd: string): MemoryRecord[] {
  const path = storePath(scope, cwd);
  if (!existsSync(path)) return [];
  const out: MemoryRecord[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const rec = JSON.parse(t) as MemoryRecord;
      if (rec && typeof rec.text === "string") out.push(rec);
    } catch {
      /* skip a corrupt line rather than lose the whole store */
    }
  }
  return out;
}

function writeStore(scope: MemoryScope, cwd: string, records: MemoryRecord[]): void {
  const path = storePath(scope, cwd);
  const dir = join(path, "..");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : ""));
}

function newId(): string {
  return `m_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// ── scoring / dedup ───────────────────────────────────────────────────────────

/** Jaccard similarity of two key sets — used to detect near-duplicate facts. */
function jaccard(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const sb = new Set(b);
  const inter = a.filter((x) => sb.has(x)).length;
  return inter / (a.length + b.length - inter);
}

function score(rec: MemoryRecord, queryTokens: string[], now: number): number {
  let overlap = 0;
  const keys = new Set(rec.keys);
  for (const t of queryTokens) if (keys.has(t)) overlap++;
  if (!overlap) return 0;
  const ageDays = Math.max(0, (now - rec.lastUsedAt) / 86_400_000);
  const recency = Math.exp(-ageDays / 45); // ~6-week half-life
  const usage = Math.log1p(rec.useCount);
  return overlap * (1 + 0.5 * recency + 0.3 * usage) * (0.5 + rec.salience);
}

// ── public api ────────────────────────────────────────────────────────────────

export interface AddOptions {
  scope?: MemoryScope;
  type?: MemoryType;
  slot?: string;
  salience?: number;
}

/**
 * Add a fact, or MERGE it into a near-duplicate instead of appending — the key
 * anti-bloat move. Returns whether it created a new record or updated an existing
 * one. Dedup is by explicit slot first, then by keyword similarity.
 */
export function addMemory(
  fact: string,
  cwd: string,
  opts: AddOptions = {},
): { action: "created" | "merged"; record: MemoryRecord } {
  ensureMigrated();
  const scope: MemoryScope = opts.scope === "project" ? "project" : "user";
  const text = fact.trim();
  const keys = tokenize(text);
  const records = readStore(scope, cwd);
  const now = Date.now();

  // 1) explicit slot upsert (self-managed facts like "location")
  // 2) otherwise fold into a strongly-similar existing fact
  const idx = opts.slot
    ? records.findIndex((r) => r.slot === opts.slot)
    : records.findIndex((r) => jaccard(r.keys, keys) >= 0.6);

  if (idx !== -1) {
    const prev = records[idx]!;
    const merged: MemoryRecord = {
      ...prev,
      text,
      keys: [...new Set([...keys, ...prev.keys])].slice(0, 24),
      type: opts.type ?? prev.type,
      slot: opts.slot ?? prev.slot,
      salience: Math.min(1, Math.max(prev.salience, opts.salience ?? prev.salience)),
      useCount: prev.useCount + 1,
      lastUsedAt: now,
    };
    records[idx] = merged;
    writeStore(scope, cwd, records);
    return { action: "merged", record: merged };
  }

  const record: MemoryRecord = {
    id: newId(),
    text,
    keys: keys.slice(0, 24),
    scope,
    type: opts.type ?? "fact",
    slot: opts.slot,
    salience: opts.salience ?? 0.3,
    useCount: 0,
    createdAt: now,
    lastUsedAt: now,
  };
  records.push(record);
  writeStore(scope, cwd, records);
  return { action: "created", record };
}

/** Upsert a self-managed fact by stable slot (e.g. onboarding's location). */
export function upsertMemory(slot: string, fact: string, cwd: string, opts: AddOptions = {}): void {
  addMemory(fact, cwd, { ...opts, slot });
}

/**
 * Retrieve the top matches for a query across user + project scope, and REINFORCE
 * them (bump useCount/lastUsedAt) so what gets used stays retrievable and what
 * doesn't decays. Returns [] when nothing matches — so unrelated turns inject
 * nothing.
 */
export function recallMemories(query: string, cwd: string, limit = 4): MemoryRecord[] {
  ensureMigrated();
  const queryTokens = tokenize(query);
  if (!queryTokens.length) return [];
  const now = Date.now();

  const scopes: MemoryScope[] = existsSync(projectStorePath(cwd)) ? ["user", "project"] : ["user"];
  const scored: { rec: MemoryRecord; scope: MemoryScope; s: number }[] = [];
  for (const scope of scopes) {
    for (const rec of readStore(scope, cwd)) {
      const s = score(rec, queryTokens, now);
      if (s > 0) scored.push({ rec, scope, s });
    }
  }
  if (!scored.length) return [];

  scored.sort((a, b) => b.s - a.s);
  const top = scored.slice(0, limit);

  // Reinforce the ones we surfaced, per scope.
  const bump = new Set(top.map((t) => t.rec.id));
  for (const scope of scopes) {
    const records = readStore(scope, cwd);
    let touched = false;
    for (const r of records) {
      if (bump.has(r.id)) {
        r.useCount++;
        r.lastUsedAt = now;
        touched = true;
      }
    }
    if (touched) writeStore(scope, cwd, records);
  }
  return top.map((t) => t.rec);
}

/** Formatted recall block for the ephemeral turn message, or "" if no matches. */
export function recallForPrompt(query: string, cwd: string, limit = 4): string {
  const hits = recallMemories(query, cwd, limit);
  if (!hits.length) return "";
  return ["# Relevant memory (retrieved for this message)", ...hits.map((h) => `- ${h.text}`)].join("\n");
}

/** All records for a scope (for listing / the explicit recall tool fallback). */
export function listMemories(scope: MemoryScope, cwd: string): MemoryRecord[] {
  ensureMigrated();
  return readStore(scope, cwd);
}

/** Reinforce specific records (bump useCount/lastUsedAt) — used by semantic
 *  recall, which selects records outside recallMemories' keyword scoring. */
export function reinforceMemories(ids: Iterable<string>, cwd: string): void {
  const bump = new Set(ids);
  if (!bump.size) return;
  const now = Date.now();
  for (const scope of ["user", "project"] as MemoryScope[]) {
    const records = readStore(scope, cwd);
    let touched = false;
    for (const r of records) {
      if (bump.has(r.id)) {
        r.useCount++;
        r.lastUsedAt = now;
        touched = true;
      }
    }
    if (touched) writeStore(scope, cwd, records);
  }
}

// ── one-time migration from the legacy flat SOPHIE.md fact list ────────────────

function migratedMarker(): string {
  return join(homeDir(), ".memory-migrated");
}
function legacySophiePath(): string {
  return join(homeDir(), "SOPHIE.md");
}

/**
 * The old SOPHIE.md was an append-only list of `- (date) fact` lines. Import
 * those into the structured store once, so nothing Sophie already learned is
 * lost when SOPHIE.md becomes the persona file. Machine specs are intentionally
 * skipped (they're live in the Environment block already). Runs at most once.
 */
export function ensureMigrated(): void {
  if (existsSync(migratedMarker())) return;
  try {
    if (!existsSync(homeDir())) mkdirSync(homeDir(), { recursive: true });
    const legacy = legacySophiePath();
    if (existsSync(legacy)) {
      const raw = readFileSync(legacy, "utf8");
      const isLegacy = /Each line is a fact/i.test(raw) || /^- \(\d{4}-\d{2}-\d{2}\)/m.test(raw);
      if (isLegacy) {
        const existing = readStore("user", ".");
        for (const line of raw.split("\n")) {
          const m = line.match(/^-\s*(?:\(\d{4}-\d{2}-\d{2}\)\s*)?(.+)$/);
          if (!m) continue;
          const fact = m[1]!.trim();
          if (!fact || /^machine:/i.test(fact)) continue; // machine is in Environment
          const keys = tokenize(fact);
          if (!keys.length) continue;
          if (existing.some((r) => jaccard(r.keys, keys) >= 0.6)) continue;
          const now = Date.now();
          existing.push({
            id: newId(),
            text: fact,
            keys: keys.slice(0, 24),
            scope: "user",
            type: "fact",
            salience: 0.4,
            useCount: 0,
            createdAt: now,
            lastUsedAt: now,
          });
        }
        writeStore("user", ".", existing);
      }
    }
  } catch {
    /* migration is best-effort — never block startup */
  }
  try {
    writeFileSync(migratedMarker(), new Date().toISOString());
  } catch {
    /* ignore */
  }
}
