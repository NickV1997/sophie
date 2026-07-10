import type { Mode } from "../config.ts";
import { BUILD_MODE_TOOLS, PLAN_MODE_TOOLS } from "../tools/registry.ts";
import type { RiskLevel, Tool } from "../tools/types.ts";

export interface Gate {
  /** "run" = execute now, "ask" = require approval, "block" = refuse. */
  decision: "run" | "ask" | "block";
  risk: RiskLevel;
  reason?: string;
}

/**
 * The single chokepoint that decides whether a tool call runs freely, needs
 * the user's blessing, or is forbidden in the current mode. Sophie gets a lot
 * of rope — we only stop for genuinely destructive actions.
 */
export function gate(tool: Tool, args: Record<string, any>, mode: Mode): Gate {
  const risk = tool.risk(args);

  if (mode === "plan" && !PLAN_MODE_TOOLS.has(tool.name)) {
    return {
      decision: "block",
      risk,
      reason: `${tool.name} mutates state and is disabled in plan mode.`,
    };
  }

  if (mode === "build" && !BUILD_MODE_TOOLS.has(tool.name)) {
    return {
      decision: "block",
      risk,
      reason: `${tool.name} is disabled in build mode. Use local coding tools, then verifier tools for evidence.`,
    };
  }

  if (risk === "dangerous" || risk === "caution") {
    return { decision: "ask", risk };
  }
  return { decision: "run", risk };
}
