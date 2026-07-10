// Structured line diffs for the edit tools. Produces hunks with real old/new
// line numbers and surrounding context (Claude-Code style) so the TUI can paint
// additions/removals, and a plain-text serialization for the model's history.

export type DiffLineType = "add" | "del" | "ctx";

export interface DiffLine {
  type: DiffLineType;
  text: string;
  /** 1-based line number in the original file (ctx + del). */
  oldNo?: number;
  /** 1-based line number in the new file (ctx + add). */
  newNo?: number;
}

export interface DiffHunk {
  lines: DiffLine[];
}

export interface FileDiff {
  path: string;
  hunks: DiffHunk[];
  added: number;
  removed: number;
}

type Op = { type: DiffLineType; a: number; b: number };

const CONTEXT = 3;
/** Guard against pathological O(n·m) diffs on huge unrelated files. */
const MAX_DP_CELLS = 4_000_000;

/** Diff two text blobs into structured hunks. Empty `before` ⇒ all additions. */
export function computeFileDiff(path: string, before: string, after: string): FileDiff {
  const a = before.length ? before.split("\n") : [];
  const b = after.length ? after.split("\n") : [];
  const ops = diffOps(a, b);

  let added = 0;
  let removed = 0;
  for (const o of ops) {
    if (o.type === "add") added++;
    else if (o.type === "del") removed++;
  }

  return { path, hunks: buildHunks(ops, a, b), added, removed };
}

/** Unified-ish text rendering of a diff, for the model-facing tool output. */
export function formatDiffText(diff: FileDiff): string {
  if (!diff.hunks.length) return "(no changes)";
  const out: string[] = [diff.path];
  diff.hunks.forEach((h, idx) => {
    if (idx > 0) out.push("  ⋮");
    for (const l of h.lines) {
      const no = (l.type === "add" ? l.newNo : l.oldNo) ?? "";
      const sign = l.type === "add" ? "+" : l.type === "del" ? "-" : " ";
      out.push(`${String(no).padStart(5)} ${sign} ${l.text}`);
    }
  });
  const text = out.join("\n");
  return text.length > 12_000 ? `${text.slice(0, 12_000)}\n...(diff truncated)` : text;
}

// ── internals ──────────────────────────────────────────────────────────────

function diffOps(a: string[], b: string[]): Op[] {
  // Trim the common prefix/suffix so the DP only runs over the changed middle —
  // edits are usually local, which keeps this cheap even on large files.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let aEnd = a.length;
  let bEnd = b.length;
  while (aEnd > start && bEnd > start && a[aEnd - 1] === b[bEnd - 1]) {
    aEnd--;
    bEnd--;
  }

  const ops: Op[] = [];
  for (let i = 0; i < start; i++) ops.push({ type: "ctx", a: i, b: i });
  ops.push(...middleOps(a.slice(start, aEnd), b.slice(start, bEnd), start, start));
  for (let i = aEnd; i < a.length; i++) ops.push({ type: "ctx", a: i, b: bEnd + (i - aEnd) });
  return ops;
}

function middleOps(am: string[], bm: string[], aOff: number, bOff: number): Op[] {
  const n = am.length;
  const m = bm.length;
  if (n === 0) return bm.map((_, j) => ({ type: "add" as const, a: -1, b: bOff + j }));
  if (m === 0) return am.map((_, i) => ({ type: "del" as const, a: aOff + i, b: -1 }));

  // If the changed region is enormous, don't build an O(n·m) table — just show
  // the whole old block removed and the new block added.
  if (n * m > MAX_DP_CELLS) {
    return [
      ...am.map((_, i) => ({ type: "del" as const, a: aOff + i, b: -1 })),
      ...bm.map((_, j) => ({ type: "add" as const, a: -1, b: bOff + j })),
    ];
  }

  // LCS length table, then backtrack into an edit script.
  const dp: Int32Array[] = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = am[i] === bm[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (am[i] === bm[j]) {
      ops.push({ type: "ctx", a: aOff + i, b: bOff + j });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: "del", a: aOff + i, b: -1 });
      i++;
    } else {
      ops.push({ type: "add", a: -1, b: bOff + j });
      j++;
    }
  }
  while (i < n) ops.push({ type: "del", a: aOff + i++, b: -1 });
  while (j < m) ops.push({ type: "add", a: -1, b: bOff + j++ });
  return ops;
}

/** Keep changed ops plus CONTEXT lines around them; split into hunks on gaps. */
function buildHunks(ops: Op[], a: string[], b: string[]): DiffHunk[] {
  const keep = new Array<boolean>(ops.length).fill(false);
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].type === "ctx") continue;
    for (let k = Math.max(0, i - CONTEXT); k <= Math.min(ops.length - 1, i + CONTEXT); k++) {
      keep[k] = true;
    }
  }

  const hunks: DiffHunk[] = [];
  let cur: DiffLine[] | null = null;
  for (let i = 0; i < ops.length; i++) {
    if (!keep[i]) {
      if (cur) {
        hunks.push({ lines: cur });
        cur = null;
      }
      continue;
    }
    const o = ops[i];
    (cur ??= []).push({
      type: o.type,
      text: o.type === "add" ? b[o.b] : a[o.a],
      oldNo: o.type === "add" ? undefined : o.a + 1,
      newNo: o.type === "del" ? undefined : o.b + 1,
    });
  }
  if (cur) hunks.push({ lines: cur });
  return hunks;
}
