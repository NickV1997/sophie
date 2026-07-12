import { createHash } from "node:crypto";
import type { ParsedToolCall } from "../llm/tool-protocol.ts";
import type { ResultProvenance, ToolResult } from "../tools/types.ts";
export interface EvidenceRecord { id: string; contentHash: string; provenance: ResultProvenance; content: string; }
export type ArgumentAuthority = { kind: "direct_user" } | { kind: "evidence"; evidenceIds: string[] } | { kind: "derived" };
export interface CallLineage { arguments: Record<string, ArgumentAuthority>; evidenceIds: string[]; hasSensitive: boolean; hasUntrusted: boolean; }
export class TurnEvidenceLedger {
  private records: EvidenceRecord[] = [];
  constructor(private userInput: string) {}
  isDraftOnlyRequest(): boolean { return /\b(?:draft|prepare|preview|propose)\b/i.test(this.userInput) && /\b(?:do not send|don't send|without sending|draft only)\b/i.test(this.userInput); }
  record(result: ToolResult, provenance: ResultProvenance): EvidenceRecord { const contentHash = createHash("sha256").update(result.content).digest("hex"); const id = `ev-${crypto.randomUUID()}`; const rec = { id, contentHash, provenance: { ...provenance, evidenceId: id, contentHash }, content: result.content }; result.provenance = rec.provenance; this.records.push(rec); return rec; }
  lineage(call: ParsedToolCall): CallLineage { const args: Record<string, ArgumentAuthority> = {}, used = new Set<string>(); for (const [key, raw] of Object.entries(call.arguments)) { const value = typeof raw === "string" ? raw.trim() : JSON.stringify(raw); if (value && this.userInput.includes(value)) { args[key] = { kind: "direct_user" }; continue; } const hits = value ? this.records.filter((r) => r.content.includes(value)).map((r) => r.id) : []; if (hits.length) { args[key] = { kind: "evidence", evidenceIds: hits }; hits.forEach((id) => used.add(id)); } else args[key] = { kind: "derived" }; } const relevant = used.size ? this.records.filter((r) => used.has(r.id)) : this.records; return { arguments: args, evidenceIds: relevant.map((r) => r.id), hasSensitive: relevant.some((r) => r.provenance.sensitivity !== "public"), hasUntrusted: relevant.some((r) => r.provenance.trust === "external") }; }
}
