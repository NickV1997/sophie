import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { computeFileDiff, type FileDiff, formatDiffText } from "./diff.ts";
import { resolvePath } from "../system/paths.ts";
import { protectedWriteBlockReason } from "../system/protected-paths.ts";
import { recordFileChange } from "../system/undo.ts";
import type { Tool } from "./types.ts";

function abs(cwd: string, p: string): string {
  return resolvePath(cwd, p);
}

/** Short summary line shown next to the diff, e.g. "updated · +3 -1". */
export function diffSummary(verb: string, diff: FileDiff): string {
  return `${verb} · +${diff.added} -${diff.removed}`;
}

function codeLoader(path: string): "js" | "jsx" | "ts" | "tsx" | null {
  const ext = extname(path).toLowerCase();
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return "js";
  if (ext === ".jsx") return "jsx";
  if (ext === ".ts" || ext === ".mts" || ext === ".cts") return "ts";
  if (ext === ".tsx") return "tsx";
  return null;
}

function validateCode(path: string, content: string, allowInvalid: boolean): string | null {
  if (allowInvalid) return null;
  const loader = codeLoader(path);
  if (!loader) return null;
  try {
    new Bun.Transpiler({ loader }).transformSync(content);
    return null;
  } catch (e: any) {
    return `Refusing to write invalid ${loader.toUpperCase()} syntax to ${path}: ${e?.message ?? e}`;
  }
}

/** `before` is the previous content, or null when the file is being created —
 *  the undo journal needs the distinction (undo of a creation = delete). */
export function commitTextFile(path: string, before: string | null, next: string, opts?: { allowInvalid?: boolean }): string | null {
  // Runtime firewall: never create/overwrite OS internals or credential stores,
  // regardless of what the model asks. Overwriting a keychain or SSH key is as
  // destructive as deleting it. Checked before anything touches disk.
  const writeBlock = protectedWriteBlockReason(path);
  if (writeBlock) return writeBlock;
  const validation = validateCode(path, next, Boolean(opts?.allowInvalid));
  if (validation) return validation;
  mkdirSync(dirname(path), { recursive: true });
  recordFileChange(path, before);
  writeFileSync(path, next);
  return null;
}

// ── read_file ────────────────────────────────────────────────────────────
export const readFile: Tool = {
  name: "read_file",
  description:
    "Read the contents of a file from the filesystem. Returns text with line " +
    "numbers. Use offset/limit for very large files.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file (absolute or relative to cwd)." },
      offset: { type: "number", description: "1-based line to start from (optional)." },
      limit: { type: "number", description: "Max number of lines to read (optional)." },
    },
    required: ["path"],
  },
  summarize: (a) => `read ${a.path}`,
  risk: () => "safe",
  async execute(args, ctx) {
    const path = abs(ctx.cwd, args.path);
    if (!existsSync(path)) return { content: `File not found: ${path}`, display: "not found" };
    const st = statSync(path);
    if (st.isDirectory()) return { content: `${path} is a directory, not a file.`, isError: true };
    const lines = readFileSync(path, "utf8").split("\n");
    const start = args.offset ? Math.max(0, args.offset - 1) : 0;
    const end = args.limit ? start + args.limit : lines.length;
    const slice = lines.slice(start, end);
    const numbered = slice
      .map((l, i) => `${String(start + i + 1).padStart(6)}\t${l}`)
      .join("\n");
    return {
      content: numbered || "(empty file)",
      display: `${slice.length} lines`,
    };
  },
};

// ── write_file ───────────────────────────────────────────────────────────
export const writeFile: Tool = {
  name: "write_file",
  description:
    "Write content to a file, creating it (and parent directories) or " +
    "overwriting it completely. Prefer edit_file for small changes.",
  preconditions: [
    "Read an existing file before overwriting it unless the file was just created by a scaffold tool in this job.",
    "For JS/TS/JSX/TSX, content must parse unless allow_invalid is explicitly set.",
  ],
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to write to." },
      content: { type: "string", description: "Full file content." },
      allow_invalid: {
        type: "boolean",
        description: "Escape hatch: allow writing invalid JS/TS/JSX/TSX. Default false.",
      },
    },
    required: ["path", "content"],
  },
  summarize: (a) => `write ${a.path}`,
  risk: () => "safe",
  async execute(args, ctx) {
    const path = abs(ctx.cwd, args.path);
    const existed = existsSync(path);
    const before = existed ? readFileSync(path, "utf8") : "";
    const next = args.content ?? "";
    const error = commitTextFile(path, existed ? before : null, next, { allowInvalid: Boolean(args.allow_invalid) });
    if (error) return { content: error, isError: true, display: error.startsWith("RESTRICTED") ? "restricted: protected path" : "syntax rejected" };
    const diff = computeFileDiff(relative(ctx.cwd, path), before, next);
    const verb = existed ? "overwrote" : "created";
    return {
      content:
        `${existed ? "Overwrote" : "Created"} ${path} (${next.length} bytes).` +
        (existed ? `\nBackup saved under ~/.sophie/backups/.` : "") +
        `\n\n${formatDiffText(diff)}`,
      display: diffSummary(verb, diff),
      diff,
    };
  },
};

