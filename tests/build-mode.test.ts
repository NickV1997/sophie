import { describe, expect, test } from "bun:test";
import { gate } from "../src/agent/safety.ts";
import { getMode, setMode } from "../src/agent/mode.ts";
import { BUILD_MODE_TOOLS, PLAN_MODE_TOOLS, getTool, toolSpecs } from "../src/tools/registry.ts";

describe("build mode", () => {
  test("external coding delegation tool is not registered", () => {
    const names = new Set(toolSpecs().map((t) => t.name));
    expect(names.has("delegate_coding_task")).toBe(false);
    expect(getTool("delegate_coding_task")).toBeUndefined();
  });

  test("setMode supports build mode", () => {
    setMode("build");
    expect(getMode()).toBe("build");
    setMode("normal");
  });

  test("build mode allows local coding tools and verifiers", () => {
    const write = getTool("write_file");
    const bash = getTool("bash");
    const verify = getTool("verify_project");
    expect(write).toBeTruthy();
    expect(bash).toBeTruthy();
    expect(verify).toBeTruthy();

    expect(gate(write!, { path: "app.ts", content: "x" }, "build").decision).not.toBe("block");
    expect(gate(bash!, { command: "npm test" }, "build").decision).not.toBe("block");
    expect(gate(verify!, { path: "." }, "build").decision).not.toBe("block");
    expect(BUILD_MODE_TOOLS.has("bash")).toBe(true);
  });

  test("plan mode exposes read-only query tools instead of mutating assistant tools", () => {
    const calendar = getTool("calendar");
    const schedule = getTool("schedule");
    const calendarList = getTool("calendar_list");
    const calendarFindFree = getTool("calendar_find_free");
    const scheduleList = getTool("schedule_list");
    expect(calendar).toBeTruthy();
    expect(schedule).toBeTruthy();
    expect(calendarList).toBeTruthy();
    expect(calendarFindFree).toBeTruthy();
    expect(scheduleList).toBeTruthy();

    expect(gate(calendar!, { action: "add", title: "x", start: "tomorrow 09:00" }, "plan").decision).toBe("block");
    expect(gate(schedule!, { action: "add", message: "x", in_minutes: 10 }, "plan").decision).toBe("block");
    expect(gate(calendarList!, { range: "week" }, "plan").decision).toBe("run");
    expect(gate(calendarFindFree!, { range: "week", duration_minutes: 30 }, "plan").decision).toBe("run");
    expect(gate(scheduleList!, {}, "plan").decision).toBe("run");
    expect(PLAN_MODE_TOOLS.has("calendar")).toBe(false);
    expect(PLAN_MODE_TOOLS.has("calendar_list")).toBe(true);
  });
});
