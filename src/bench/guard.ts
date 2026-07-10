/**
 * Benchmark safety guard.
 *
 * Wraps every registered tool's execute() so a full, real conversation can run
 * against Sophie WITHOUT touching the outside world in a harmful way:
 *   - iMessage/message sends, calendar/schedule writes, delegations, app
 *     launches, speech, screen capture, clipboard writes and destructive note/
 *     reminder edits are SIMULATED (a realistic success is returned, the intent
 *     is recorded, nothing actually happens).
 *   - Notes + reminders CREATION and all reads are allowed (the user opted in).
 *   - bash / run_background are scanned; anything destructive or outward-facing
 *     is blocked and recorded. Everything else runs for real inside the sandbox.
 *
 * Each decision is pushed to `events` so the report can show exactly what Sophie
 * tried to do and what the guard did about it.
 */

import { config } from "../config.ts";
import { TOOLS } from "../tools/registry.ts";
import type { Tool, ToolContext, ToolResult } from "../tools/types.ts";

/** The port the local model server listens on. A benchmark case that tells
 *  Sophie to "serve" a site must NOT bind this port, or it shadows the LLM
 *  endpoint (localhost resolves IPv6-first) and 501s every later request. */
const MODEL_PORT = (() => {
  try {
    return new URL(config.baseUrl).port || "8080";
  } catch {
    return "8080";
  }
})();

/** True if a shell command tries to bind/serve on the model server's port. */
function bindsModelPort(command: string): boolean {
  const p = MODEL_PORT;
  return (
    new RegExp(`http\\.server\\s+${p}\\b`).test(command) ||
    new RegExp(`(--port|-p|-l|--listen|:)\\s*=?\\s*${p}\\b`).test(command) ||
    new RegExp(`\\b(serve|http-server|live-server|vite|next\\s+dev|python[0-9.]*\\s+-m\\s+http\\.server)\\b[\\s\\S]*\\b${p}\\b`).test(command)
  );
}

export type GuardAction = "allow" | "simulate" | "block";

export interface GuardEvent {
  tool: string;
  action: GuardAction;
  reason: string;
  args: Record<string, unknown>;
  at: number;
}

interface GuardHandle {
  events: GuardEvent[];
  /** Clear events between questions. */
  reset(): void;
  /** Restore original execute fns. */
  uninstall(): void;
}