// ── edit_file ────────────────────────────────────────────────────────────
export const editFile: Tool = {
  name: "edit_file",
  description:
    "Replace an exact string in a file with a new string. old_string must " +
    "match exactly and be unique unless replace_all is true.",
  preconditions: [
    "Read the target file before editing it.",
    "old_string must be exact and unique unless replace_all is intentional.",
  ],
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file to edit." },
      old_string: { type: "string", description: "Exact text to find." },
      new_string: { type: "string", description: "Replacement text." },
      replace_all: { type: "boolean", description: "Replace every occurrence." },
      allow_invalid: {
        type: "boolean",
        description: "Escape hatch: allow writing invalid JS/TS/JSX/TSX. Default false.",
      },
    },
    required: ["path", "old_string", "new_string"],
  },
  summarize: (a) => `edit ${a.path}`,
  risk: () => "safe",
  async execute(args, ctx) {
    const path = abs(ctx.cwd, args.path);
    if (!existsSync(path)) return { content: `File not found: ${path}`, isError: true };
    const text = readFileSync(path, "utf8");
    const { old_string, new_string, replace_all } = args;
    const count = text.split(old_string).length - 1;
    if (count === 0) return { content: `old_string not found in ${path}.`, isError: true };
    if (count > 1 && !replace_all)
      return {
        content: `old_string is not unique in ${path} (${count} matches). Pass replace_all or add more context.`,
        isError: true,
      };
    const updated = replace_all
      ? text.split(old_string).join(new_string)
      : text.replace(old_string, new_string);
    const error = commitTextFile(path, text, updated, { allowInvalid: Boolean(args.allow_invalid) });
    if (error) return { content: error, isError: true, display: error.startsWith("RESTRICTED") ? "restricted: protected path" : "syntax rejected" };
    const diff = computeFileDiff(relative(ctx.cwd, path), text, updated);
    const edits = replace_all ? count : 1;
    return {
      content:
        `Edited ${path} (${edits} replacement${edits === 1 ? "" : "s"}).` +
        `\nBackup saved under ~/.sophie/backups/.\n\n${formatDiffText(diff)}`,
      display: diffSummary(`${edits} edit${edits === 1 ? "" : "s"}`, diff),
      diff,
    };
  },
};

