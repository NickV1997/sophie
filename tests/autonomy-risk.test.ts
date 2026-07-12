import { describe, expect, test } from "bun:test";
import { calendar } from "../src/tools/calendar.ts";
import { schedule } from "../src/tools/schedule.ts";
import { watchPath } from "../src/tools/watch.ts";

describe("autonomous and external-state risk policy", () => {
  test("calendar reads are safe but mutations require approval", () => {
    expect(calendar.risk({ action: "list" })).toBe("safe");
    expect(calendar.risk({ action: "find_free" })).toBe("safe");
    expect(calendar.risk({ action: "add" })).toBe("caution");
    expect(calendar.risk({ action: "cancel" })).toBe("caution");
  });

  test("plain reminders stay easy but future agent runs require approval", () => {
    expect(schedule.risk({ action: "add", do: "notify" })).toBe("safe");
    expect(schedule.risk({ action: "add", do: "run" })).toBe("caution");
    expect(watchPath.risk({ action: "add", do: "notify" })).toBe("safe");
    expect(watchPath.risk({ action: "add", do: "run" })).toBe("caution");
  });
});
