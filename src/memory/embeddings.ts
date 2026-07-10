/**
 * Semantic memory retrieval — the upgrade that makes "what did I say about
 * that restaurant" find "the Italian place".
 *
 * Facts are embedded through an OpenAI-compatible /embeddings endpoint
 * (llama.cpp with --embeddings, Ollama, LM Studio; SOPHIE_EMBEDDINGS_URL /
 * _MODEL override the main server). Vectors are cached beside each store
 * (memory.vec.json, keyed by record id + a hash of model+text), so each fact
 * is embedded once, ever. Recall = cosine over the cached vectors, blended
 * with the keyword score so exact-term matches still win ties.
 *
 * Everything degrades gracefully: the first failed embeddings request latches
 * the feature off for the session and recall silently falls back to the
 * keyword path. The store itself is small (hundreds of one-line facts), so
 * brute-force cosine is exact and effectively free — no native index needed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "../config.ts";
import { fetchWithTimeout } from "../system/net.ts";
import {
  listMemories,
  memoryHomeDir,
  type MemoryRecord,
  type MemoryScope,
  recallMemories,
  reinforceMemories,
  tokenize,
} from "./facts.ts";
import { memoryForPrompt } from "./engine.ts";

/** Below this cosine similarity a fact is considered unrelated to the query. */
const MIN_SIMILARITY = 0.35;
/** Max facts embedded per recall — the rest catch up on later turns. */
const EMBED_BATCH = 64;

let unavailable = false;

/** Test/setup-wizard helper: forget the "server has no embeddings" latch. */
export function resetEmbeddingsLatch(): void {
  unavailable = false;
}

export function embeddingsAvailable(): boolean {
  return config.embeddings && !unavailable;
}

async function embedTexts(texts: string[], signal?: AbortSignal): Promise<number[][] | null> {
  if (!embeddingsAvailable() || !texts.length) return null;
  try {
    const res = await fetchWithTimeout(`${config.embeddingsUrl}/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({ model: config.embeddingsModel, input: texts }),
      signal,
      timeoutMs: 20_000,
    });
    if (!res.ok) {
      unavailable = true;
      return null;
    }
    const json: any = await res.json();
    const data: any[] = Array.isArray(json?.data) ? json.data : [];
    if (data.length !== texts.length) {
      unavailable = true;
      return null;
    }
    data.sort((a, b) => (a?.index ?? 0) - (b?.index ?? 0));
    const vectors = data.map((d) => d?.embedding as number[]);
    if (vectors.some((v) => !Array.isArray(v) || !v.length)) {
      unavailable = true;
      return null;
    }
    return vectors;
  } catch {
    unavailable = true;
    return null;
  }
}

// ── vector cache (one json beside each store) ─────────────────────────────

interface VecEntry {
  /** Hash of model + text; a changed fact or model re-embeds. */
  h: string;
  v: number[];
}
type VecCache = Record<string, VecEntry>;

function cachePath(scope: MemoryScope, cwd: string): string {
  return scope === "project" ? join(cwd, ".sophie", "memory.vec.json") : join(memoryHomeDir(), "memory.vec.json");
}

function textHash(text: string): string {
  return Bun.hash(`${config.embeddingsModel}\0${text}`).toString(36);
}

function readCache(scope: MemoryScope, cwd: string): VecCache {
  const path = cachePath(scope, cwd);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as VecCache) : {};
  } catch {
    return {};
  }
}

function writeCache(scope: MemoryScope, cwd: string, cache: VecCache): void {
  const path = cachePath(scope, cwd);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cache));
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

// ── recall ────────────────────────────────────────────────────────────────

/**
 * Semantic recall across user + project memory. Returns null when embeddings
 * are unavailable (caller falls back to keyword recall), [] when nothing is
 * relevant. Reinforces what it surfaces, like the keyword path.
 */
export async function semanticRecall(
  query: string,
  cwd: string,
  limit = 4,
  signal?: AbortSignal,
): Promise<MemoryRecord[] | null> {
  if (!embeddingsAvailable()) return null;
  const scopes: MemoryScope[] = ["user", "project"];
  const all: { rec: MemoryRecord; scope: MemoryScope }[] = [];
  for (const scope of scopes) for (const rec of listMemories(scope, cwd)) all.push({ rec, scope });
  if (!all.length) return [];

  // Top up the vector caches for new/changed facts (bounded per turn).
  const caches: Record<MemoryScope, VecCache> = {
    user: readCache("user", cwd),
    project: readCache("project", cwd),
  };
  const missing = all
    .filter(({ rec, scope }) => caches[scope][rec.id]?.h !== textHash(rec.text))
    .slice(0, EMBED_BATCH);
  if (missing.length) {
    const vectors = await embedTexts(missing.map((m) => m.rec.text), signal);
    if (!vectors) return null;
    const touched = new Set<MemoryScope>();
    missing.forEach(({ rec, scope }, i) => {
      caches[scope][rec.id] = { h: textHash(rec.text), v: vectors[i]! };
      touched.add(scope);
    });
    for (const scope of touched) writeCache(scope, cwd, caches[scope]);
  }

  const queryVectors = await embedTexts([query], signal);
  if (!queryVectors) return null;
  const qv = queryVectors[0]!;

  // Cosine, with a small keyword-overlap bonus so exact terms still win ties.
  const queryTokens = new Set(tokenize(query));
  const scored: { rec: MemoryRecord; s: number }[] = [];
  for (const { rec, scope } of all) {
    const entry = caches[scope][rec.id];
    if (!entry) continue; // beyond this turn's embed budget — next turn
    const overlap = rec.keys.reduce((n, k) => n + (queryTokens.has(k) ? 1 : 0), 0);
    const s = cosine(qv, entry.v) + 0.03 * Math.min(overlap, 4);
    if (s >= MIN_SIMILARITY) scored.push({ rec, s });
  }
  scored.sort((a, b) => b.s - a.s);
  const top = scored.slice(0, limit).map((t) => t.rec);
  reinforceMemories(top.map((t) => t.id), cwd);
  return top;
}

/**
 * The per-turn recall used by the agent: semantic when available, keyword
 * otherwise. Formatted for the ephemeral live-state message; "" = no matches.
 */
export async function smartRecallForPrompt(query: string, cwd: string, limit = 4): Promise<string> {
  const engineBlock = memoryForPrompt(query, cwd, { limit, maxTokens: limit <= 4 ? 550 : 900 });
  if (engineBlock) return engineBlock;
  let hits = await semanticRecall(query, cwd, limit);
  if (hits === null) hits = recallMemories(query, cwd, limit);
  if (!hits.length) return "";
  return ["# Relevant memory (retrieved for this message)", ...hits.map((h) => `- ${h.text}`)].join("\n");
}

/** For the explicit recall tool: semantic search with keyword fallback. */
export async function smartRecall(query: string, cwd: string, limit = 6): Promise<MemoryRecord[]> {
  const hits = await semanticRecall(query, cwd, limit);
  return hits === null ? recallMemories(query, cwd, limit) : hits;
}
