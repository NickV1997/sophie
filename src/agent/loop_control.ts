import type { ChatMessage } from "../llm/client.ts";
import type { ParsedToolCall } from "../llm/tool-protocol.ts";
import { stripThink } from "./context.ts";
import type { ToolResult } from "../tools/types.ts";

export function spiralSynthesisPrompt(roundCount: number, reason: string): string {
  return `[Auto-recovery after ${roundCount} rounds — ${reason}] You need to wrap up now. Synthesize everything gathered and give a complete direct answer. If incomplete, explain what was accomplished, the specific blocker, and what the user should try. Do not call tools.`;
}
export function contentSig(text: string): string { return stripThink(text).replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 250); }
export function countContentRepeats(history: ChatMessage[], sig: string, minLength: number, window = 6): number {
  if (sig.length < minLength) return 0;
  return history.slice(-window - 1, -1).filter((m) => m.role === "assistant" && contentSig(typeof m.content === "string" ? m.content : "") === sig).length;
}
export function looksLikePromisedAction(text: string): boolean {
  const visible = stripThink(text).replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "").trim().toLowerCase();
  return !!visible && /\b(let me|i'?ll|i will|i’m going to|i am going to)\b/.test(visible) && /\b(check|inspect|verify|fix|run|read|start|restart|look|build|test|open|fetch)\b/.test(visible);
}
export function clipOneLine(text: string, max: number): string { const one = text.replace(/\s+/g, " ").trim(); return one.length > max ? `${one.slice(0, max)}...` : one; }
export function failureFamily(call: ParsedToolCall, result: ToolResult): string {
  if (call.name !== "bash") return `${call.name}:${result.display ?? "error"}`;
  if (result.content.includes("timed out")) return "bash:timeout";
  const command = String(call.arguments.command ?? "").toLowerCase();
  if (/\bshadcn\b|@shadcn|shadcn-ui/.test(command)) return "bash:shadcn";
  if (/\b(npm|pnpm|bun|yarn)\b/.test(command)) return "bash:package-manager";
  if (/\bgit\b/.test(command)) return "bash:git";
  return `bash:${command.split(/\s+/).slice(0, 3).join(" ") || "command"}`;
}
