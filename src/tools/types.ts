import type { FileDiff } from "./diff.ts";

export type JSONSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
};

export interface ToolResult {
  /** Text returned to the model as the tool's output. */
  content: string;
  /** True if the tool failed; surfaced to the model and the UI. */
  isError?: boolean;
  /** Optional short line shown in the TUI under the tool call. */
  display?: string;
  /** Structured line diff for edit tools, painted add/remove in the TUI. */
  diff?: FileDiff;
  /** End the turn after this tool and wait for the user (e.g. ask_user). The
   *  content is surfaced to the user as the message to answer. */
  endTurn?: boolean;
}

export interface ToolContext {
  /** Directory Sophie was launched from. */
  cwd: string;
  /** Abort signal so long tools (bash) can be cancelled. */
  signal?: AbortSignal;
}

export type RiskLevel = "safe" | "caution" | "dangerous";

export interface Tool {
  name: string;
  description: string;
  /** Declarative preconditions shown to the model and enforced by runtime policy where applicable. */
  preconditions?: string[];
  parameters: JSONSchema;
  /** One-line human summary of a specific call, shown in the TUI. */
  summarize(args: Record<string, any>): string;
  /**
   * Classify how dangerous a specific call is. "safe" runs without asking;
   * "caution"/"dangerous" require user approval before executing.
   */
  risk(args: Record<string, any>): RiskLevel;
  execute(args: Record<string, any>, ctx: ToolContext): Promise<ToolResult>;
}

/** The shape passed to the model in the <tools> block. */
export type ToolSpec = Pick<Tool, "name" | "description" | "parameters" | "preconditions">;
