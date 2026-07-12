import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const original = process.env.SOPHIE_HOME;
let home = "";
afterEach(async () => {
  const { resetActivityDbForTests } = await import("../src/system/activity.ts");
  resetActivityDbForTests();
  if (original === undefined) delete process.env.SOPHIE_HOME; else process.env.SOPHIE_HOME = original;
  if (home) rmSync(home, { recursive: true, force: true });
});

describe("unified activity history", () => {
  test("records ordered actions with entity and source metadata", async () => {
    home = mkdtempSync(join(tmpdir(), "sophie-activity-"));
    process.env.SOPHIE_HOME = home;
    const { recordActivity, listActivity } = await import("../src/system/activity.ts");
    recordActivity({ kind: "delivery", source: "schedule", entityType: "delegation", entityId: "del_1", action: "imessage", status: "succeeded", summary: "sent" });
    const rows = listActivity();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "schedule", entityType: "delegation", entityId: "del_1", status: "succeeded" });
  });
});
