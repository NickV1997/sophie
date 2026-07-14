import type { RiskLevel, Tool } from "./types.ts";
import { protectedPathBlockReason } from "../system/protected-paths.ts";
import { protectedProcessBlockReason } from "../system/protected-processes.ts";
import { platform } from "node:os";
import { sanitizedCommandEnvironment, sandboxedShellCommand, supportsCommandSandbox } from "../system/command-sandbox.ts";
import { isSensitivePathLike } from "../system/sensitive-data.ts";

const MAX_FOREGROUND_MS = 3 * 60 * 1000;

/**
 * Approval policy: Sophie runs freely. We only stop to ask for commands that
 * delete or move files (the user's explicit case), plus a small catastrophic /
 * irreversible safety net. Editing, building, running, installing, git, etc.
 * never prompt.
 */

/** Commands that delete or move files — ask once, lightly ("caution"). */
const DELETE_MOVE_PATTERNS: RegExp[] = [
  /\brm\b/i, // remove files/dirs
  /\brmdir\b/i,
  /\bunlink\b/i,
  /\btrash\b/i,
  /\bmv\b/i, // move / rename
  /\bgit\s+(rm|mv)\b/i,
  /\bfind\b[\s\S]*\s-delete\b/i,
];

/** Catastrophic / irreversible system actions — kept behind approval ("dangerous"),
 *  even though they aren't "editing code". */
const CATASTROPHIC_PATTERNS: RegExp[] = [
  /\bmkfs\b/i,
  /\bdd\b\s+if=/i,
  />\s*\/dev\/sd[a-z]/i,
  /\bdiskutil\s+(erase\w*|reformat|partitiondisk|zerodisk|secureerase)/i,
  /\bsecurity\s+delete-(keychain|generic-password|internet-password)\b/i,
  /\b(csrutil\s+disable|spctl\s+--master-disable|fdesetup\s+(disable|remove))\b/i,
  /\b(shutdown|reboot|halt|poweroff)\b/i,
  /:\(\)\s*\{.*\};:/, // fork bomb
  /\bsudo\b/i,
  /\bcurl\b[^|]*\|\s*(sudo\s+)?(ba)?sh/i, // curl | sh
  /\bgit\s+push\b.*--force/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bnpm\s+publish\b/i,
];

/** External, persistent, or opaque effects that must be shown to the user. */
const OUTWARD_PATTERNS: RegExp[] = [
  /\bgit\s+push\b/i,
  /\bgh\s+(?:pr|issue|release|repo|api)\s+(?:create|edit|delete|merge|close|reopen|fork|archive|transfer)\b/i,
  /\b(curl|wget|http)\b[\s\S]*(?:-X\s*(?:POST|PUT|DELETE|PATCH)\b|--data(?:-binary)?\b|--upload-file\b|-d(?:\s|=)|-F(?:\s|=)|--post-data\b)/i,
  /\b(scp|sftp)\b/i,
  /\brsync\b[\s\S]*(?:[\w.-]+@[^\s:]+:|[^\s]+::)/i,
  /\bssh\b/i,
  /\b(mail|mailx|sendmail)\b/i,
  /\bosascript\b/i,
  /\b(crontab|launchctl|systemctl\s+(?:enable|disable|start|stop|restart)|brew\s+services)\b/i,
  /\b(npm|pnpm|yarn|bun)\s+(?:publish|login|logout|owner|access|deprecate|dist-tag)\b/i,
  /\b(?:npm\s+(?:install|i)|pnpm\s+(?:install|add|dlx)|yarn\s+(?:install|add|dlx)|bun\s+(?:install|add)|npx|bunx)\b/i,
];

const LOCAL_MUTATION_PATTERNS: RegExp[] = [
  /(^|\s)\d*(?:>>?|<)\s*[^&]/,
  /\b(tee|touch|mkdir|cp|chmod|chown|xattr|defaults\s+write)\b/i,
];

const OPAQUE_INLINE_CODE = /\b(python3?|node|bun|deno|ruby|perl|php)\b[\s\S]*\s(?:-c|-e|--eval)\b/i;

const LONG_LIVED_PATTERNS: RegExp[] = [
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?dev\b/i,
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?start\b/i,
  /\b(npx\s+)?next\s+(dev|start)\b/i,
  /\b(vite|astro|nuxt|remix|svelte-kit)\s+(dev|preview)\b/i,
  /\bpython3?\s+-m\s+http\.server\b/i,
  /\b--watch\b/i,
  /\bwatch\b/i,
];

