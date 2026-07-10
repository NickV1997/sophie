import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWhen } from "../src/tools/calendar.ts";

describe("calendar time parsing", () => {
  test("absolute date-time parses as local", () => {
    const ts = parseWhen("2030-07-02 14:00")!;
    const d = new Date(ts);
    expect(d.getFullYear()).toBe(2030);
    expect(d.getMonth()).toBe(6);
    expect(d.getDate()).toBe(2);
    expect(d.getHours()).toBe(14);
  });

  test("date-only resolves to 09:00 local (not UTC midnight)", () => {
    const d = new Date(parseWhen("2030-07-03")!);
    expect(d.getDate()).toBe(3);
    expect(d.getHours()).toBe(9);
  });

  test("bare HH:MM is the next occurrence (always future)", () => {
    const ts = parseWhen("00:01")!;
    expect(ts).toBeGreaterThan(Date.now());
    const d = new Date(ts);
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(1);
  });

  test("today/tomorrow with optional time", () => {
    const tom = new Date(parseWhen("tomorrow 09:30")!);
    const expected = new Date();
    expected.setDate(expected.getDate() + 1);
    expect(tom.getDate()).toBe(expected.getDate());
    expect(tom.getHours()).toBe(9);
    expect(tom.getMinutes()).toBe(30);
    expect(new Date(parseWhen("tomorrow")!).getHours()).toBe(9);
  });

  test("garbage returns null", () => {
    expect(parseWhen("whenever")).toBeNull();
    expect(parseWhen("")).toBeNull();
  });
});

// The store writes to MEMORY_DIR (~/.sophie), which is resolved from homedir()
// at module load — so the end-to-end behavior (add → reminders in the
// scheduler, conflicts, find_free, reschedule moves reminders, cancel removes
// them) runs in a subprocess with an isolated HOME.
describe("calendar store + tool (isolated subprocess)", () => {
  test("driver passes all end-to-end checks", () => {
    const home = mkdtempSync(join(tmpdir(), "sophie-cal-"));
    try {
      const proc = Bun.spawnSync(["bun", join(import.meta.dir, "fixtures/calendar-driver.ts")], {
        env: { ...process.env, HOME: home, SOPHIE_APPLE_CALENDAR_SYNC: "0" },
      });
      const out = proc.stdout.toString() + proc.stderr.toString();
      const failed = out.split("\n").filter((l) => l.startsWith("FAIL"));
      expect(failed).toEqual([]);
      expect(proc.exitCode).toBe(0);
      expect(out).toContain("PASS add ok");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);
});
