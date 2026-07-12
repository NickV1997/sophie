import { describe, expect, test } from "bun:test";
import { platformCapabilitySummary, toolSupportedOnPlatform } from "../src/system/platform-capabilities.ts";

describe("macOS-first capability filtering", () => {
  test("keeps Apple tools on macOS and hides them elsewhere", () => {
    expect(toolSupportedOnPlatform("apple", "darwin")).toBe(true);
    expect(toolSupportedOnPlatform("apple", "linux")).toBe(false);
    expect(toolSupportedOnPlatform("calendar", "linux")).toBe(true);
    expect(platformCapabilitySummary("linux")).toContain("built-in calendar");
  });
});
