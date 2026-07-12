import type { Tool } from "./types.ts";
import { approveWork, cancelWork, listWork } from "../daemon/queue.ts";

export const daemonWork: Tool = {
  name: "daemon_work",
  description: "Inspect and control durable background Sophie work. Approval authorizes only the exact paused tool call shown in the item, once.",
  parameters: { type: "object", properties: {
    action: { type: "string", enum: ["list", "approve", "cancel"] },
    id: { type: "string", description: "Background work id." },
  }, required: ["action"] },
  summarize: (a) => `daemon work ${a.action}${a.id ? ` ${a.id}` : ""}`,
  risk: (a) => a.action === "approve" ? "dangerous" : a.action === "cancel" ? "caution" : "safe",
  async execute(a) {
    if (a.action === "list") {
      const rows = listWork().slice(-30);
      return { content: rows.length ? rows.map((x) => `- ${x.id} [${x.status}] ${x.title}${x.pendingApproval ? ` — pending: ${x.pendingApproval.summary}` : ""}${x.error ? ` — ${x.error}` : ""}`).join("\n") : "No background work." };
    }
    const id = String(a.id ?? ""); if (!id) return { content: "id is required", isError: true };
    if (a.action === "approve") { const x = approveWork(id); return x ? { content: `Approved exactly once: ${x.pendingApproval?.summary ?? id}. The daemon will resume it.`, display: `approved ${id}` } : { content: "No paused approval found.", isError: true }; }
    if (a.action === "cancel") return cancelWork(id) ? { content: `Cancelled ${id}.`, display: `cancelled ${id}` } : { content: "Work item not found.", isError: true };
    return { content: "unknown action", isError: true };
  },
};
