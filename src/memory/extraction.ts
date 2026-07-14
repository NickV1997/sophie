/**
 * Batched memory extraction — the scalable replacement for per-topic regexes.
 *
 * Buffered user turns (observations.ts) are handed to the local model in ONE
 * small call, which proposes candidate memories in a strict line format. The
 * model only PROPOSES; the runtime remains the gatekeeper: candidates are
 * parsed strictly, checked against a kind whitelist and length bounds, must
 * share vocabulary with the actual observations (anti-hallucination), are
 * deduped, capped, and finally saved through the normal merge-not-append path.
 *
 * This keeps the division of labor Sophie is built on: the model supplies
 * judgment ("that aside about hating light-mode terminals is worth keeping"),
 * the runtime supplies discipline (what's storable, how much, in what shape).
 *
 * Fire-and-forget from turn upkeep; failures restore the buffer and are
 * swallowed — extraction must never break a reply.
 */
import { completeChat } from "../llm/client.ts";
import { stripThink } from "../agent/context.ts";
import { addJournalEntry } from "../agent/tasks.ts";
import { saveEngineMemory, type EngineMemoryKind, type EngineMemoryScope } from "./engine.ts";
import { tokenize } from "./facts.ts";
import { restoreObservations, takeObservations, type Observation } from "./observations.ts";

export interface MemoryCandidate {
  kind: EngineMemoryKind;
  scope: EngineMemoryScope;
  text: string;
}

export interface ExtractionReport {
  observations: number;
  proposed: number;
  saved: number;
  capsules: string[];
}

/** Kinds the model may propose — procedures/failures only come from verified runtime evidence. */
const EXTRACTABLE_KINDS = new Set<EngineMemoryKind>(["user", "preference", "fact", "environment", "convention"]);
const MAX_SAVED_PER_PASS = 5;
const MIN_TEXT_CHARS = 16;
const MAX_TEXT_CHARS = 240;

/** Strict line format: `MEMORY kind=<kind> scope=<global|project>: <sentence>`. */
export function parseCandidates(reply: string): MemoryCandidate[] {
  const out: MemoryCandidate[] = [];
  for (const line of stripThink(reply).split("\n")) {
    const m = line.trim().match(/^MEMORY\s+kind=([a-z]+)\s+scope=(global|project)\s*:\s*(.+)$/i);
    if (!m) continue;
    const kind = m[1]!.toLowerCase() as EngineMemoryKind;
    if (!EXTRACTABLE_KINDS.has(kind)) continue;
    const text = m[3]!.replace(/\s+/g, " ").trim();
    out.push({ kind, scope: m[2]!.toLowerCase() as EngineMemoryScope, text });
  }
  return out;
}

/**
 * Deterministic gate between the model's proposals and the store. A candidate
 * survives only if it is well-sized, retrievable (enough key tokens), grounded
 * in what the user actually said (≥40% of its key tokens appear in the
 * observations), and not a repeat of an earlier candidate this pass.
 */
export function gateCandidates(candidates: MemoryCandidate[], observations: Observation[]): MemoryCandidate[] {
  const observed = new Set(observations.flatMap((o) => tokenize(o.text)));
  const kept: MemoryCandidate[] = [];
  const seen: string[][] = [];
  for (const c of candidates) {
    if (kept.length >= MAX_SAVED_PER_PASS) break;
    if (c.text.length < MIN_TEXT_CHARS || c.text.length > MAX_TEXT_CHARS) continue;
    const keys = tokenize(c.text);
    if (keys.length < 3) continue;
    const grounded = keys.filter((k) => observed.has(k)).length;
    if (grounded / keys.length < 0.4) continue;
    if (seen.some((prev) => jaccard(prev, keys) >= 0.6)) continue;
    seen.push(keys);
    kept.push(c);
  }
  return kept;
}

function jaccard(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const sb = new Set(b);
  const inter = a.filter((x) => sb.has(x)).length;
  return inter / (a.length + b.length - inter);
}

function extractionPrompt(observations: Observation[]): { role: "system" | "user"; content: string }[] {
  const lines = observations.map((o, i) => `${i + 1}. ${o.text}`);
  return [
    {
      role: "system",
      content:
        "You distill durable memories about a user from their recent messages to their assistant. " +
        "Only keep what will still matter in a month: stable preferences, facts about the user or their " +
        "environment, and working conventions. NEVER keep one-off task requests, questions, or anything " +
        "you are not sure the user actually said. Reply with 0-5 lines, each exactly:\n" +
        "MEMORY kind=<user|preference|fact|environment|convention> scope=<global|project>: <one clear sentence>\n" +
        "scope=project only for facts tied to the current repo/workspace. " +
        "If nothing is worth keeping, reply exactly: NONE. No other text. /no_think",
    },
    { role: "user", content: `Recent user messages:\n${lines.join("\n")}` },
  ];
}

/**
 * Run one extraction pass if enough observations are buffered. Takes the
 * buffer, proposes, gates, saves. On model failure the buffer is restored so
 * nothing the user said is lost. Returns null when skipped or failed.
 */
export async function runExtractionPass(cwd: string, opts: { minObservations?: number } = {}): Promise<ExtractionReport | null> {
  const min = opts.minObservations ?? 8;
  const observations = takeObservations();
  if (observations.length < min) {
    restoreObservations(observations);
    return null;
  }
  let reply: string;
  try {
    reply = await completeChat(extractionPrompt(observations), { temperature: 0.2, maxTokens: 500, thinking: "off" });
  } catch {
    restoreObservations(observations);
    return null;
  }
  const proposed = parseCandidates(reply);
  const kept = gateCandidates(proposed, observations);
  const capsules: string[] = [];
  for (const c of kept) {
    try {
      const { record } = saveEngineMemory({
        kind: c.kind,
        scope: c.scope,
        full: c.text,
        evidence: `extracted from ${observations.length} recent user messages`,
        source: "reflection",
        confidence: 0.6,
        utility: 0.6,
        tags: ["extracted"],
      }, cwd);
      capsules.push(record.capsule);
    } catch {
      /* one vague candidate must not sink the pass */
    }
  }
  if (capsules.length) {
    addJournalEntry({
      kind: "decision",
      summary: `Extraction pass distilled ${capsules.length} memor${capsules.length === 1 ? "y" : "ies"} from ${observations.length} observations.`,
      evidence: capsules.join("; ").slice(0, 300),
    });
  }
  return { observations: observations.length, proposed: proposed.length, saved: capsules.length, capsules };
}
