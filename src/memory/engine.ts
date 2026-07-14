import type { TurnIntent } from "../agent/intent.ts";
import { estimateTokens } from "../agent/context.ts";
import { getCurrentJob, getJournal, getObjective } from "../agent/tasks.ts";
import { addMemory, listMemories, tokenize, type MemoryRecord } from "./facts.ts";
import { MAX_CAPSULE_CHARS, MAX_FULL_CHARS, capsuleFrom, newEngineMemoryId, oneLine, readEngineStore, writeEngineStore } from "./engine_store.ts";
import { recordObservation } from "./observations.ts";

export type EngineMemoryKind =
  | "user"
  | "environment"
  | "sophie"
  | "procedure"
  | "failure"
  | "fact"
  | "preference"
  | "convention";
export type EngineMemoryScope = "global" | "project";
export type EngineMemorySource = "user" | "tool" | "verifier" | "reflection" | "runtime";

export interface EngineMemory {
  id: string;
  kind: EngineMemoryKind;
  scope: EngineMemoryScope;
  capsule: string;
  full: string;
  evidence: string;
  source: EngineMemorySource;
  confidence: number;
  utility: number;
  useCount: number;
  successCount: number;
  failureCount: number;
  keys: string[];
  tags: string[];
  createdAt: number;
  lastUsedAt: number;
  expiresAt?: number;
}

export interface SaveEngineMemoryInput {
  kind: EngineMemoryKind;
  scope?: EngineMemoryScope;
  capsule?: string;
  full: string;
  evidence?: string;
  source?: EngineMemorySource;
  confidence?: number;
  utility?: number;
  successCount?: number;
  failureCount?: number;
  tags?: string[];
  expiresAt?: number;
}

export interface MemoryIntake {
  memories: { capsule: string; scope: EngineMemoryScope; kind: EngineMemoryKind }[];
  summary: string;
}