// ── replace_lines ────────────────────────────────────────────────────────
export const replaceLines: Tool = {
  name: "replace_lines",
  description:
    "Replace an inclusive 1-based line range in a text file. Read the file " +
    "first, then use this only for small, surgical edits where exact string replacement is awkward. " +
    "For JS/TS/JSX/TSX, expected_old is REQUIRED (and the edited file must parse before it is written); " +
    "prefer edit_file or write_file for components.",
  preconditions: [
    "Read the target range immediately before replacing lines.",
    "For code files, pass expected_old (the exact current range text) — it is required, not optional.",
    "Prefer write_file for large component rewrites.",
  ],
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file to edit." },
      start_line: { type: "number", description: "Inclusive 1-based first line to replace." },
      end_line: { type: "number", description: "Inclusive 1-based last line to replace." },
      replacement: { type: "string", description: "Replacement text (may be multi-line)." },
      expected_old: {
        type: "string",
        description: "Exact text expected in the range; edit rejected unless it matches.",
      },
      allow_large: {
        type: "boolean",
        description: "Allow replacing >40 lines or changing line count by >80. Prefer write_file for big rewrites.",
      },
      allow_invalid: {
        type: "boolean",
        description: "Escape hatch: allow writing invalid JS/TS/JSX/TSX. Default false.",
      },
    },
    required: ["path", "start_line", "end_line", "replacement"],
  },
  summarize: (a) => `replace ${a.path}:${a.start_line}-${a.end_line}`,
  risk: () => "safe",
  async execute(args, ctx) {
    const path = abs(ctx.cwd, args.path);
    if (!existsSync(path)) return { content: `File not found: ${path}`, isError: true };
    const text = readFileSync(path, "utf8");
    const lines = text.split("\n");
    const start = Number(args.start_line);
    const end = Number(args.end_line);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
      return { content: "start_line and end_line must be valid inclusive 1-based line numbers.", isError: true };
    }
    if (end > lines.length) {
      return { content: `end_line ${end} is past the end of ${path} (${lines.length} lines).`, isError: true };
    }
    const replacement = String(args.replacement ?? "").split("\n");
    const oldRange = lines.slice(start - 1, end).join("\n");
    // For code files a wrong line range silently corrupts the file, so make the
    // anti-stale guard mandatory (not just advisory) — require expected_old and
    // verify it matches the current contents before touching the range.
    const isCode = /\.(tsx|jsx|ts|js|mts|cts|mjs|cjs)$/i.test(path);
    if (isCode && typeof args.expected_old !== "string") {
      return {
        content:
          `replace_lines on code file ${path} requires expected_old (the exact current text of lines ${start}-${end}) ` +
          `so a stale line range cannot corrupt the file. Re-read the range now and pass it as expected_old, ` +
          `or use edit_file (exact string replace) / write_file (full rewrite) instead.\n\n` +
          `--- current range ${start}-${end} ---\n${oldRange}`,
        isError: true,
        display: "expected_old required",
      };
    }
    if (typeof args.expected_old === "string" && args.expected_old !== oldRange) {
      return {
        content:
          `expected_old did not match ${path}:${start}-${end}; refusing stale line-number edit. ` +
          `Re-read the file to get fresh line numbers, then retry with the current text as expected_old.\n\n` +
          `--- actual range ---\n${oldRange}`,
        isError: true,
        display: "stale range",
      };
    }
    const originalLineCount = end - start + 1;
    const lineDelta = Math.abs(replacement.length - originalLineCount);
    if (!args.allow_large && (originalLineCount > 40 || lineDelta > 80)) {
      return {
        content:
          `Refusing risky replace_lines on ${path}:${start}-${end}. ` +
          `Range is ${originalLineCount} lines and replacement is ${replacement.length} lines. ` +
          `Use write_file for intentional full rewrites, or pass allow_large=true after re-reading the file.`,
        isError: true,
        display: "risky range",
      };
    }
    const updatedLines = [...lines.slice(0, start - 1), ...replacement, ...lines.slice(end)];
    const updated = updatedLines.join("\n");
    const error = commitTextFile(path, text, updated, { allowInvalid: Boolean(args.allow_invalid) });
    if (error) return { content: error, isError: true, display: error.startsWith("RESTRICTED") ? "restricted: protected path" : "syntax rejected" };
    const diff = computeFileDiff(relative(ctx.cwd, path), text, updated);
    return {
      content:
        `Replaced ${path}:${start}-${end} with ${replacement.length} line${replacement.length === 1 ? "" : "s"}.` +
        `\nBackup saved under ~/.sophie/backups/.\n\n${formatDiffText(diff)}`,
      display: diffSummary(`lines ${start}-${end}`, diff),
      diff,
    };
  },
};

// ── list_dir ─────────────────────────────────────────────────────────────
export const listDir: Tool = {
  name: "list_dir",
  description: "List the files and subdirectories of a directory.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory path (defaults to cwd)." },
    },
    required: [],
  },
  summarize: (a) => `ls ${a.path ?? "."}`,
  risk: () => "safe",
  async execute(args, ctx) {
    const path = abs(ctx.cwd, args.path ?? ".");
    if (!existsSync(path)) return { content: `Not found: ${path}`, isError: true };
    const entries = readdirSync(path, { withFileTypes: true })
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
    return {
      content: entries.length ? entries.join("\n") : "(empty directory)",
      display: `${entries.length} entries`,
    };
  },
};

// ── glob ─────────────────────────────────────────────────────────────────
export const glob: Tool = {
  name: "glob",
  description:
    "Find files matching a glob pattern (e.g. '**/*.ts', 'src/**/*.json'). " +
    "Returns matching paths.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern." },
      path: { type: "string", description: "Base directory to search (defaults to cwd)." },
    },
    required: ["pattern"],
  },
  summarize: (a) => `glob ${a.pattern}`,
  risk: () => "safe",
  async execute(args, ctx) {
    const base = abs(ctx.cwd, args.path ?? ".");
    if (!existsSync(base)) {
      return { content: `Search path not found: ${base}`, display: "path not found" };
    }
    const g = new Bun.Glob(args.pattern);
    const out: string[] = [];
    for await (const file of g.scan({ cwd: base, dot: false, onlyFiles: true })) {
      out.push(join(base, file));
      if (out.length >= 200) break;
    }
    return {
      content: out.length ? out.join("\n") : `No files match ${args.pattern}`,
      display: `${out.length} match${out.length === 1 ? "" : "es"}`,
    };
  },
};

