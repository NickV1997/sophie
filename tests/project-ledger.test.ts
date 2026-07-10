import { afterEach, describe, expect, test } from "bun:test";
import {
  projectLedgerForPrompt,
  recordLedgerCommand,
  recordLedgerDecision,
  recordLedgerFile,
  resetProjectLedger,
} from "../src/agent/project_ledger.ts";

afterEach(() => resetProjectLedger());

describe("project ledger", () => {
  test("renders exact files, verifier results, and decisions compactly", () => {
    const cwd = "/tmp/sophie-ledger";
    recordLedgerFile(`${cwd}/src/app.tsx`, "read");
    recordLedgerFile(`${cwd}/src/app.tsx`, "edited");
    recordLedgerCommand({
      tool: "verify_next_app",
      kind: "verifier",
      status: "failed",
      summary: "Type error in src/app.tsx:12",
    });
    recordLedgerCommand({
      tool: "bash",
      command: "bun test",
      kind: "verifier",
      status: "passed",
      summary: "247 pass, 0 fail",
    });
    recordLedgerDecision("Use the static-site verifier for the portfolio artifact.");

    const prompt = projectLedgerForPrompt(cwd);
    expect(prompt).toContain("edited: src/app.tsx");
    expect(prompt).toContain("verifier failed: verify_next_app");
    expect(prompt).toContain("verifier passed: bash bun test");
    expect(prompt).toContain("247 pass, 0 fail");
    expect(prompt).toContain("static-site verifier");
  });
});