function hasTrailingBackgroundOperator(cmd: string): boolean {
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if ((ch === "'" || ch === '"') && quote === null) {
      quote = ch;
      continue;
    }
    if (ch === quote) {
      quote = null;
      continue;
    }
    if (ch === "&" && quote === null && cmd.slice(i + 1).trim() === "") return true;
  }
  return false;
}

function longLivedReason(cmd: string): string | null {
  if (hasTrailingBackgroundOperator(cmd)) {
    return "This command uses a trailing background '&'. In foreground bash, that can keep stdout/stderr open and stall the tool.";
  }
  if (LONG_LIVED_PATTERNS.some((re) => re.test(cmd))) {
    return "This looks like a dev server, watch process, file server, or other long-lived command.";
  }
  return null;
}

function installPreflightReason(cmd: string): string | null {
  const c = cmd.trim();
  if (/(^|[;&|]\s*)SOPHIE_INSTALL_PREFLIGHT=1\s+/.test(c)) return null;

  const packageAdd =
    /\b(?:npm\s+(?:install|i)|pnpm\s+add|bun\s+add|yarn\s+add)\s+/.test(c) &&
    !/\b(?:npm\s+(?:install|i)|pnpm\s+install|bun\s+install|yarn\s+install)\s*(?:--[^\s]+|\s*)*$/.test(c);
  const shadcnCli = /\b(?:npx|pnpm\s+dlx|bunx|yarn\s+dlx)\s+(?:--yes\s+|-y\s+)?(?:@shadcn\/(?:cli|ui)|shadcn(?:-ui)?(?:@[\w.-]+)?)\b/i.test(c);

  if (!packageAdd && !shadcnCli) return null;

  return [
    "Package/component install command blocked until dependency preflight is complete.",
    "Before retrying, inspect package.json, the lockfile/package manager, components.json, existing UI components, and relevant imports.",
    "Verify that the package or shadcn component exists. Prefer existing local components or a local implementation when availability is unclear.",
    "If the install is still intentional after that evidence, rerun the command with this exact prefix: SOPHIE_INSTALL_PREFLIGHT=1",
  ].join("\n");
}

function normalizePortableCommand(cmd: string): { command: string; note?: string } {
  let next = cmd;
  const notes: string[] = [];
  if (platform() === "darwin" && /\bfree\s+(-[a-zA-Z]*m[a-zA-Z]*|--mega|--mebi)?\b/.test(next)) {
    next = next.replace(/\bfree\s+(-[a-zA-Z]*m[a-zA-Z]*|--mega|--mebi)?\b/g, "vm_stat; sysctl hw.memsize");
    notes.push("Replaced Linux-only `free` with macOS memory commands.");
  }
  if (/\bpython\b/.test(next) && !/\bpython3\b/.test(next)) {
    next = next.replace(/\bpython\b/g, "python3");
    notes.push("Replaced `python` with `python3` because this environment may not provide a `python` shim.");
  }
  return notes.length ? { command: next, note: notes.join(" ") } : { command: next };
}

/** `find` is in SAFE_PREFIXES, but these action flags make it mutate or run
 *  arbitrary commands, so such a find must not be auto-approved. */
const FIND_SIDE_EFFECT = /\bfind\b[\s\S]*\s-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls)\b/i;

export function classifyCommand(cmd: string): RiskLevel {
  const c = cmd.trim();
  if (CATASTROPHIC_PATTERNS.some((re) => re.test(c))) return "dangerous";
  if (DELETE_MOVE_PATTERNS.some((re) => re.test(c))) return "caution";
  // A find that deletes or shells out to a mutating command needs a look.
  if (FIND_SIDE_EFFECT.test(c)) return "caution";
  if (OUTWARD_PATTERNS.some((re) => re.test(c))) return "caution";
  if (LOCAL_MUTATION_PATTERNS.some((re) => re.test(c))) return "caution";
  if (OPAQUE_INLINE_CODE.test(c)) return "caution";
  if (isSensitivePathLike(c) || /(?:^|\s)(?:\.env(?:\.[^\s/]+)?|~?\/[^\s]*(?:\.ssh|\.gnupg|\.aws|\.kube|keychains?|credentials?|secrets?)(?:\/|\s|$))|\bsecurity\s+find-(?:generic|internet)-password\b/i.test(c)) return "caution";
  if (longLivedReason(c)) return "caution";
  // Without an enforceable OS sandbox, arbitrary programs are opaque. Keep a
  // narrow read-only shell surface automatic and ask for everything else.
  if (!supportsCommandSandbox() && !/^(?:pwd|ls|stat|file|cat|head|tail|wc|rg|grep|sed\s+-n|find\b(?![\s\S]*-(?:exec|delete))|git\s+(?:status|diff|log|show|branch|rev-parse)\b)/i.test(c)) return "caution";
  return "safe";
}

