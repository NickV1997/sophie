import type { Tool } from "./types.ts";
import { listActivity } from "../system/activity.ts";

export const activityTool: Tool = {
  name: "activity",
  description: "Read Sophie's local audit history to answer what she did, approved, delivered, or failed recently.",
  parameters: { type: "object", properties: { limit: { type: "number" }, status: { type: "string", enum: ["all", "succeeded", "failed", "approved", "denied"] } } },
  summarize: (a) => `recent activity (${a.limit ?? 30})`, risk: () => "safe",
  async execute(a) {
    const status = String(a.status ?? "all");
    const rows = listActivity(Number(a.limit) || 30).filter((x) => status === "all" || x.status === status);
    return { content: rows.length ? rows.map((x) => `- ${new Date(x.at).toLocaleString()} [${x.status}] ${x.action}${x.summary ? ` — ${x.summary}` : ""}`).join("\n") : "No matching activity." };
  },
};
