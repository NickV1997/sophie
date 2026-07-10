import { describe, expect, test } from "bun:test";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { systemPrompt } from "../src/agent/prompt.ts";
import { displayPath } from "../src/system/paths.ts";
import { systemReport } from "../src/system/info.ts";

describe("privacy redaction", () => {
  test("displayPath redacts the home directory", () => {
    expect(displayPath(join(homedir(), "Desktop", "sophie"))).toBe("~/Desktop/sophie");
    expect(displayPath(homedir())).toBe("~");
  });

  test("system prompt does not expose the local account name via cwd", () => {
    const prompt = systemPrompt("normal", join(homedir(), "Desktop", "sophie"), "");
    expect(prompt).toContain("Working directory: ~/Desktop/sophie");
    expect(prompt).not.toContain(homedir());
  });

  test("system report redacts local account username and home path", async () => {
    const report = await systemReport();
    expect(report).toContain("User:     (local account name redacted)");
    expect(report).toContain("Home:     ~");
    expect(report).not.toContain(userInfo().username);
    expect(report).not.toContain(homedir());
  });
});
