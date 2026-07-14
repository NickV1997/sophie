import { describe, expect, test } from "bun:test";
import { approvalArgumentHash, approvalDetails } from "../src/agent/approval.ts";

describe("informed approval details", () => {
  test("shows consequential arguments and binds the complete call", () => {
    const args = { action: "send", to: "dana@example.com", subject: "Launch", body: "Ship at 5" };
    const details = approvalDetails(args);
    expect(details).toContain("dana@example.com");
    expect(details).toContain("Ship at 5");
    expect(details).toContain(approvalArgumentHash(args));
  });

  test("redacts secret-named fields without weakening the argument hash", () => {
    const args = { url: "https://example.test", headers: { Authorization: "Bearer secret" } };
    const details = approvalDetails(args);
    expect(details).not.toContain("Bearer secret");
    expect(details).toContain("REDACTED");
    expect(details).toContain(approvalArgumentHash(args));
  });
});