function jaccard(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const sb = new Set(b);
  const inter = a.filter((x) => sb.has(x)).length;
  return inter / (a.length + b.length - inter);
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

export function resetEngineMemory(cwd?: string): void {
  writeEngineStore("global", cwd ?? ".", []);
  if (cwd) writeEngineStore("project", cwd, []);
}

export function saveEngineMemory(input: SaveEngineMemoryInput, cwd: string): { action: "created" | "merged"; record: EngineMemory } {
  const scope = input.scope ?? (input.kind === "user" || input.kind === "preference" ? "global" : "project");
  const full = oneLine(input.full, MAX_FULL_CHARS);
  const capsule = oneLine(input.capsule ?? capsuleFrom(full), MAX_CAPSULE_CHARS);
  const keys = [...new Set([...tokenize(capsule), ...tokenize(full), ...(input.tags ?? []).flatMap(tokenize)])].slice(0, 40);
  if (!keys.length || capsule.length < 8) {
    throw new Error("memory is too vague to save");
  }
  const records = readEngineStore(scope, cwd);
  const now = Date.now();
  const idx = records.findIndex((r) =>
    r.kind === input.kind &&
    (r.capsule.toLowerCase() === capsule.toLowerCase() || jaccard(r.keys, keys) >= 0.62)
  );
  if (idx >= 0) {
    const prev = records[idx]!;
    const merged: EngineMemory = {
      ...prev,
      capsule,
      full,
      evidence: oneLine(input.evidence ?? prev.evidence, 300),
      source: input.source ?? prev.source,
      confidence: Math.max(prev.confidence, clamp01(input.confidence ?? prev.confidence)),
      utility: Math.max(prev.utility, clamp01(input.utility ?? prev.utility)),
      successCount: prev.successCount + (input.successCount ?? 0),
      failureCount: prev.failureCount + (input.failureCount ?? 0),
      keys: [...new Set([...prev.keys, ...keys])].slice(0, 40),
      tags: [...new Set([...prev.tags, ...(input.tags ?? [])])].slice(0, 16),
      useCount: prev.useCount + 1,
      lastUsedAt: now,
      expiresAt: input.expiresAt ?? prev.expiresAt,
    };
    records[idx] = merged;
    writeEngineStore(scope, cwd, records);
    return { action: "merged", record: merged };
  }
  const record: EngineMemory = {
    id: newEngineMemoryId(),
    kind: input.kind,
    scope,
    capsule,
    full,
    evidence: oneLine(input.evidence ?? "", 300),
    source: input.source ?? "runtime",
    confidence: clamp01(input.confidence ?? 0.65),
    utility: clamp01(input.utility ?? 0.5),
    successCount: input.successCount ?? 0,
    failureCount: input.failureCount ?? 0,
    keys,
    tags: [...new Set(input.tags ?? [])].slice(0, 16),
    useCount: 0,
    createdAt: now,
    lastUsedAt: now,
    expiresAt: input.expiresAt,
  };
  records.push(record);
  writeEngineStore(scope, cwd, records);
  return { action: "created", record };
}

function legacyToEngine(rec: MemoryRecord): EngineMemory {
  const kind: EngineMemoryKind = rec.type === "preference" ? "preference" : rec.type === "convention" ? "convention" : "fact";
  return {
    id: `legacy:${rec.id}`,
    kind,
    scope: rec.scope === "project" ? "project" : "global",
    capsule: oneLine(rec.text),
    full: rec.text,
    evidence: "legacy fact memory",
    source: "runtime",
    confidence: 0.55,
    utility: rec.salience,
    useCount: rec.useCount,
    successCount: 0,
    failureCount: 0,
    keys: rec.keys,
    tags: [],
    createdAt: rec.createdAt,
    lastUsedAt: rec.lastUsedAt,
  };
}

export function listEngineMemories(cwd: string): EngineMemory[] {
  const records = [
    ...readEngineStore("global", cwd),
    ...readEngineStore("project", cwd),
    ...listMemories("user", cwd).map(legacyToEngine),
    ...listMemories("project", cwd).map(legacyToEngine),
  ];
  const seen = new Set<string>();
  return records.filter((r) => {
    const key = `${r.kind}:${r.scope}:${r.capsule.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return !r.expiresAt || r.expiresAt > Date.now();
  });
}

function scoreMemory(rec: EngineMemory, query: string, cwd: string, intent?: TurnIntent): number {
  const q = tokenize(query);
  if (!q.length) return 0;
  const keys = new Set(rec.keys);
  const overlap = q.reduce((n, t) => n + (keys.has(t) ? 1 : 0), 0);
  if (!overlap) return 0;
  const now = Date.now();
  const ageDays = Math.max(0, (now - rec.lastUsedAt) / 86_400_000);
  const recency = Math.exp(-ageDays / 60);
  const usage = Math.log1p(rec.useCount);
  const scopeBoost = rec.scope === "project" ? 0.55 : 0.15;
  const verifiedBoost = rec.source === "verifier" || rec.successCount > 0 ? 0.45 : 0;
  const failureBoost = rec.kind === "failure" && /\b(error|fail|failed|bug|crash|broken|fix|debug|blocked)\b/i.test(query) ? 0.7 : 0;
  const procedureBoost = rec.kind === "procedure" && (intent?.shouldTrackTasks || /\b(build|fix|create|implement|benchmark|test|verify)\b/i.test(query)) ? 0.45 : 0;
  const tokenPenalty = estimateTokens(rec.capsule) * 0.025;
  return (
    overlap * 1.2 +
    rec.confidence * 0.9 +
    rec.utility * 0.9 +
    recency * 0.3 +
    usage * 0.18 +
    scopeBoost +
    verifiedBoost +
    failureBoost +
    procedureBoost -
    tokenPenalty
  );
}

export interface RetrieveOptions {
  maxTokens?: number;
  limit?: number;
  intent?: TurnIntent;
}

export function retrieveEngineMemories(query: string, cwd: string, opts: RetrieveOptions = {}): EngineMemory[] {
  const budget = opts.maxTokens ?? 700;
  const limit = opts.limit ?? 8;
  const scored = listEngineMemories(cwd)
    .map((rec) => ({ rec, score: scoreMemory(rec, query, cwd, opts.intent) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  const selected: EngineMemory[] = [];
  let used = 0;
  const selectedIds = new Set<string>();
  for (const { rec } of scored) {
    if (selected.length >= limit) break;
    const cost = estimateTokens(rec.capsule) + 6;
    if (used + cost > budget && selected.length > 0) continue;
    selected.push(rec);
    selectedIds.add(rec.id);
    used += cost;
  }
  reinforceEngineMemories([...selectedIds], cwd);
  return selected;
}

export function memoryForPrompt(query: string, cwd: string, opts: RetrieveOptions = {}): string {
  const hits = retrieveEngineMemories(query, cwd, opts);
  if (!hits.length) return "";
  const groups: Partial<Record<EngineMemoryKind, EngineMemory[]>> = {};
  for (const h of hits) (groups[h.kind] ??= []).push(h);
  const label: Record<EngineMemoryKind, string> = {
    user: "User",
    preference: "User",
    environment: "Environment",
    sophie: "Sophie",
    procedure: "Procedures",
    failure: "Failure patterns",
    fact: "Facts",
    convention: "Conventions",
  };
  const order: EngineMemoryKind[] = ["user", "preference", "environment", "sophie", "procedure", "failure", "convention", "fact"];
  const lines = ["# Relevant memory"];
  const emitted = new Set<string>();
  for (const kind of order) {
    const rows = groups[kind] ?? [];
    if (!rows.length) continue;
    const head = label[kind];
    if (!emitted.has(head)) {
      lines.push(`${head}:`);
      emitted.add(head);
    }
    for (const r of rows) lines.push(`- ${r.capsule}`);
  }
  return lines.join("\n");
}

function reinforceEngineMemories(ids: string[], cwd: string): void {
  const real = new Set(ids.filter((id) => !id.startsWith("legacy:")));
  if (!real.size) return;
  const now = Date.now();
  for (const scope of ["global", "project"] as EngineMemoryScope[]) {
    const records = readEngineStore(scope, cwd);
    let touched = false;
    for (const rec of records) {
      if (!real.has(rec.id)) continue;
      rec.useCount++;
      rec.lastUsedAt = now;
      touched = true;
    }
    if (touched) writeEngineStore(scope, cwd, records);
  }
}

/**
 * Rewrite one memory's text in place (the webapp memory page edit). The human
 * is the highest authority: the edit re-derives capsule/keys from the new text,
 * marks the record user-sourced, and lifts confidence. Returns null when the
 * id is unknown or the new text is too vague to ever retrieve.
 */
export function updateEngineMemory(id: string, text: string, cwd: string): EngineMemory | null {
  const full = oneLine(text, MAX_FULL_CHARS);
  const capsule = capsuleFrom(full);
  const keys = [...new Set([...tokenize(capsule), ...tokenize(full)])].slice(0, 40);
  if (keys.length < 2 || capsule.length < 8) return null;
  for (const scope of ["global", "project"] as EngineMemoryScope[]) {
    const records = readEngineStore(scope, cwd);
    const idx = records.findIndex((r) => r.id === id);
    if (idx < 0) continue;
    const prev = records[idx]!;
    const updated: EngineMemory = {
      ...prev,
      capsule,
      full,
      // Replace (don't union) keys: the memory now says the NEW thing, and
      // stale keys would keep recalling it for the old topic.
      keys: [...new Set([...keys, ...prev.tags.flatMap(tokenize)])].slice(0, 40),
      source: "user",
      confidence: Math.max(prev.confidence, 0.9),
      evidence: "edited by the user on the memory page",
      lastUsedAt: Date.now(),
    };
    records[idx] = updated;
    writeEngineStore(scope, cwd, records);
    return updated;
  }
  return null;
}

/** Remove one memory by id (the webapp memory page delete). */
export function deleteEngineMemory(id: string, cwd: string): boolean {
  for (const scope of ["global", "project"] as EngineMemoryScope[]) {
    const records = readEngineStore(scope, cwd);
    const next = records.filter((r) => r.id !== id);
    if (next.length !== records.length) {
      writeEngineStore(scope, cwd, next);
      return true;
    }
  }
  return false;
}

/** Split a message into rough sentences for per-sentence preference capture. */
function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 12);
}

/**
 * Durable-preference phrasing, topic-agnostic. We only auto-save when the user
 * SIGNALS durability ("always", "from now on", "I prefer", "I don't want ...")
 * — momentary task talk ("I want you to fix this bug") stays out of memory.
 * Everything subtler is left to the batched extraction pass (extraction.ts),
 * where a model call proposes candidates and the runtime gates them.
 */
function isDurablePreference(sentence: string): boolean {
  if (/\?$/.test(sentence) || /^(?:what|which|when|where|why|how|do|does|did|can|could|would|should|is|are)\b/i.test(sentence)) return false;
  if (/\b(right now|today|this time|for now|just this once|yet)\b/i.test(sentence)) return false;
  return (
    /\b(from now on|going forward|in the future|always|never|every time|whenever)\b/i.test(sentence) ||
    /\bi(?:'d| would)? (?:really )?(?:rather|prefer)\b/i.test(sentence) ||
    /\bi (?:don'?t|do not|never) (?:want|wanna|like|need)\b/i.test(sentence)
  );
}

export function observeUserInputForMemory(input: string, cwd: string): void {
  const text = input.replace(/\s+/g, " ").trim();
  if (!text) return;
  const sentences = sentencesOf(text).slice(0, 6);
  for (let index = 0; index < sentences.length; index++) {
    const sentence = sentences[index]!;
    if (!isDurablePreference(sentence)) continue;
    // A durable negative and its immediately following positive alternative are
    // one preference ("I don't want X. I want Y."); keep both facts together.
    const next = sentences[index + 1];
    const preference = next && /^i (?:really )?(?:want|prefer|would rather)\b/i.test(next) && !/\b(right now|today|this time|for now|just this once)\b/i.test(next)
      ? `${sentence} ${next}`
      : sentence;
    if (preference !== sentence) index++;
    if (tokenize(preference).length < 3) continue; // too vague to ever retrieve
    try {
      saveEngineMemory({
        kind: "preference",
        scope: "global",
        capsule: oneLine(preference, MAX_CAPSULE_CHARS),
        full: preference,
        evidence: oneLine(text, 260),
        source: "user",
        confidence: 0.85,
        utility: 0.75,
        tags: ["preference"],
      }, cwd);
    } catch {
      /* "too vague to save" — fine, the extraction pass may still distill it */
    }
  }
  // Concrete environment facts are regex-safe: an endpoint is an endpoint.
  const endpoint = text.match(/\b(?:0\.0\.0\.0|127\.0\.0\.1|localhost):\d+\/v1\b/i)?.[0];
  if (endpoint) {
    saveEngineMemory({
      kind: "environment",
      scope: "project",
      capsule: `Sophie runtime endpoint observed: ${endpoint}.`,
      full: `The Sophie runtime has been referenced as running at ${endpoint}.`,
      evidence: oneLine(text, 260),
      source: "user",
      confidence: 0.75,
      utility: 0.55,
      tags: ["runtime", "endpoint"],
    }, cwd);
  }
  // Everything substantive also lands in the observation buffer for the
  // batched extraction pass — that's where non-obvious facts get learned.
  recordObservation(text);
}

export function handleMemoryIntake(input: string, cwd: string): MemoryIntake | null {
  const raw = input.trim();
  const text = input.replace(/\s+/g, " ").trim();
  if (!text || /\b(what do you remember|recall|stored memor(y|ies))\b/i.test(text)) return null;
  const isMemoryTurn =
    /(?:^|[.!?]\s+)(?:please\s+)?remember(?:\s*:\s*|\s+(?:that\b|the following\b|project preference\b|preference\b|this\s*:|(?:my|our)\s+rule\s*:))/i.test(text) ||
    /\bkeep this\b.{0,80}\bin mind\b/i.test(text) ||
    /\bsave (?:this|that)\b.{0,40}\b(?:memory|preference|fact|note)\b/i.test(text) ||
    /\bkeep it available for later\b/i.test(text) ||
    /\bimport this\b.{0,80}\b(?:history|context|record)\b/i.test(text);
  if (!isMemoryTurn) return null;

  const saved: MemoryIntake["memories"] = [];
  const save = (fact: string, opts: { kind?: EngineMemoryKind; scope?: EngineMemoryScope; type?: "fact" | "preference" | "convention"; tags?: string[] } = {}) => {
    const clean = oneLine(fact, 500);
    if (clean.length < 8) return;
    const scope = opts.scope ?? (/\b(project|repo|runtime|sophie|operational|benchmark)\b/i.test(clean) ? "project" : "global");
    const type = opts.type ?? (opts.kind === "preference" ? "preference" : opts.kind === "convention" || opts.kind === "procedure" ? "convention" : "fact");
    saveLegacyCompatibleMemory(clean, cwd, { scope: scope === "project" ? "project" : "user", type });
    const kind = opts.kind ?? (type === "preference" ? "preference" : type === "convention" ? "convention" : "fact");
    const capsule = opts.tags?.includes("imported-context") ? oneLine(clean, 320) : capsuleFrom(clean);
    saved.push({ capsule, scope, kind });
  };

  const pref = text.match(/\b(?:project preference|preference)\s*:\s*([^.;]+(?:[.;]|$))/i)?.[1];
  if (pref) save(pref, { kind: "preference", scope: /\bproject preference\b/i.test(text) ? "project" : "global", type: "preference", tags: ["preference"] });

  const codename = text.match(/\bruntime codename\s+(?:is|=)\s+["']?([a-z0-9][a-z0-9 -]{1,80})["']?/i)?.[1];
  if (codename) save(`Runtime codename is ${codename.replace(/[.]+$/, "").trim()}.`, { kind: "environment", scope: "project", tags: ["runtime", "codename"] });

  if (/\bkeep this\b.{0,80}\bin mind\b/i.test(text)) {
    const body = text.includes(":") ? text.slice(text.indexOf(":") + 1).trim() : text;
    save(`Operational note: ${body}`, { kind: "sophie", scope: "project", type: "convention", tags: ["operational-note"] });
  }

  // Structured context imports become precise, independently retrievable
  // facts. Numbered archive filler is intentionally ignored instead of being
  // persisted as one enormous, low-value memory.
  const importedRecords = [...raw.matchAll(/(?:^|\n)\s*(?:\d+\.|Record\s+\d+:)\s*([^\n]+)/gi)]
    .map((match) => match[1]!.trim())
    .filter((line) => line.length >= 8 && line.length <= 700)
    .slice(0, 16);
  for (const record of importedRecords) {
    const preference = /\bprefer|preference|never|private|privacy\b/i.test(record);
    save(record, {
      kind: preference ? "preference" : "fact",
      scope: "global",
      type: preference ? "preference" : "fact",
      tags: ["imported-context"],
    });
  }

  const rememberParts = importedRecords.length ? [] : text
    .replace(/^.*?\bremember(?: this| that| the following| project preference| preference| (?:my|our) rule)?\s*:?\s*/i, "")
    .split(/\b(?:also remember|and also remember)\b|;\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const part of rememberParts) {
    if (pref && part.includes(pref)) continue;
    if (codename && part.toLowerCase().includes("runtime codename")) continue;
    if (part.length > 260 && saved.length) continue;
    save(part.replace(/^that\s+/i, ""), { kind: /\bprefer|preference\b/i.test(part) ? "preference" : "fact" });
  }

  if (!saved.length) return null;
  const unique = new Map(saved.map((m) => [`${m.kind}:${m.scope}:${m.capsule.toLowerCase()}`, m]));
  const memories = [...unique.values()].slice(0, 16);
  return {
    memories,
    summary: `Saved ${memories.length} compact memor${memories.length === 1 ? "y" : "ies"}: ${memories.map((m) => m.capsule).join("; ")}`,
  };
}

function saveLegacyCompatibleMemory(
  fact: string,
  cwd: string,
  opts: { scope?: "user" | "project"; type?: "fact" | "preference" | "convention" } = {},
): { action: "created" | "merged"; record: MemoryRecord } {
  const result = addMemory(fact, cwd, opts);
  saveEngineMemory({
    kind: opts.type === "preference" ? "preference" : opts.type === "convention" ? "convention" : "fact",
    scope: opts.scope === "project" ? "project" : "global",
    full: fact,
    evidence: "explicit memory intake",
    source: "user",
    confidence: 0.8,
    utility: opts.type === "preference" ? 0.75 : 0.6,
  }, cwd);
  return result;
}

export function learnFromRuntimeEvidence(cwd: string): void {
  const job = getCurrentJob();
  const objective = getObjective();
  const journal = job ? getJournal().filter((j) => j.jobId === job.id) : getJournal().slice(-80);
  const verifierPass = [...journal].reverse().find((j) => j.kind === "verification" && !j.isError);
  const untrustedTools = new Set(["web_search", "web_fetch", "email", "apple", "read_document", "browser_check", "browser_act", "http_request"]);
  const errors = journal.filter((j) => j.isError && (!j.tool || (!untrustedTools.has(j.tool) && !j.tool.startsWith("mcp__"))));
  if (job?.status === "completed" && verifierPass) {
    const commands = journal
      .filter((j) => j.tool && ["project_checks", "verify_project", "verify_next_app", "verify_python_project", "verify_static_site", "verify_package_install", "bash"].includes(j.tool))
      .map((j) => j.tool)
      .filter((v, i, a) => a.indexOf(v) === i)
      .slice(0, 5);
    saveEngineMemory({
      kind: "procedure",
      scope: "project",
      capsule: `For similar tasks in this repo, use ${commands.join(" -> ") || verifierPass.tool} and require a passing verifier before completion.`,
      full: `Completed task "${job.title}" with verifier evidence: ${verifierPass.summary}. Useful tools/checks: ${commands.join(", ") || verifierPass.tool}.`,
      evidence: verifierPass.evidence ?? verifierPass.summary,
      source: "verifier",
      confidence: 0.85,
      utility: 0.75,
      successCount: 1,
      tags: ["procedure", "verified", ...(commands as string[])],
    }, cwd);
  }
  const latestError = errors.at(-1);
  if (latestError && verifierPass && (job?.status === "completed" || objective?.status === "completed")) {
    saveEngineMemory({
      kind: "failure",
      scope: "project",
      capsule: `If ${latestError.tool ?? "a tool"} fails with "${oneLine(latestError.summary, 70)}", fix the root cause then rerun verifier until PASS.`,
      full: `During "${job?.title ?? objective?.content ?? "a task"}", ${latestError.tool ?? latestError.kind} failed: ${latestError.summary}. Later verifier passed: ${verifierPass.summary}.`,
      evidence: latestError.evidence ?? latestError.summary,
      source: "verifier",
      confidence: 0.8,
      utility: 0.7,
      successCount: 1,
      failureCount: 1,
      tags: ["failure", latestError.tool ?? "tool", verifierPass.tool ?? "verifier"],
    }, cwd);
  }
}

export function saveExplicitMemory(
  fact: string,
  cwd: string,
  opts: { scope?: "user" | "project"; type?: "fact" | "preference" | "convention" } = {},
): { action: "created" | "merged"; record: MemoryRecord } {
  return saveLegacyCompatibleMemory(fact, cwd, opts);
}
