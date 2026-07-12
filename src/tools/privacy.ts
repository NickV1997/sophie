import type { Tool } from "./types.ts";
import { deletePrivateCategory, enforceRetention, exportPrivateState, privacyInventory } from "../system/privacy.ts";

export const privacyTool: Tool = {
  name: "privacy",
  description: "Inspect, export, retain, or delete Sophie's locally stored personal data. Exports never include .env credentials or tokens.",
  parameters: { type: "object", properties: {
    action: { type: "string", enum: ["inventory", "export", "retention", "delete"] },
    destination: { type: "string", description: "Export parent directory." },
    days: { type: "number", description: "Retention age in days." },
    category: { type: "string", enum: ["sessions", "memories", "profile", "calendar", "contacts", "watchers", "activity"] },
  }, required: ["action"] },
  summarize: (a) => `privacy ${a.action}${a.category ? ` ${a.category}` : ""}`,
  risk: (a) => ["delete", "retention"].includes(String(a.action)) ? "dangerous" : a.action === "export" ? "caution" : "safe",
  async execute(a) {
    if (a.action === "inventory") return { content: privacyInventory().map((x) => `${x.category}: ${x.files} files, ${x.bytes} bytes`).join("\n") };
    if (a.action === "export") { if (!a.destination) return { content: "destination is required", isError: true }; const out = exportPrivateState(String(a.destination)); return { content: `Exported private state to ${out} (credentials excluded).`, display: out }; }
    if (a.action === "retention") { const n = enforceRetention(Number(a.days) || 90); return { content: `Removed ${n} expired session/job files.`, display: `${n} removed` }; }
    if (a.action === "delete") { const n = deletePrivateCategory(String(a.category)); return n < 0 ? { content: "unknown category", isError: true } : { content: `Deleted ${n} stored ${a.category} path(s).`, display: `${n} removed` }; }
    return { content: "unknown privacy action", isError: true };
  },
};
