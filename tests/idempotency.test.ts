import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
let home = ""; const old = process.env.SOPHIE_HOME;
afterEach(async () => { const { resetIdempotencyForTests } = await import("../src/system/idempotency.ts"); resetIdempotencyForTests(); if (old === undefined) delete process.env.SOPHIE_HOME; else process.env.SOPHIE_HOME = old; if (home) rmSync(home, { recursive: true, force: true }); });
describe("durable side-effect idempotency", () => {
  test("binds an exact call to an operation and preserves completion", async () => { home = mkdtempSync(join(tmpdir(), "sophie-idem-")); process.env.SOPHIE_HOME = home; const { operationKey, operationState, startOperation, finishOperation } = await import("../src/system/idempotency.ts"); const key = operationKey("work-1", "notify", { message: "x" }); expect(startOperation(key)).toBe(true); expect(startOperation(key)).toBe(false); finishOperation(key, "completed", "sent"); expect(operationState(key)).toEqual({ state: "completed", result: "sent" }); expect(operationKey("work-2", "notify", { message: "x" })).not.toBe(key); });
});
