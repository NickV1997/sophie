import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const old = process.env.SOPHIE_HOME; let home = "";
afterEach(() => { if (old === undefined) delete process.env.SOPHIE_HOME; else process.env.SOPHIE_HOME = old; if (home) rmSync(home, { recursive: true, force: true }); });

describe("durable daemon queue", () => {
  test("persists ordered work and transitions", async () => {
    home = mkdtempSync(join(tmpdir(), "sophie-queue-")); process.env.SOPHIE_HOME = home;
    const { approveWork, claimWork, enqueueWork, nextWork, updateWork, listWork } = await import("../src/daemon/queue.ts");
    const a = enqueueWork({ source: "schedule", title: "A", prompt: "check A" });
    enqueueWork({ source: "watcher", title: "B", prompt: "check B" });
    expect(nextWork()?.id).toBe(a.id);
    updateWork(a.id, { status: "completed", result: "done" });
    expect(nextWork()?.title).toBe("B");
    expect(listWork()[0]?.result).toBe("done");
    const b = nextWork()!;
    updateWork(b.id, { status: "awaiting_approval", pendingApproval: { name: "notify", args: { message: "x" }, summary: "notify x", signature: 'notify:{"message":"x"}' } });
    expect(approveWork(b.id)?.approvedSignature).toBe('notify:{"message":"x"}');
    expect(nextWork()?.id).toBe(b.id);
    const claimed = claimWork("test-worker", 1000)!;
    expect(claimed.leaseOwner).toBe("test-worker");
    expect(nextWork()).toBeUndefined();
  });

  test("reclaims expired leases and dead-letters exhausted work", async () => {
    home = mkdtempSync(join(tmpdir(), "sophie-queue-recovery-")); process.env.SOPHIE_HOME = home;
    const { claimWork, enqueueWork, listWork, nextWork, retryWork, updateWork } = await import("../src/daemon/queue.ts");
    const item = enqueueWork({ source: "schedule", title: "Recover", prompt: "resume", maxAttempts: 1 });
    const claimed = claimWork("crashed-worker", 1)!;
    updateWork(claimed.id, { leaseUntil: Date.now() - 1 });
    expect(nextWork()?.id).toBe(item.id);
    const reclaimed = claimWork("replacement", 1000)!;
    expect(reclaimed.attempts).toBe(2);
    expect(retryWork(reclaimed.id, "still failing")?.status).toBe("dead_letter");
    expect(listWork().find((row) => row.id === item.id)?.error).toBe("still failing");
  });
});
