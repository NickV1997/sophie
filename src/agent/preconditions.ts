import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { ParsedToolCall } from "../llm/qwen.ts";
import type { Tool } from "../tools/types.ts";
import type { TurnIntent } from "./intent.ts";
import type { JournalEntry } from "./tasks.ts";

export interface PreconditionsContext {
  cwd: string;
  intent: TurnIntent;
  journal: JournalEntry[];
}

export function checkToolPreconditions(call: ParsedToolCall, tool: Tool, ctx: PreconditionsContext): string | null {
  if (call.name === "write_file" || call.name === "edit_file" || call.name === "replace_lines") {
    return checkWritePreconditions(call, ctx);
  }
  if (call.name === "bash" || call.name === "run_background") {
    return checkCommandPreconditions(call, ctx);
  }
  return null;
}

function checkWritePreconditions(call: ParsedToolCall, ctx: PreconditionsContext): string | null {
  const rawPath = String(call.arguments.path ?? "").trim();
  if (!rawPath) return "Write/edit precondition failed: path is required.";
  const path = abs(ctx.cwd, rawPath);
  const isExisting = existsSync(path);
  const wasRead = ctx.journal.some((j) =>
    j.tool === "read_file" &&
    typeof j.summary === "string" &&
    (j.summary.includes(rawPath) || j.summary.includes(path))
  );
  const ownedByScaffold = ctx.journal.some((j) =>
    j.kind === "tool_result" &&
    typeof j.evidence === "string" &&
    (j.evidence.includes("Created") || j.evidence.includes("scaffold")) &&
    j.evidence.includes(rawPath.split("/").pop() ?? rawPath)
  );

  if (isExisting && !wasRead && !ownedByScaffold) {
    return [
      "Write/edit precondition failed: existing files must be read before editing.",
      `Read ${path} with read_file or project_map first, then retry with evidence from the current turn/job.`,
    ].join("\n");
  }
  if (call.name === "replace_lines" && !call.arguments.expected_old) {
    return "replace_lines precondition failed: expected_old is required so stale line ranges cannot corrupt code.";
  }
  return null;
}

function checkCommandPreconditions(call: ParsedToolCall, ctx: PreconditionsContext): string | null {
  const command = String(call.arguments.command ?? "").trim();
  const lower = command.toLowerCase();
  if (/\b(?:npm\s+(?:install|i)|pnpm\s+add|bun\s+add|yarn\s+add|npx|pnpm\s+dlx|bunx|yarn\s+dlx)\b/.test(lower)) {
    const hasPreflightMarker = /(^|[;&|]\s*)SOPHIE_INSTALL_PREFLIGHT=1\s+/.test(command);
    const hasPreflightEvidence = ctx.journal.some((j) =>
      !j.isError &&
      /preflight|package\.json|components\.json|verified.*package|verified.*component|shadcn.*search/i.test(
        `${j.summary} ${j.evidence ?? ""}`,
      )
    );
    if (!hasPreflightMarker || !hasPreflightEvidence) {
      return [
        "Package/component command precondition failed.",
        "Before installs or component CLIs, inspect package.json, lockfile, components.json, existing components, and verify package/component availability.",
        "Record that evidence in the task note/journal, then rerun with SOPHIE_INSTALL_PREFLIGHT=1.",
      ].join("\n");
    }
  }
  if (/\bshadcn\b|@shadcn|shadcn-ui/.test(lower)) {
    const initialized = command.includes(" init ") || ctx.journal.some((j) => /components\.json|shadcn.*init/i.test(`${j.summary} ${j.evidence ?? ""}`));
    if (!initialized && /\badd\b/.test(lower)) {
      return "shadcn add precondition failed: initialize or verify components.json before adding components.";
    }
  }
  return null;
}

function abs(cwd: string, p: string): string {
  return isAbsolute(p) ? p : resolve(cwd, p);
}
