import { describe, expect, test } from "bun:test";
import { TurnEvidenceLedger } from "../src/agent/evidence.ts";
describe("value-level evidence lineage", () => {
  test("links exact argument values to evidence and direct user authority", () => {
    const ledger = new TurnEvidenceLedger("Email Dana at dana@example.com");
    const result: any = { content: "Private report total: $4200" };
    const rec = ledger.record(result, { source: "email", trust: "external", sensitivity: "personal" });
    expect(result.provenance.evidenceId).toBe(rec.id); expect(result.provenance.contentHash).toHaveLength(64);
    const lineage = ledger.lineage({ name: "email", arguments: { to: "dana@example.com", body: "Private report total: $4200" } });
    expect(lineage.arguments.to).toEqual({ kind: "direct_user" });
    expect(lineage.arguments.body).toEqual({ kind: "evidence", evidenceIds: [rec.id] });
    expect(lineage.hasSensitive).toBe(true); expect(lineage.hasUntrusted).toBe(true);
  });
});

test("draft-only authority is recognized from the direct user request", () => {
  expect(new TurnEvidenceLedger("Draft a text to Sam but do not send it").isDraftOnlyRequest()).toBe(true);
  expect(new TurnEvidenceLedger("Send the approved text to Sam").isDraftOnlyRequest()).toBe(false);
});
