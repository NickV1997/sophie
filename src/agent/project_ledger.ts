import { basename } from "node:path";

export type LedgerFileAction = "created" | "edited" | "read";
export type LedgerCommandKind = "command" | "verifier";

interface FileFact {
  path: string;
  action: LedgerFileAction;
  touches: number;
  at: number;
}

interface CommandFact {
  kind: LedgerCommandKind;
  tool: string;
  command?: string;
  status: "passed" | "failed" | "blocked";
  summary: string;
  at: number;
}

interface DecisionFact {
  summary: string;
  at: number;
}

const files = new Map<string, FileFact>();
const commands: CommandFact[] = [];
const decisions: DecisionFact[] = [];

const ACTION_RANK: Record<LedgerFileAction, number> = { read: 0, edited: 1, created: 2 };

export function resetProjectLedger(): void {
  files.clear();
  commands.length = 0;
  decisions.length = 0;
}

export function recordLedgerFile(path: string, action: LedgerFileAction): void {
  const key = path.trim();
  if (!key) return;
  const existing = files.get(key);
  if (existing) {
    existing.at = Date.now();
    existing.touches++;
    if (ACTION_RANK[action] > ACTION_RANK[existing.action]) existing.action = action;
  } else {
    files.set(key, { path: key, action, touches: 1, at: Date.now() });
  }
}

export function recordLedgerCommand(input: {
  tool: string;
  command?: string;
  kind?: LedgerCommandKind;
  status: "passed" | "failed" | "blocked";
  summary: string;
}): void {
  commands.push({
    tool: input.tool,
    command: input.command?.trim() || undefined,
    kind: input.kind ?? "command",
    status: input.status,
    summary: oneLine(input.summary, 220),
    at: Date.now(),
  });
  commands.splice(0, Math.max(0, commands.length - 24));
}

export function recordLedgerDecision(summary: string): void {
  const text = oneLine(summary, 220);
  if (!text) return;
  decisions.push({ summary: text, at: Date.now() });
  decisions.splice(0, Math.max(0, decisions.length - 12));
}

export function projectLedgerForPrompt(cwd: string, maxFiles = 12, maxCommands = 10): string {
  if (!files.size && !commands.length && !decisions.length) return "";
  const rel = (p: string) => (p.startsWith(cwd) ? p.slice(cwd.length).replace(/^\//, "") || "." : p);
  const fileRows = [...files.values()]
    .sort((a, b) => ACTION_RANK[b.action] - ACTION_RANK[a.action] || b.at - a.at)
    .slice(0, maxFiles)
    .map((f) => {
      const name = basename(f.path);
      return `- ${f.action}: ${rel(f.path)}${name && name !== rel(f.path) ? ` (${name})` : ""}`;
    });
  const commandRows = commands
    .slice(-maxCommands)
    .reverse()
    .map((c) => {
      const cmd = c.command ? ` ${c.command}` : "";
      return `- ${c.kind} ${c.status}: ${c.tool}${cmd} | ${c.summary}`;
    });
  const decisionRows = decisions
    .slice(-6)
    .reverse()
    .map((d) => `- ${d.summary}`);
  return [
    "# Project ledger (runtime memory)",
    ...(fileRows.length ? ["Files:", ...fileRows] : []),
    ...(commandRows.length ? ["Commands/verifiers:", ...commandRows] : []),
    ...(decisionRows.length ? ["Decisions:", ...decisionRows] : []),
    "Use exact paths and verifier results from this ledger; re-read/rerun when current contents matter.",
  ].join("\n");
}

function oneLine(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}...` : clean;
}
