import type { Tool } from "./types.ts";
import { approveWork, cancelWork, listWork } from "../daemon/queue.ts";

export const daemonWork: Tool = {
  name: "daemon_work",
  description: "Inspect and control durable background Sophie work. Approval authorizes only the exact paused tool call shown in the item, once.",
  parameters: { type: "object", properties: {
    action: { type: "string", enum: ["list", "approve", "cancel"] },
    id: { type: "string", description: "Background work id." },
    argument_hash: { type: "string", description: "For approve: exact SHA-256 shown by list for the paused call." },
  }, required: ["action"] },
  summarize: (a) => {
    if (a.action !== "approve") return `daemon work ${a.action}${a.id ? ` ${a.id}` : ""}`;
    const pending = listWork().find((work) => work.id === a.id)?.pendingApproval;
    return pending
      ? `approve background ${a.id}: ${pending.name} — ${pending.summary}\n${pending.details ?? `Arguments SHA-256: ${pending.argumentHash}`}`
      : `approve background ${a.id ?? "?"} (no matching pending call)`;
  },
  risk: (a) => a.action === "approve" ? "dangerous" : a.action === "cancel" ? "caution" : "safe",
  async execute(a) {
    if (a.action === "list") {
      const rows = listWork().slice(-30);
      return { content: rows.length ? rows.map((x) => `- ${x.id} [${x.status}] ${x.title}${x.pendingApproval ? `\n  pending: ${x.pendingApproval.name} — ${x.pendingApproval.summary}\n  ${x.pendingApproval.details ?? `Arguments SHA-256: ${x.pendingApproval.argumentHash}`}` : ""}${x.error ? `\n  ${x.error}` : ""}`).join("\n") : "No background work." };
    }
    const id = String(a.id ?? ""); if (!id) return { content: "id is required", isError: true };
    if (a.action === "approve") { const x = approveWork(id, String(a.argument_hash ?? "")); return x ? { content: `Approved exactly once: ${x.pendingApproval?.summary ?? id}. The daemon will resume it.`, display: `approved ${id}` } : { content: "No paused approval matched that id and exact argument hash. List background work again and copy the current hash.", isError: true }; }
    if (a.action === "cancel") return cancelWork(id) ? { content: `Cancelled ${id}.`, display: `cancelled ${id}` } : { content: "Work item not found.", isError: true };
    return { content: "unknown action", isError: true };
  },
};
