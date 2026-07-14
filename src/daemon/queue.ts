import { existsSync } from "node:fs";
import { join } from "node:path";
import { memoryHomeDir } from "../memory/facts.ts";
import type { TurnSource } from "../agent/capabilities.ts";
import { readJsonWithRecovery, writePrivateFileAtomic } from "../system/atomic-file.ts";
import { approvalArgumentHash } from "../agent/approval.ts";

export type DaemonWorkStatus = "queued" | "running" | "awaiting_approval" | "completed" | "failed" | "dead_letter";
export interface DaemonWorkItem {
  id: string; source: Extract<TurnSource, "schedule" | "watcher" | "telegram">;
  title: string; prompt: string; status: DaemonWorkStatus; createdAt: number; updatedAt: number;
  attempts: number; result?: string; error?: string;
  pendingApproval?: { name: string; args: Record<string, unknown>; summary: string; details?: string; argumentHash: string; signature: string };
  approvedSignature?: string;
  priority: number; notBefore: number; maxAttempts: number; leaseOwner?: string; leaseUntil?: number;
}
function queuePath(): string { return join(memoryHomeDir(), "daemon", "queue.json"); }

function load(): DaemonWorkItem[] {
  const path = queuePath();
  if (!existsSync(path)) return [];
  const parsed: any = readJsonWithRecovery(path);
  const items = Array.isArray(parsed?.items) ? parsed.items : [];
  // A crash during execution makes the item retryable on the next daemon start.
  const now = Date.now();
  return items.map((raw: DaemonWorkItem) => {
    let x = raw;
    if (x.pendingApproval && !x.pendingApproval.argumentHash) {
      const argumentHash = approvalArgumentHash(x.pendingApproval.args ?? {});
      x = { ...x, pendingApproval: { ...x.pendingApproval, argumentHash, signature: `${x.pendingApproval.name}:${argumentHash}` } };
    }
    return x.status === "running" && (x.leaseUntil ?? 0) <= now ? { ...x, status: "queued" as const, leaseOwner: undefined, leaseUntil: undefined } : x;
  });
}
function save(items: DaemonWorkItem[]): void { writePrivateFileAtomic(queuePath(), `${JSON.stringify({ schemaVersion: 1, items }, null, 2)}\n`); }
export function enqueueWork(input: Pick<DaemonWorkItem, "source" | "title" | "prompt"> & Partial<Pick<DaemonWorkItem, "priority" | "notBefore" | "maxAttempts">>): DaemonWorkItem {
  const items = load(); const now = Date.now();
  const item: DaemonWorkItem = { ...input, id: `work-${now.toString(36)}-${crypto.randomUUID().slice(0, 8)}`, status: "queued", createdAt: now, updatedAt: now, attempts: 0, priority: input.priority ?? 0, notBefore: input.notBefore ?? now, maxAttempts: input.maxAttempts ?? 4 };
  items.push(item); save(items); return item;
}
export function listWork(): DaemonWorkItem[] { return load().sort((a, b) => a.createdAt - b.createdAt); }
export function nextWork(): DaemonWorkItem | undefined { const now = Date.now(); return load().filter((x) => x.status === "queued" && x.notBefore <= now).sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt)[0]; }
export function claimWork(owner: string, leaseMs = 120_000): DaemonWorkItem | undefined { const item = nextWork(); if (!item) return; return updateWork(item.id, { status: "running", attempts: item.attempts + 1, leaseOwner: owner, leaseUntil: Date.now() + leaseMs }); }
export function retryWork(id: string, error: string): DaemonWorkItem | undefined { const item = load().find((x) => x.id === id); if (!item) return; if (item.attempts >= item.maxAttempts) return updateWork(id, { status: "dead_letter", error, leaseOwner: undefined, leaseUntil: undefined }); const delay = Math.min(15 * 60_000, 5_000 * 2 ** Math.max(0, item.attempts - 1)); return updateWork(id, { status: "queued", error, notBefore: Date.now() + delay, leaseOwner: undefined, leaseUntil: undefined }); }
export function updateWork(id: string, patch: Partial<DaemonWorkItem>): DaemonWorkItem | undefined {
  const items = load(); const i = items.findIndex((x) => x.id === id); if (i < 0) return;
  items[i] = { ...items[i]!, ...patch, id, updatedAt: Date.now() }; save(items); return items[i];
}
export function approveWork(id: string, argumentHash: string): DaemonWorkItem | undefined {
  const item = load().find((x) => x.id === id);
  if (!item?.pendingApproval || !argumentHash || item.pendingApproval.argumentHash !== argumentHash) return;
  return updateWork(id, { status: "queued", approvedSignature: item.pendingApproval.signature, error: undefined });
}
export function cancelWork(id: string): DaemonWorkItem | undefined { return updateWork(id, { status: "failed", error: "Cancelled by user", pendingApproval: undefined, approvedSignature: undefined }); }