export const bash: Tool = {
  name: "bash",
  description:
    "Run a shell command and return its combined stdout/stderr. Use for builds, " +
    "tests, git, package managers, and tasks without a dedicated tool. " +
    "Foreground commands are capped near three minutes — use run_background for " +
    "longer work and for dev servers, watch processes, and file servers. See " +
    "preconditions for install preflight and failure handling. Avoid destructive " +
    "commands unless asked.",
  preconditions: [
    "Do not use for dev servers, watch processes, file servers, or long-lived commands; use run_background.",
    "Package add/install and shadcn component commands require dependency/component preflight evidence and SOPHIE_INSTALL_PREFLIGHT=1.",
    "Do not repeat failed command families; inspect help/docs or switch strategy after related failures.",
  ],
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command to execute." },
      timeout_ms: { type: "number", description: "Timeout in ms (default 180000, capped at 180000)." },
      allow_unsandboxed: { type: "boolean", description: "Run without Sophie's network/write sandbox. Requires explicit approval." },
    },
    required: ["command"],
  },
  summarize: (a) => a.command,
  risk: (a) => a.allow_unsandboxed ? "caution" : classifyCommand(a.command ?? ""),
  async execute(args, ctx) {
    const command = String(args.command ?? "").trim();
    const processReason = protectedProcessBlockReason(command);
    if (processReason) {
      return {
        content:
          `${processReason}\n` +
          "This is a hard runtime safety block. Do not retry with another kill, pkill, killall, service stop, or port-kill variation. Ask the user to manage the LLM server manually if they truly want it stopped.",
        isError: true,
        display: "restricted: LLM process protected",
      };
    }
    const destructiveReason = protectedPathBlockReason(command, ctx.cwd);
    if (destructiveReason) {
      return {
        content:
          `${destructiveReason}\n` +
          "This is a hard safety block enforced by the runtime. It cannot be approved, retried, or rephrased — do not attempt a variation of this command. " +
          "If a narrower action is safe, target a specific non-protected subfolder or move files to a named backup directory instead. " +
          "If the user genuinely wants this destructive action on a protected location, tell them you are not permitted to do it and they must do it themselves.",
        isError: true,
        display: "restricted: protected path blocked",
      };
    }
    const installReason = installPreflightReason(command);
    if (installReason) {
      return {
        content: installReason,
        isError: true,
        display: "blocked install preflight",
      };
    }
    const reason = longLivedReason(command);
    if (reason) {
      return {
        content:
          `${reason}\n` +
          `Use run_background with this command instead:\n${command.replace(/\s*&\s*$/, "")}`,
        isError: true,
        display: "use run_background",
      };
    }
    const normalized = normalizePortableCommand(command);
    const runCommand = normalized.command;
    const timeout = Math.min(args.timeout_ms ?? MAX_FOREGROUND_MS, MAX_FOREGROUND_MS);
    const sandboxed = !ctx.approved && !args.allow_unsandboxed;
    const proc = Bun.spawn(sandboxed ? sandboxedShellCommand(runCommand, ctx.cwd) : ["bash", "-lc", runCommand], {
      cwd: ctx.cwd,
      env: sanitizedCommandEnvironment(),
      stdout: "pipe",
      stderr: "pipe",
      signal: ctx.signal,
    });

    const kill = () => {
      try {
        proc.kill();
      } catch {
        /* process may already be gone */
      }
    };
    const killTimer = setTimeout(kill, timeout);
    ctx.signal?.addEventListener("abort", kill, { once: true });
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      const combined = (stdout + (stderr ? `\n${stderr}` : "")).trim();
      const clipped =
        combined.length > 20_000
          ? combined.slice(0, 20_000) + "\n…(output truncated)"
          : combined;
      return {
        content:
          `$ ${command}\n` +
          (sandboxed && supportsCommandSandbox() ? "[runtime sandbox] network denied; writes limited to the working directory and temporary files\n" : "") +
          (normalized.note ? `[runtime portability] ${normalized.note}\n$ ${runCommand}\n` : "") +
          (clipped || "(no output)") +
          (exitCode !== 0 ? `\n[exit code ${exitCode}]` : ""),
        isError: exitCode !== 0,
        display: `exit ${exitCode}`,
      };
    } finally {
      clearTimeout(killTimer);
      ctx.signal?.removeEventListener("abort", kill);
    }
  },
};
