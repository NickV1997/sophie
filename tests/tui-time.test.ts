import { describe, expect, test } from "bun:test";
import { formatWorkingElapsed } from "../src/tui/time.ts";

describe("working elapsed timer formatting", () => {
  test("uses seconds before one minute", () => {
    expect(formatWorkingElapsed(0)).toBeNull();
    expect(formatWorkingElapsed(1)).toBe("1s");
    expect(formatWorkingElapsed(59)).toBe("59s");
  });

  test("uses minutes from sixty seconds onward", () => {
    expect(formatWorkingElapsed(60)).toBe("1m");
    expect(formatWorkingElapsed(119)).toBe("1m");
    expect(formatWorkingElapsed(120)).toBe("2m");
  });
});
