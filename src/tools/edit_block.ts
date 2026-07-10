import { existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { computeFileDiff, formatDiffText } from "./diff.ts";
import { commitTextFile, diffSummary } from "./fs.ts";
import { resolvePath } from "../system/paths.ts";
import type { Tool, ToolResult } from "./types.ts";

/**
 * apply_edits — Aider-style search/replace editing, hardened for small models.
 *
 * Why: edit_file requires the model to reproduce a snippet byte-for-byte, and
 * fails hard on any trailing-whitespace / CRLF / indentation slip — the exact
 * mistakes a small model makes. It also does one edit per call, burning a round
 * trip each time. apply_edits fixes both:
 *   - MULTIPLE search/replace blocks applied atomically in one call (all-or-
 *     nothing; a later block sees the result of an earlier one).
 *   - A tolerant matching ladder: exact → ignore trailing whitespace → ignore
 *     indentation (re-indenting the replacement to the file's actual indent).
 *   - Apply-or-fail: on a miss it returns the CLOSEST region in the file so the
 *     model can retry with a corrected block instead of guessing blindly.
 *
 * Accepts a structured `edits` array (preferred — reliable under the tool-call
 * grammar) or a raw Aider-format `diff` string of
 *   <<<<<<< SEARCH … ======= … >>>>>>> REPLACE
 * blocks.
 */

interface Edit {
  search: string;
  replace: string;
}

function leadingWs(line: string): string {
  return line.slice(0, line.length - line.trimStart().length);
}

function rstrip(line: string): string {
  return line.replace(/\s+$/, "");
}

/** Split a block into lines, dropping one trailing empty line (blocks usually
 *  end with a newline the model added). */
function toLines(block: string): string[] {
  const lines = block.replace(/\r\n/g, "\n").split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

type Located = { start: number; end: number; reindent: string } | { error: string };

/**
 * Find the unique window of `hay` lines that matches `needle` lines, via a
 * tolerance ladder. Returns inclusive [start,end] line indices plus any indent
 * prefix to add to the replacement (non-empty only for the indent-tolerant pass).
 */
function locate(hay: string[], needle: string[]): Located {
  const k = needle.length;
  if (k === 0) return { error: "empty search block" };

  const windows = (eq: (a: string, b: string) => boolean): number[] => {
    const starts: number[] = [];
    for (let i = 0; i + k <= hay.length; i++) {
      let ok = true;
      for (let j = 0; j < k; j++) {
        if (!eq(hay[i + j]!, needle[j]!)) { ok = false; break; }
      }
      if (ok) starts.push(i);
    }
    return starts;
  };

  // Pass A: exact.
  let starts = windows((a, b) => a === b);
  if (starts.length === 1) return { start: starts[0]!, end: starts[0]! + k - 1, reindent: "" };
  if (starts.length > 1) return { error: `search block matches ${starts.length} places — add surrounding lines to make it unique.` };

  // Pass B: ignore trailing whitespace (CRLF, stray spaces, final newline).
  starts = windows((a, b) => rstrip(a) === rstrip(b));
  if (starts.length === 1) return { start: starts[0]!, end: starts[0]! + k - 1, reindent: "" };
  if (starts.length > 1) return { error: `search block matches ${starts.length} places (whitespace-insensitive) — add more context.` };

  // Pass C: ignore indentation; re-indent the replacement to the file's indent.
  starts = windows((a, b) => a.trim() === b.trim());
  if (starts.length === 1) {
    const i = starts[0]!;
    const hayIndent = leadingWs(hay[i]!);
    const needleIndent = leadingWs(needle[0]!);
    // Prefix to add = the file's indent minus what the search block already had.
    const reindent = hayIndent.startsWith(needleIndent) ? hayIndent.slice(needleIndent.length) : "";
    return { start: i, end: i + k - 1, reindent };
  }
  if (starts.length > 1) return { error: `search block matches ${starts.length} places (indentation-insensitive) — add more context.` };

  return { error: closestDiagnostic(hay, needle) };
}

/** Build a helpful "closest region" message when nothing matched. */
function closestDiagnostic(hay: string[], needle: string[]): string {
  const first = needle[0]!.trim();
  // Anchor on the first non-trivial search line; show the file around it.
  let anchor = -1;
  if (first.length > 2) {
    for (let i = 0; i < hay.length; i++) {
      if (hay[i]!.trim().includes(first) || first.includes(hay[i]!.trim())) { anchor = i; break; }
    }
  }
  if (anchor === -1) {
    return "search block not found in the file (no close match). Re-read the file and copy the exact current lines into `search`.";
  }
  const from = Math.max(0, anchor - 2);
  const to = Math.min(hay.length, anchor + needle.length + 2);
  const region = hay.slice(from, to).map((l, i) => `${from + i + 1}: ${l}`).join("\n");
  return `search block not found exactly. Closest region (lines ${from + 1}-${to}):\n${region}\n\nRe-copy these exact lines into \`search\` (or use edit_file), then retry.`;
}

/** Apply all edits to a working copy of the text. All-or-nothing. */
function applyAll(text: string, edits: Edit[]): { text: string } | { error: string; index: number } {
  let lines = text.replace(/\r\n/g, "\n").split("\n");
  for (let e = 0; e < edits.length; e++) {
    const { search, replace } = edits[e]!;
    const needle = toLines(search);
    const located = locate(lines, needle);
    if ("error" in located) return { error: located.error, index: e };
    const repl = toLines(replace).map((l) => (l.length && located.reindent ? located.reindent + l : l));
    lines = [...lines.slice(0, located.start), ...repl, ...lines.slice(located.end + 1)];
  }
  return { text: lines.join("\n") };
}

/** Parse Aider-format search/replace blocks from a raw string. */
function parseDiffBlocks(diff: string): Edit[] {
  const edits: Edit[] = [];
  const re = /<{5,}\s*SEARCH\s*\n([\s\S]*?)\n?={5,}\s*\n([\s\S]*?)\n?>{5,}\s*REPLACE/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(diff)) !== null) {
    edits.push({ search: m[1] ?? "", replace: m[2] ?? "" });
  }
  return edits;
}

