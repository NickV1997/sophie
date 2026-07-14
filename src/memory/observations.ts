/**
 * Observation buffer — raw user turns worth learning from, waiting for the
 * extraction pass.
 *
 * Per-turn learning used to be a handful of hardcoded regexes, which could
 * never scale past the topics they were written for. Instead, each substantive
 * user message is appended here (cheap, no model call), and a later extraction
 * pass (see extraction.ts) reads the buffer in one batched LLM call and
 * proposes candidate memories that the runtime gates deterministically.
 *
 * Storage: ~/.sophie/observations.jsonl — one {ts, text} per line, capped so
 * the buffer can never grow unbounded if extraction is unavailable.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writePrivateFileAtomic } from "../system/atomic-file.ts";
import { memoryHomeDir, tokenize } from "./facts.ts";

export interface Observation {
  ts: number;
  text: string;
}

const MAX_BUFFERED = 120;
const MAX_OBSERVATION_CHARS = 500;

function bufferPath(): string {
  return join(memoryHomeDir(), "observations.jsonl");
}

function readBuffer(): Observation[] {
  const path = bufferPath();
  if (!existsSync(path)) return [];
  const out: Observation[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obs = JSON.parse(t) as Observation;
      if (obs && typeof obs.text === "string" && obs.text) out.push(obs);
    } catch {
      /* skip a corrupt line rather than lose the buffer */
    }
  }
  return out;
}

function writeBuffer(observations: Observation[]): void {
  const kept = observations.slice(-MAX_BUFFERED);
  writePrivateFileAtomic(bufferPath(), kept.map((o) => JSON.stringify(o)).join("\n") + (kept.length ? "\n" : ""));
}

/** True for messages that can't teach anything durable about the user. */
function isTrivial(text: string): boolean {
  if (text.length < 24) return true;
  if (text.startsWith("/")) return true; // slash commands
  if (tokenize(text).length < 3) return true;
  // Pure task dispatch ("fix the failing test in foo.ts") is about the moment,
  // not the user — but requests that carry phrasing like "I want / I prefer /
  // always / never" are exactly what extraction feeds on, so keep those.
  return false;
}

/** Buffer one user turn for the next extraction pass. Never throws. */
export function recordObservation(text: string): void {
  try {
    const clean = text.replace(/\s+/g, " ").trim().slice(0, MAX_OBSERVATION_CHARS);
    if (isTrivial(clean)) return;
    const buffer = readBuffer();
    // A verbatim repeat (retries, re-sends) teaches nothing new.
    if (buffer.some((o) => o.text === clean)) return;
    buffer.push({ ts: Date.now(), text: clean });
    writeBuffer(buffer);
  } catch {
    /* observation is best-effort — never break a turn */
  }
}

export function pendingObservationCount(): number {
  return readBuffer().length;
}

/** Hand the buffer to an extraction pass and clear it (the pass owns them now). */
export function takeObservations(limit = MAX_BUFFERED): Observation[] {
  const buffer = readBuffer();
  if (!buffer.length) return [];
  const taken = buffer.slice(0, limit);
  writeBuffer(buffer.slice(taken.length));
  return taken;
}

/** Put observations back (extraction failed before saving anything). */
export function restoreObservations(observations: Observation[]): void {
  if (!observations.length) return;
  try {
    writeBuffer([...observations, ...readBuffer()]);
  } catch {
    /* best effort */
  }
}