// ── grep ─────────────────────────────────────────────────────────────────
export const grep: Tool = {
  name: "grep",
  description:
    "Search file contents for a regular expression. Returns matching lines " +
    "with file path and line number, most-relevant files first.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression to search for." },
      path: { type: "string", description: "Directory or file to search (defaults to cwd)." },
      glob: { type: "string", description: "Optional glob filter, e.g. '*.ts'." },
    },
    required: ["pattern"],
  },
  summarize: (a) => `grep ${a.pattern}`,
  risk: () => "safe",
  async execute(args, ctx) {
    const base = abs(ctx.cwd, args.path ?? ".");
    if (!existsSync(base)) {
      return { content: `Search path not found: ${base}`, display: "path not found" };
    }
    let re: RegExp;
    try {
      re = new RegExp(args.pattern);
    } catch (e: any) {
      return { content: `Invalid regex: ${e.message}`, isError: true };
    }
    const fileGlob = new Bun.Glob(args.glob ?? "**/*");
    const isFile = existsSync(base) && statSync(base).isFile();
    const fileList: string[] = [];
    if (isFile) fileList.push(base);
    else {
      for await (const f of fileGlob.scan({ cwd: base, dot: false, onlyFiles: true })) {
        fileList.push(join(base, f));
      }
    }

    // A small model is bad at needle-in-haystack, so do the finding here:
    // collect matches per file, then emit the densest files first instead of
    // whatever glob order happened to yield. Caps bound both work and output.
    const MAX_LINES_PER_FILE = 15;
    const MAX_OUTPUT_LINES = 120;
    const MAX_TOTAL_MATCHES = 3000; // scan bound, not output bound
    type FileHits = { file: string; count: number; lines: string[] };
    const hits: FileHits[] = [];
    let totalMatches = 0;

    for (const file of fileList) {
      if (totalMatches >= MAX_TOTAL_MATCHES) break;
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue; // unreadable
      }
      // Skip binary files: readFileSync(utf8) doesn't throw on them, it returns
      // mojibake, which would produce garbage matches. A NUL byte in the first
      // chunk is the standard "this is binary" heuristic.
      if (text.slice(0, 8000).includes("\x00")) continue;
      const lines = text.split("\n");
      const rel = relative(ctx.cwd, file);
      let entry: FileHits | null = null;
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i])) continue;
        if (!entry) {
          entry = { file: rel, count: 0, lines: [] };
          hits.push(entry);
        }
        entry.count++;
        totalMatches++;
        if (entry.lines.length < MAX_LINES_PER_FILE) {
          entry.lines.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
        }
        if (totalMatches >= MAX_TOTAL_MATCHES) break;
      }
    }

    if (!hits.length) {
      return { content: `No matches for /${args.pattern}/`, display: "0 matches" };
    }
    hits.sort((a, b) => b.count - a.count);
    const out: string[] = [];
    let shown = 0;
    let shownFiles = 0;
    for (const h of hits) {
      if (out.length >= MAX_OUTPUT_LINES) break;
      const room = MAX_OUTPUT_LINES - out.length;
      const take = h.lines.slice(0, room);
      out.push(...take);
      shown += take.length;
      shownFiles++;
      if (h.count > take.length) {
        out.push(`  …${h.count - take.length} more in ${h.file}`);
      }
    }
    const hiddenFiles = hits.length - shownFiles;
    if (hiddenFiles > 0) {
      const hiddenMatches = hits.slice(shownFiles).reduce((n, h) => n + h.count, 0);
      out.push(
        `…${hiddenMatches}${totalMatches >= MAX_TOTAL_MATCHES ? "+" : ""} more match${hiddenMatches === 1 ? "" : "es"} in ${hiddenFiles} other file${hiddenFiles === 1 ? "" : "s"} — narrow the pattern, path, or glob.`,
      );
    }
    return {
      content: out.join("\n"),
      display: `${totalMatches}${totalMatches >= MAX_TOTAL_MATCHES ? "+" : ""} matches in ${hits.length} files`,
    };
  },
};