/** Commands that must never run for real, even inside the sandbox. */
const DANGEROUS_BASH: { re: RegExp; why: string }[] = [
  { re: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b.*(\/(\s|$)|~|\$HOME|\.\.(\/|\s|$)|\/(Users|System|Library|etc|bin|var|Applications))/i, why: "recursive delete outside the sandbox" },
  { re: /\brm\s+-[a-z]*\s+\/(?!tmp)/i, why: "delete targeting an absolute root path" },
  { re: /\b(sudo|doas)\b/i, why: "privilege escalation" },
  { re: /\b(shutdown|reboot|halt|poweroff)\b/i, why: "power control" },
  { re: /\bmkfs|diskutil\s+(erase|reformat|partition)|newfs/i, why: "disk formatting" },
  { re: /\bdd\b[^|]*\bof=\/dev\//i, why: "raw device write" },
  { re: /:\(\)\s*\{\s*:\|:&\s*\};:/, why: "fork bomb" },
  { re: /\bosascript\b[\s\S]*\b(Messages|send|Mail|iMessage)\b/i, why: "scripted message/mail send" },
  { re: /\b(curl|wget|http)\b[\s\S]*\b(-X\s*(POST|PUT|DELETE|PATCH)|--data|--upload-file|-d\s|-F\s)/i, why: "outbound write request" },
  { re: /\bgit\s+push\b/i, why: "pushing to a remote" },
  { re: /\bnpm\s+publish\b|\byarn\s+publish\b|\bbun\s+publish\b/i, why: "publishing a package" },
  { re: /\b(launchctl|crontab|systemctl|at\s+now)\b/i, why: "installing a persistent job" },
  { re: /\b(killall|pkill)\b|\bkill\s+-9\s+1\b/i, why: "broad process kill" },
  { re: /\bsoftwareupdate\b|\bbrew\s+(uninstall|remove)\b/i, why: "system/software mutation" },
  { re: /\bchmod\s+-R\s+777\s+\//i, why: "recursive permission change on a root path" },
  { re: /\bmv\s+[\s\S]*\s+\/(dev\/null|Users|System)/i, why: "moving files into a system path" },
  { re: />\s*\/dev\/(sd|disk|rdisk)/i, why: "writing to a raw disk" },
  // Delete protection: Sophie may only delete files she made this session (i.e.
  // relative paths inside the sandbox cwd). Any delete/trash/shred of an
  // absolute path, a home path, or one escaping the sandbox via ".." is blocked
  // — this protects the project folder and the rest of the computer.
  { re: /\b(rm|rmdir|unlink|shred|trash|srm)\b[^|;&]*\s(\/|~|\$HOME|\$\{HOME\})/i, why: "deleting an absolute/home path (only session sandbox files may be deleted)" },
  { re: /\b(rm|rmdir|unlink|shred|trash|srm)\b[^|;&]*\.\.(\/|\s|$)/i, why: "delete escaping the session sandbox via .." },
  { re: /\bfind\b[\s\S]*-delete\b/i, why: "bulk find -delete (delete only specific session files by name)" },
  { re: /\brm\b[^|;&]*\*[\s\S]*(\/|~)/i, why: "wildcard delete against an absolute/home path" },
];

function bashDanger(command: string): string | null {
  for (const { re, why } of DANGEROUS_BASH) if (re.test(command)) return why;
  return null;
}

/** Decide how to handle a specific call. Returns a simulated result when the
 *  action should not actually happen. */
function decide(tool: string, args: Record<string, any>): { action: GuardAction; reason: string; result?: ToolResult } {
  const a = (k: string) => String(args?.[k] ?? "").trim();
  const action = a("action");

  switch (tool) {
    case "apple": {
      if (action === "messages_send") {
        return {
          action: "simulate",
          reason: "iMessage send suppressed in benchmark",
          result: { content: `Sent iMessage to ${a("to") || "recipient"}: "${a("text")}"`, display: `sent to ${a("to") || "recipient"}` },
        };
      }
      if (["notes_delete", "notes_replace", "notes_rename", "notes_move", "reminders_update", "reminders_complete"].includes(action)) {
        return {
          action: "simulate",
          reason: `destructive ${action} on existing item suppressed (protects real data)`,
          result: { content: `(benchmark) ${action} completed.`, display: action.replace("_", ": ") },
        };
      }
      return { action: "allow", reason: "read or additive Notes/Reminders op — permitted" };
    }
    case "notify":
      return {
        action: "simulate",
        reason: "notification/telegram delivery suppressed",
        result: { content: `Notification delivered (desktop).`, display: "desktop" },
      };
    case "calendar":
      if (["add", "update", "cancel"].includes(action)) {
        return { action: "simulate", reason: `calendar ${action} suppressed`, result: { content: `(benchmark) calendar ${action} done: "${a("title") || a("id")}".`, display: `${action}` } };
      }
      return { action: "allow", reason: "calendar read — permitted" };
    case "schedule":
      if (action && action !== "list") {
        return { action: "simulate", reason: `schedule ${action} suppressed (no real cron installed)`, result: { content: `(benchmark) scheduled ${action}: ${a("cron") || a("at") || a("in_minutes") + "m"}.`, display: `${action}` } };
      }
      return { action: "allow", reason: "schedule list — permitted" };
    case "delegate":
      if (action !== "list") {
        return { action: "simulate", reason: `delegate ${action} suppressed`, result: { content: `(benchmark) delegation ${action} recorded.`, display: `${action}` } };
      }
      return { action: "allow", reason: "delegate list — permitted" };
    case "http_request": {
      const method = a("method").toUpperCase() || "GET";
      if (["GET", "HEAD", "OPTIONS"].includes(method)) return { action: "allow", reason: `read-only ${method}` };
      return { action: "simulate", reason: `${method} request suppressed`, result: { content: `(benchmark) ${method} ${a("url")} suppressed — no external mutation performed.`, display: `${method} blocked` } };
    }
    case "open_thing":
      return { action: "simulate", reason: "app/URL launch suppressed", result: { content: `(benchmark) would open: ${a("target") || a("url") || a("path") || JSON.stringify(args)}.`, display: "open suppressed" } };
    case "speak":
      return { action: "simulate", reason: "TTS suppressed", result: { content: `(benchmark) spoke: "${a("text")}".`, display: "spoke" } };
    case "voice":
      if (action === "set") return { action: "simulate", reason: "voice config change suppressed", result: { content: `(benchmark) voice set.`, display: "voice set" } };
      return { action: "allow", reason: "voice read — permitted" };
    case "capture_screen":
      return { action: "simulate", reason: "screen capture suppressed (privacy)", result: { content: `(benchmark) screen capture skipped; no screenshot taken.`, display: "capture suppressed" } };
    case "browser_act":
      return { action: "simulate", reason: "browser interaction suppressed", result: { content: `(benchmark) browser ${action || "action"} suppressed.`, display: "browser act suppressed" } };
    case "watch_path":
      return { action: "simulate", reason: "filesystem watcher suppressed", result: { content: `(benchmark) watch registered (no persistent watcher started).`, display: "watch suppressed" } };
    case "clipboard": {
      const isWrite = !!(a("text") || ["set", "copy", "write"].includes(action));
      if (isWrite) return { action: "simulate", reason: "clipboard write suppressed", result: { content: `(benchmark) copied to clipboard.`, display: "copied" } };
      return { action: "allow", reason: "clipboard read — permitted" };
    }
    case "bash":
    case "run_background": {
      const command = a("command");
      const why = bashDanger(command);
      if (why) return { action: "block", reason: `dangerous command blocked: ${why}`, result: { content: `Refused: this command was blocked by the benchmark safety guard (${why}). Choose a safe, sandboxed alternative.`, isError: true, display: "blocked (unsafe)" } };
      if (bindsModelPort(command)) {
        return {
          action: "block",
          reason: `command would bind the model server port ${MODEL_PORT}`,
          result: { content: `Refused: port ${MODEL_PORT} is reserved for the model server — serving on it would break the LLM connection. Use a different port (e.g. 5173 or 3000).`, isError: true, display: "blocked (model port)" },
        };
      }
      return { action: "allow", reason: "sandboxed shell command" };
    }
    default:
      return { action: "allow", reason: "no side effect / sandboxed" };
  }
}

/** Patch every tool's execute with the guard. Idempotent per process. */
export function installGuard(): GuardHandle {
  const events: GuardEvent[] = [];
  const originals = new Map<Tool, Tool["execute"]>();

  for (const tool of TOOLS) {
    if (originals.has(tool)) continue;
    const orig = tool.execute.bind(tool);
    originals.set(tool, tool.execute);
    tool.execute = async (args: Record<string, any>, ctx: ToolContext): Promise<ToolResult> => {
      const verdict = decide(tool.name, args ?? {});
      events.push({ tool: tool.name, action: verdict.action, reason: verdict.reason, args: args ?? {}, at: Date.now() });
      if (verdict.action !== "allow" && verdict.result) return verdict.result;
      return orig(args, ctx);
    };
  }

  return {
    events,
    reset() {
      events.length = 0;
    },
    uninstall() {
      for (const [tool, exec] of originals) tool.execute = exec;
    },
  };
}
