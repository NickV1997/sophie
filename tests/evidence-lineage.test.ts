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

  test("direct user arguments do not inherit unrelated retrieved-data taint", () => {
    const ledger = new TurnEvidenceLedger("Search for TypeScript release notes");
    ledger.record({ content: "untrusted page" }, { source: "web_fetch", trust: "external", sensitivity: "public" });
    const lineage = ledger.lineage({ name: "web_search", arguments: { query: "TypeScript release notes" } });
    expect(lineage.arguments.query).toEqual({ kind: "direct_user" });
    expect(lineage.hasUntrusted).toBe(false);
    expect(lineage.evidenceIds).toEqual([]);
  });

  test("calculator arguments must use the current request's quantities", () => {
    const ledger = new TurnEvidenceLedger("Subtract $64.20 and $38 from $420.");
    expect(ledger.groundingBlock({ name: "calc", arguments: { expression: "2026-09-15" } })).toContain("Grounding block");
    expect(ledger.groundingBlock({ name: "calc", arguments: { expression: "420 - 64.2 - 38" } })).toBeNull();
  });

  test("percentage conversion remains grounded", () => {
    const ledger = new TurnEvidenceLedger("What is 15% of 200?");
    expect(ledger.groundingBlock({ name: "calc", arguments: { expression: "0.15 * 200" } })).toBeNull();
  });
});

  test("draft-only authority is recognized from the direct user request", () => {
  expect(new TurnEvidenceLedger("Draft a text to Sam but do not send it").isDraftOnlyRequest()).toBe(true);
  expect(new TurnEvidenceLedger("Send the approved text to Sam").isDraftOnlyRequest()).toBe(false);
  });

  test("email recipients must be exact current-turn user or source evidence", () => {
    const ledger = new TurnEvidenceLedger("Draft a reply to the recruiter without sending it.");
    ledger.record({ content: "Recruiter <recruiter@acme.example> asked for Thursday." }, { source: "email", trust: "external", sensitivity: "personal" });
    expect(ledger.groundingBlock({ name: "email", arguments: { action: "draft_create", to: ["recruiter@acme.example"] } })).toBeNull();
    expect(ledger.groundingBlock({ name: "email", arguments: { action: "draft_create", to: ["recruiter@acme.com"] } })).toContain("never guess");
  });