export const applyEdits: Tool = {
  name: "apply_edits",
  description:
    "Apply one or more search/replace edits to a file in a single call — the reliable way to make targeted code changes. Each edit finds an exact snippet and replaces it; matching tolerates trailing-whitespace and indentation differences, and on a miss it shows you the closest region so you can retry. Prefer this over edit_file when changing several spots at once. All edits apply atomically (all succeed or none do).",
  preconditions: [
    "Read the file first and copy the exact current lines into each `search`.",
    "Give enough surrounding context that each `search` is unique in the file.",
  ],
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file to edit." },
      edits: {
        type: "array",
        description: "Ordered list of edits. Each is {search, replace}: `search` is the exact current text, `replace` is the new text.",
        items: {
          type: "object",
          properties: {
            search: { type: "string", description: "Exact current text to find (a few lines with context)." },
            replace: { type: "string", description: "Replacement text." },
          },
          required: ["search", "replace"],
        },
      },
      diff: {
        type: "string",
        description: "Alternative to `edits`: raw blocks of `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE`.",
      },
      allow_invalid: { type: "boolean", description: "Allow writing invalid JS/TS/JSX/TSX. Default false." },
    },
    required: ["path"],
  } as any,
  summarize: (a) => {
    const n = Array.isArray(a.edits) ? a.edits.length : typeof a.diff === "string" ? (a.diff.match(/SEARCH/g)?.length ?? 1) : 0;
    return `apply ${n} edit${n === 1 ? "" : "s"} to ${a.path}`;
  },
  risk: () => "safe",
  async execute(args, ctx): Promise<ToolResult> {
    const path = resolvePath(ctx.cwd, String(args.path ?? ""));
    if (!existsSync(path)) return { content: `File not found: ${path}. Use write_file to create it.`, isError: true };

    let edits: Edit[] = [];
    if (Array.isArray(args.edits)) {
      edits = args.edits
        .filter((e: any) => e && typeof e.search === "string" && typeof e.replace === "string")
        .map((e: any) => ({ search: e.search, replace: e.replace }));
    } else if (typeof args.diff === "string" && args.diff.trim()) {
      edits = parseDiffBlocks(args.diff);
    }
    if (!edits.length) {
      return { content: "apply_edits needs a non-empty `edits` array of {search, replace}, or a `diff` string of SEARCH/REPLACE blocks.", isError: true };
    }

    const before = readFileSync(path, "utf8");
    const applied = applyAll(before, edits);
    if ("error" in applied) {
      return {
        content: `Edit ${applied.index + 1} of ${edits.length} could not be applied to ${path}:\n${applied.error}`,
        isError: true,
        display: `edit ${applied.index + 1} failed`,
      };
    }
    if (applied.text === before) {
      return { content: `No change: the replacements are identical to the current content of ${path}.`, isError: true, display: "no change" };
    }

    const commitError = commitTextFile(path, before, applied.text, { allowInvalid: Boolean(args.allow_invalid) });
    if (commitError) return { content: commitError, isError: true, display: "syntax rejected" };

    const diff = computeFileDiff(relative(ctx.cwd, path), before, applied.text);
    return {
      content: `Applied ${edits.length} edit${edits.length === 1 ? "" : "s"} to ${path}.\nBackup saved under ~/.sophie/backups/.\n\n${formatDiffText(diff)}`,
      display: diffSummary(`${edits.length} edit${edits.length === 1 ? "" : "s"}`, diff),
      diff,
    };
  },
};
