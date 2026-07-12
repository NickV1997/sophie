import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJsonWithRecovery, setAtomicWriteFaultInjector, writePrivateFileAtomic } from "../src/system/atomic-file.ts";

describe("durable private state files", () => {
  test("writes atomically with private permissions and a recoverable backup", () => {
    const dir = mkdtempSync(join(tmpdir(), "sophie-atomic-"));
    const path = join(dir, "state.json");
    try {
      writePrivateFileAtomic(path, '{"value":1}\n');
      writePrivateFileAtomic(path, '{"value":2}\n');
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readFileSync(`${path}.bak`, "utf8")).toContain('"value":1');
      writeFileSync(path, "{broken");
      expect(readJsonWithRecovery<{ value: number }>(path)?.value).toBe(1);
      expect(readFileSync(path, "utf8")).toContain('"value":1');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("quarantines unrecoverable corruption", () => {
    const dir = mkdtempSync(join(tmpdir(), "sophie-corrupt-"));
    const path = join(dir, "state.json");
    try {
      writeFileSync(path, "not json"); chmodSync(path, 0o600);
      expect(readJsonWithRecovery(path)).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test.each(["after_fsync_temp", "after_backup"] as const)("preserves the previous value when a write crashes at %s", (stage) => {
    const dir = mkdtempSync(join(tmpdir(), "sophie-crash-"));
    const path = join(dir, "state.json");
    try {
      writePrivateFileAtomic(path, '{"value":1}\n');
      setAtomicWriteFaultInjector((point) => { if (point === stage) throw new Error("simulated crash"); });
      expect(() => writePrivateFileAtomic(path, '{"value":2}\n')).toThrow("simulated crash");
      expect(readJsonWithRecovery<{ value: number }>(path)?.value).toBe(1);
    } finally { setAtomicWriteFaultInjector(); rmSync(dir, { recursive: true, force: true }); }
  });

  test("a crash after rename exposes the complete new value", () => {
    const dir = mkdtempSync(join(tmpdir(), "sophie-crash-renamed-"));
    const path = join(dir, "state.json");
    try {
      writePrivateFileAtomic(path, '{"value":1}\n');
      setAtomicWriteFaultInjector((point) => { if (point === "after_rename") throw new Error("simulated crash"); });
      expect(() => writePrivateFileAtomic(path, '{"value":2}\n')).toThrow();
      expect(readJsonWithRecovery<{ value: number }>(path)?.value).toBe(2);
    } finally { setAtomicWriteFaultInjector(); rmSync(dir, { recursive: true, force: true }); }
  });
});
