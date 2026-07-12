import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("SOPHIE_HOME process isolation", () => {
  test("legacy static stores resolve inside the requested profile", async () => {
    const home = mkdtempSync(join(tmpdir(), "sophie-profile-"));
    try {
      const proc = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/storage-home-driver.ts")], { env: { ...process.env, SOPHIE_HOME: home }, stdout: "pipe", stderr: "pipe" });
      const stdout = await new Response(proc.stdout).text(); const stderr = await new Response(proc.stderr).text();
      expect(await proc.exited, stderr).toBe(0);
      const result = JSON.parse(stdout.trim());
      expect(result.memoryDir).toBe(join(home, ".sophie"));
      expect(result.taskFile).toBe(join(home, ".sophie", "tasks.json"));
      expect(result.exists).toBe(true);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
