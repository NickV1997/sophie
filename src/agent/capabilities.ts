import type { ParsedToolCall } from "../llm/tool-protocol.ts";
import type { ResultProvenance, RiskLevel, ToolResult } from "../tools/types.ts";

export type TurnSource = "user" | "telegram" | "schedule" | "watcher" | "webapp";
export type Capability =
  | "read_public"
  | "read_private"
  | "write_local"
  | "communicate_external"
  | "execute_code"
  | "schedule_future"
  | "control_browser";

const PRIVATE_SOURCES = new Set(["email", "apple", "clipboard", "capture_screen", "user_profile", "people", "recall", "search_verified_memory"]);
const EXTERNAL_SOURCES = new Set(["web_search", "web_fetch", "email", "apple", "read_document", "browser_check", "browser_act", "http_request"]);
const OUTWARD_TOOLS = new Set(["notify", "email", "apple", "http_request", "browser_act"]);
const WRITE_TOOLS = new Set(["write_file", "edit_file", "apply_edits", "replace_lines", "calendar", "schedule", "watch_path", "people", "projects", "delegate"]);

export function provenanceForResult(toolName: string, result: ToolResult): ResultProvenance {
  if (result.provenance) return result.provenance;
  const dynamicMcp = toolName.startsWith("mcp__");
  return {
    source: toolName,
    trust: EXTERNAL_SOURCES.has(toolName) || dynamicMcp ? "external" : "local",
    sensitivity: PRIVATE_SOURCES.has(toolName) ? "personal" : "public",
  };
}

export function capabilitiesForCall(call: ParsedToolCall): Set<Capability> {
  const out = new Set<Capability>();
  const name = call.name;
  if (PRIVATE_SOURCES.has(name)) out.add("read_private");
  else out.add("read_public");
  if (WRITE_TOOLS.has(name)) out.add("write_local");
  if (OUTWARD_TOOLS.has(name) && isOutwardAction(call)) out.add("communicate_external");
  if (["bash", "run_background"].includes(name)) out.add("execute_code");
  if (["schedule", "watch_path", "delegate"].includes(name)) out.add("schedule_future");
  if (name === "browser_act") out.add("control_browser");
  return out;
}

function isOutwardAction(call: ParsedToolCall): boolean {
  if (call.name === "email") return ["send", "draft_send"].includes(String(call.arguments.action));
  if (call.name === "apple") return call.arguments.action === "messages_send";
  if (call.name === "http_request") return String(call.arguments.method ?? "GET").toUpperCase() !== "GET";
  if (call.name === "browser_act") return ["click", "type", "press"].includes(String(call.arguments.action));
  return call.name === "notify";
}

export interface CapabilityDecision {
  risk: RiskLevel;
  reason?: string;
}

/** Elevate composed operations that a tool-local risk function cannot see. */
export function capabilityDecision(input: {
  call: ParsedToolCall;
  source: TurnSource;
  baseRisk: RiskLevel;
  hasSensitiveEvidence: boolean;
  hasUntrustedEvidence: boolean;
}): CapabilityDecision {
  const caps = capabilitiesForCall(input.call);
  const autonomous = input.source === "schedule" || input.source === "watcher";
  if (caps.has("communicate_external") && (input.hasSensitiveEvidence || input.hasUntrustedEvidence)) {
    return {
      risk: "caution",
      reason: "This outward action follows private or untrusted retrieved content. Approval must confirm the exact recipient and purpose.",
    };
  }
  if (autonomous && (caps.has("communicate_external") || caps.has("execute_code") || caps.has("control_browser") || caps.has("write_local"))) {
    return {
      risk: "caution",
      reason: "Autonomous turns have a restricted capability set; this state-changing or outward action requires interactive approval.",
    };
  }
  return { risk: input.baseRisk };
}
