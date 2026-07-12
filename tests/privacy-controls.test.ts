import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("privacy controls", () => {
  test("inventory/export excludes credentials and scoped deletion stays scoped", async () => {
    const home = mkdtempSync(join(tmpdir(), "sophie-privacy-"));
    const out = mkdtempSync(join(tmpdir(), "sophie-export-"));
    const previous = process.env.SOPHIE_HOME;
    try {
      process.env.SOPHIE_HOME = home;
      const root = join(home, ".sophie");
      mkdirSync(root, { recursive: true });
      await Bun.write(join(root, "profile.json"), '{"name":"A"}');
      await Bun.write(join(root, "calendar.json"), '{"events":[]}');
      await Bun.write(join(root, ".env"), "TOKEN=secret");
      const { privacyInventory, exportPrivateState, deletePrivateCategory } = await import("../src/system/privacy.ts");
      expect(privacyInventory().find((x) => x.category === "profile")?.files).toBe(1);
      const exported = exportPrivateState(out);
      expect(existsSync(join(exported, "profile.json"))).toBe(true);
      expect(existsSync(join(exported, ".env"))).toBe(false);
      expect(readFileSync(join(exported, "manifest.json"), "utf8")).toContain("credentials");
      expect(deletePrivateCategory("profile")).toBe(1);
      expect(existsSync(join(root, "calendar.json"))).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.SOPHIE_HOME; else process.env.SOPHIE_HOME = previous;
      rmSync(home, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true });
    }
  });
});
