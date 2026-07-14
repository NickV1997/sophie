import type { ParsedToolCall } from "../llm/tool-protocol.ts";
import type { ResultProvenance, RiskLevel, ToolResult } from "../tools/types.ts";
import { isSensitivePathLike } from "../system/sensitive-data.ts";

export type TurnSource = "user" | "telegram" | "schedule" | "watcher" | "webapp";
export type Capability =
  | "read_public"
  | "read_private"
  | "write_local"
  | "communicate_external"
  | "execute_code"
  | "schedule_future"
  | "control_browser"
  | "persist_memory";

const PRIVATE_SOURCES = new Set(["email", "apple", "clipboard", "capture_screen", "user_profile", "people", "recall", "search_verified_memory", "search_sessions", "read_document", "read_file", "grep", "project_map", "bash", "run_background", "job_status"]);
const EXTERNAL_SOURCES = new Set(["web_search", "web_fetch", "email", "apple", "read_document", "browser_check", "browser_act", "http_request"]);
const OUTWARD_TOOLS = new Set(["notify", "email", "apple", "http_request", "browser_act", "browser_check", "web_search", "web_fetch"]);
const WRITE_TOOLS = new Set(["write_file", "edit_file", "apply_edits", "replace_lines", "scaffold_project", "scaffold_python_project", "scaffold_next_shadcn_project", "install_deps", "add_ui_component", "git_checkpoint", "calendar", "schedule", "watch_path", "people", "projects", "delegate", "manage_tasks", "privacy"]);
const EXECUTE_TOOLS = new Set(["bash", "run_background", "project_checks", "verify_project", "verify_next_app", "verify_python_project", "verify_static_site", "verify_package_install"]);
const PERSIST_TOOLS = new Set(["remember", "save_skill", "user_profile", "manage_tasks", "schedule", "watch_path", "delegate"]);

export function provenanceForResult(toolName: string, result: ToolResult, args: Record<string, unknown> = {}): ResultProvenance {
  if (result.provenance) return result.provenance;
  const dynamicMcp = toolName.startsWith("mcp__");
  const locator = typeof args.path === "string" ? args.path : undefined;
  return {
    source: toolName,
    trust: EXTERNAL_SOURCES.has(toolName) || dynamicMcp ? "external" : "local",
    sensitivity: isSensitivePathLike(args.path ?? args.file) ? "secret" : PRIVATE_SOURCES.has(toolName) ? "personal" : "public",
    ...(locator ? { locator } : {}),
  };
}

export function capabilitiesForCall(call: ParsedToolCall): Set<Capability> {
  const out = new Set<Capability>();
  const name = call.name;
  const action = String(call.arguments.action ?? "");
  const dynamicMcp = name.startsWith("mcp__");
  const readOnlyRecordCall =
    (name === "manage_tasks" && action === "list") ||
    (name === "projects" && ["list", "view"].includes(action)) ||
    (name === "people" && ["list", "lookup"].includes(action)) ||
    (name === "delegate" && action === "list");
  if (PRIVATE_SOURCES.has(name)) out.add("read_private");
  else out.add("read_public");
  if (WRITE_TOOLS.has(name) && !readOnlyRecordCall) out.add("write_local");
  if (dynamicMcp) {
    out.add("write_local");
    out.add("communicate_external");
  }
  if (OUTWARD_TOOLS.has(name) && isOutwardAction(call)) out.add("communicate_external");
  if (EXECUTE_TOOLS.has(name)) out.add("execute_code");
  if (["schedule", "watch_path"].includes(name) || (name === "delegate" && !readOnlyRecordCall)) out.add("schedule_future");
  if (name === "browser_act") out.add("control_browser");
  if (PERSIST_TOOLS.has(name) && !readOnlyRecordCall) out.add("persist_memory");
  if (name === "apple" && !["contacts_lookup", "messages_recent", "messages_search", "notes_list", "notes_read", "notes_search", "folders_list", "reminders_lists", "reminders_list", "alarms_list"].includes(action)) {
    out.add("write_local");
  }
  // Local email drafts are inert preparation, not durable assistant memory and
  // not outward communication. Sending/deleting retain their tool-level risk;
  // an untrusted source alone must not force approval merely to save a draft.
  if (name === "clipboard" && action === "write") out.add("write_local");
  return out;
}

function isOutwardAction(call: ParsedToolCall): boolean {
  if (call.name === "email") return ["send", "draft_send"].includes(String(call.arguments.action));
  if (call.name === "apple") return call.arguments.action === "messages_send";
  if (call.name === "http_request") return true; // URLs and query strings can themselves disclose data.
  if (call.name === "browser_act") return ["goto", "click", "type", "press"].includes(String(call.arguments.action));
  if (call.name === "browser_check" || call.name === "web_search" || call.name === "web_fetch") return true;
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
  if (input.hasUntrustedEvidence && (
    caps.has("execute_code") || caps.has("write_local") || caps.has("schedule_future") ||
    caps.has("control_browser") || caps.has("persist_memory")
  )) {
    return {
      risk: "caution",
      reason: "This state-changing action follows untrusted retrieved content. Approval must confirm it is part of the user's request, not an instruction from that content.",
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
