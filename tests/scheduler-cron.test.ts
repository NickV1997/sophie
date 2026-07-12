import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nextCronTime, parseCron } from "../src/agent/scheduler.ts";

describe("cron parsing", () => {
  test("rejects malformed expressions", () => {
    expect(parseCron("")).toBeNull();
    expect(parseCron("* * * *")).toBeNull(); // 4 fields
    expect(parseCron("60 * * * *")).toBeNull(); // minute out of range
    expect(parseCron("* 24 * * *")).toBeNull(); // hour out of range
    expect(parseCron("* * * * 8")).toBeNull(); // weekday out of range
    expect(parseCron("*/0 * * * *")).toBeNull(); // zero step
    expect(nextCronTime("nonsense", Date.now())).toBeNull();
  });

  test("accepts wildcards, lists, ranges, and steps", () => {
    expect(parseCron("* * * * *")).not.toBeNull();
    expect(parseCron("0 9 * * 1-5")).not.toBeNull();
    expect(parseCron("*/30 * * * *")).not.toBeNull();
    expect(parseCron("0 0,12 1 */2 *")).not.toBeNull();
    // 7 is a valid alias for Sunday (0).
    expect(parseCron("0 8 * * 7")).not.toBeNull();
  });

  test("nextCronTime finds the next matching minute, strictly after `from`", () => {
    // Mon 2026-07-06 08:30 local. Next weekday-9am should be same day 09:00.
    const from = new Date(2026, 6, 6, 8, 30, 0).getTime();
    const next = nextCronTime("0 9 * * 1-5", from);
    expect(next).not.toBeNull();
    const d = new Date(next!);
    expect(d.getHours()).toBe(9);
    expect(d.getMinutes()).toBe(0);
    expect(d.getDate()).toBe(6);
  });

  test("nextCronTime rolls to the next day when today's time has passed", () => {
    // Mon 09:30 — already past 9am, so next weekday-9am is Tue the 7th.
    const from = new Date(2026, 6, 6, 9, 30, 0).getTime();
    const d = new Date(nextCronTime("0 9 * * 1-5", from)!);
    expect(d.getDate()).toBe(7);
    expect(d.getHours()).toBe(9);
  });

  test("every-30-minutes steps land on :00 and :30", () => {
    const from = new Date(2026, 6, 6, 10, 5, 0).getTime();
    const d = new Date(nextCronTime("*/30 * * * *", from)!);
    expect(d.getMinutes()).toBe(30);
    const d2 = new Date(nextCronTime("*/30 * * * *", d.getTime())!);
    expect(d2.getMinutes()).toBe(0);
    expect(d2.getHours()).toBe(11);
  });

  test("dom-or-dow: either restricted field matching is enough", () => {
    // Fire on the 1st OR any Monday. 2026-07-06 is a Monday.
    const from = new Date(2026, 6, 4, 12, 0, 0).getTime(); // Sat the 4th
    const d = new Date(nextCronTime("0 0 1 * 1", from)!);
    // Next match is Monday the 6th at 00:00 (before the 1st of next month).
    expect(d.getDate()).toBe(6);
    expect(d.getDay()).toBe(1);
  });
});

describe("scheduler delivery acknowledgement", () => {
  test("failed delivery remains due and is retried", () => {
    const home = mkdtempSync(join(tmpdir(), "sophie-scheduler-"));
    try {
      const proc = Bun.spawnSync(["bun", join(import.meta.dir, "fixtures/scheduler-delivery-driver.ts")], {
        env: { ...process.env, HOME: home },
      });
      expect(proc.stderr.toString()).toBe("");
      expect(proc.exitCode).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
