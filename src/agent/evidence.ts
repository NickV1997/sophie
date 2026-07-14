import { createHash } from "node:crypto";
import type { ParsedToolCall } from "../llm/tool-protocol.ts";
import type { ResultProvenance, ToolResult } from "../tools/types.ts";
export interface EvidenceRecord { id: string; contentHash: string; provenance: ResultProvenance; content: string; }
export type ArgumentAuthority = { kind: "direct_user" } | { kind: "evidence"; evidenceIds: string[] } | { kind: "derived" };
export interface CallLineage { arguments: Record<string, ArgumentAuthority>; evidenceIds: string[]; hasSensitive: boolean; hasUntrusted: boolean; }
export class TurnEvidenceLedger {
  private records: EvidenceRecord[] = [];
  constructor(private userInput: string) {}
  /** Block calculator calls that ignore the quantities in the current
   * request. This catches context bleed (dates/amounts from older domains)
   * without attempting to solve or rewrite the user's expression. */
  groundingBlock(call: ParsedToolCall): string | null {
    if (call.name === "email" && ["draft_create", "send"].includes(String(call.arguments.action ?? ""))) {
      const recipients = Array.isArray(call.arguments.to) ? call.arguments.to.map(String).map((value) => value.trim()).filter(Boolean) : [];
      const ungrounded = recipients.filter((recipient) =>
        !this.userInput.includes(recipient) && !this.records.some((record) => record.content.includes(recipient))
      );
      if (ungrounded.length) {
        return "[Grounding block: an email recipient was not present in the current request or current-turn source evidence. Re-read inbox/contact evidence and preserve the exact address; never guess or normalize its domain.]";
      }
    }
    if (call.name !== "calc") return null;
    const numbers = (value: string): number[] => [...value.matchAll(/[-+]?(?:\d[\d,]*\.?\d*|\.\d+)/g)]
      .map((match) => Number(match[0]!.replace(/,/g, "")))
      .filter(Number.isFinite);
    const requested = [...new Set(numbers(this.userInput))];
    if (!requested.length) return null;
    const expression = numbers(String(call.arguments.expression ?? ""));
    const matches = requested.filter((source) => expression.some((used) => used === source || used === source / 100)).length;
    const minimum = Math.min(requested.length, 2);
    return matches >= minimum
      ? null
      : `[Grounding block: the calculator expression does not use the quantities in the current user request. Re-read only the current request and retry with the relevant expression.]`;
  }
  isDraftOnlyRequest(): boolean { return /\b(?:draft|prepare|preview|propose)\b/i.test(this.userInput) && /\b(?:do not send|don't send|without sending|draft only)\b/i.test(this.userInput); }
  record(result: ToolResult, provenance: ResultProvenance): EvidenceRecord { const contentHash = createHash("sha256").update(result.content).digest("hex"); const id = `ev-${crypto.randomUUID()}`; const rec = { id, contentHash, provenance: { ...provenance, evidenceId: id, contentHash }, content: result.content }; result.provenance = rec.provenance; this.records.push(rec); return rec; }
  lineage(call: ParsedToolCall): CallLineage { const args: Record<string, ArgumentAuthority> = {}, used = new Set<string>(); let hasDerived = false; for (const [key, raw] of Object.entries(call.arguments)) { const value = typeof raw === "string" ? raw.trim() : JSON.stringify(raw); if (value && this.userInput.includes(value)) { args[key] = { kind: "direct_user" }; continue; } const hits = value ? this.records.filter((r) => r.content.includes(value)).map((r) => r.id) : []; if (hits.length) { args[key] = { kind: "evidence", evidenceIds: hits }; hits.forEach((id) => used.add(id)); } else { args[key] = { kind: "derived" }; hasDerived = true; } } const relevant = used.size ? this.records.filter((r) => used.has(r.id)) : hasDerived ? this.records : []; return { arguments: args, evidenceIds: relevant.map((r) => r.id), hasSensitive: relevant.some((r) => r.provenance.sensitivity !== "public"), hasUntrusted: relevant.some((r) => r.provenance.trust === "external") }; }
}
