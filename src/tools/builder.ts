import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { addJournalEntry } from "../agent/tasks.ts";
import { noteFileTouch } from "../agent/workset.ts";
import type { Tool, ToolResult } from "./types.ts";
import { sanitizedCommandEnvironment, sandboxedShellCommand, supportsCommandSandbox } from "../system/command-sandbox.ts";

/**
 * Builder tools — the deterministic chores every project build repeats, moved
 * off the model and into the runtime. Instead of the model reconstructing the
 * right package-manager incantation each time (and getting it wrong on a small
 * model), it calls one intent-level tool and the runtime picks the exact command
 * from the project's own lockfiles/manifests.
 *
 *   install_deps       — install dependencies (or add named packages)
 *   add_ui_component    — add shadcn/ui components via the project's package manager
 *   project_checks      — run every check the project defines (typecheck/lint/test/build/pytest)
 *   git_checkpoint      — git init (if needed) + commit a snapshot for easy rollback
 */

const BUILD_TIMEOUT_MS = 15 * 60 * 1000;

function abs(cwd: string, p: string): string {
  return isAbsolute(p) ? p : resolve(cwd, p);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function run(cmd: string[], cwd: string, signal?: AbortSignal, sandboxed = false): Promise<{ code: number; text: string }> {
  const argv = sandboxed ? sandboxedShellCommand(cmd.map(shellQuote).join(" "), cwd) : cmd;
  const proc = Bun.spawn(argv, { cwd, env: sanitizedCommandEnvironment(), stdout: "pipe", stderr: "pipe", signal });
  const kill = () => {
    try {
      proc.kill();
    } catch {
      /* already gone */
    }
  };
  const timer = setTimeout(kill, BUILD_TIMEOUT_MS);
  signal?.addEventListener("abort", kill, { once: true });
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const text = [`$ ${cmd.join(" ")}`, [stdout.trim(), stderr.trim()].filter(Boolean).join("\n").slice(0, 5000), `[exit ${code}]`]
      .filter(Boolean)
      .join("\n");
    return { code, text };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", kill);
  }
}

type NodePM = "bun" | "pnpm" | "yarn" | "npm";

/** Detect the Node package manager from lockfiles, then packageManager field. */
function detectNodePM(root: string): NodePM | null {
  if (!existsSync(join(root, "package.json"))) return null;
  if (existsSync(join(root, "bun.lock")) || existsSync(join(root, "bun.lockb"))) return "bun";
  if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(root, "yarn.lock"))) return "yarn";
  if (existsSync(join(root, "package-lock.json"))) return "npm";
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { packageManager?: string };
    if (pkg.packageManager?.startsWith("pnpm")) return "pnpm";
    if (pkg.packageManager?.startsWith("yarn")) return "yarn";
    if (pkg.packageManager?.startsWith("bun")) return "bun";
  } catch {
    /* ignore malformed package.json */
  }
  return "npm";
}

function installCmd(pm: NodePM, packages: string[], dev: boolean): string[] {
  if (!packages.length) {
    return pm === "npm" ? ["npm", "install"] : [pm, "install"];
  }
  switch (pm) {
    case "bun": return ["bun", "add", ...(dev ? ["-d"] : []), ...packages];
    case "pnpm": return ["pnpm", "add", ...(dev ? ["-D"] : []), ...packages];
    case "yarn": return ["yarn", "add", ...(dev ? ["-D"] : []), ...packages];
    default: return ["npm", "install", ...(dev ? ["--save-dev"] : []), ...packages];
  }
}

/** shadcn CLI runner per package manager. */
function shadcnCmd(pm: NodePM, args: string[]): string[] {
  switch (pm) {
    case "bun": return ["bunx", "shadcn@latest", ...args];
    case "pnpm": return ["pnpm", "dlx", "shadcn@latest", ...args];
    case "yarn": return ["yarn", "dlx", "shadcn@latest", ...args];
    default: return ["npx", "shadcn@latest", ...args];
  }
}

export const installDeps: Tool = {
  name: "install_deps",
  description:
    "Install project dependencies, or add specific packages, using the project's own package manager (auto-detected from its lockfile: bun/pnpm/yarn/npm; pip for Python). Prefer this over hand-writing install commands — the runtime picks the right tool and flags.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Project directory. Defaults to cwd." },
      packages: { type: "array", items: { type: "string" }, description: "Specific packages to add. Omit to install everything from the manifest." },
      dev: { type: "boolean", description: "Add as dev dependencies (Node only). Default false." },
    },
  } as any,
  summarize: (a) => (Array.isArray(a.packages) && a.packages.length ? `install ${a.packages.join(" ")}` : "install deps"),
  risk: () => "caution",
  async execute(args, ctx) {
    const root = abs(ctx.cwd, String(args.path ?? "."));
    if (!existsSync(root)) return { content: `Path does not exist: ${root}`, isError: true };
    const packages = Array.isArray(args.packages) ? args.packages.map(String).filter(Boolean) : [];
    const dev = args.dev === true;

    const pm = detectNodePM(root);
    if (pm) {
      const out = await run(installCmd(pm, packages, dev), root, ctx.signal);
      const ok = out.code === 0;
      addJournalEntry({ kind: ok ? "tool_result" : "blocker", tool: "install_deps", summary: ok ? `${pm} install ok` : `${pm} install failed`, evidence: out.text, isError: !ok });
      return { content: out.text, isError: !ok, display: ok ? `${pm} install ok` : `${pm} install failed` };
    }

    // Python fallback.
    if (existsSync(join(root, "pyproject.toml")) || existsSync(join(root, "requirements.txt"))) {
      const venvPy = join(root, ".venv", "bin", "python");
      const py = existsSync(venvPy) ? venvPy : "python3";
      const cmd = packages.length
        ? [py, "-m", "pip", "install", ...packages]
        : existsSync(join(root, "requirements.txt"))
          ? [py, "-m", "pip", "install", "-r", "requirements.txt"]
          : [py, "-m", "pip", "install", "-e", "."];
      const out = await run(cmd, root, ctx.signal);
      const ok = out.code === 0;
      return { content: out.text, isError: !ok, display: ok ? "pip install ok" : "pip install failed" };
    }

    return { content: `No package manifest found in ${root} (package.json / pyproject.toml / requirements.txt).`, isError: true, display: "no manifest" };
  },
};

export const addUiComponent: Tool = {
  name: "add_ui_component",
  description:
    "Add shadcn/ui components to a Next/React project (runs the shadcn CLI with the project's package manager). Use this to install components instead of hand-writing them — browse/search the registry first with the mcp__shadcn__* tools if you're unsure of the exact names.",
  parameters: {
    type: "object",
    properties: {
      components: { type: "array", items: { type: "string" }, description: "Component names, e.g. ['button','card','dialog']." },
      path: { type: "string", description: "Project directory. Defaults to cwd." },
    },
    required: ["components"],
  } as any,
  summarize: (a) => `add ui: ${(Array.isArray(a.components) ? a.components : []).join(", ")}`,
  risk: () => "caution",
  async execute(args, ctx) {
    const root = abs(ctx.cwd, String(args.path ?? "."));
    const components = Array.isArray(args.components) ? args.components.map(String).map((s) => s.trim()).filter(Boolean) : [];
    if (!components.length) return { content: "add_ui_component needs a non-empty 'components' array.", isError: true };
    if (!existsSync(join(root, "package.json"))) return { content: `No package.json in ${root} — this is not a Node/Next project.`, isError: true };
    if (!existsSync(join(root, "components.json"))) {
      return {
        content: "No components.json found — shadcn is not initialized here. Initialize it first (scaffold_next_shadcn_project, or `shadcn@latest init`).",
        isError: true,
        display: "shadcn not initialized",
      };
    }
    const pm = detectNodePM(root) ?? "npm";
    const out = await run(shadcnCmd(pm, ["add", ...components, "--yes"]), root, ctx.signal);
    const ok = out.code === 0;
    addJournalEntry({ kind: ok ? "tool_result" : "blocker", tool: "add_ui_component", summary: ok ? `added ${components.join(", ")}` : "shadcn add failed", evidence: out.text, isError: !ok });
    return { content: out.text, isError: !ok, display: ok ? `added ${components.length} component(s)` : "shadcn add failed" };
  },
};

export const projectChecks: Tool = {
  name: "project_checks",
  description:
    "Run every quality gate the project defines and report a combined pass/fail — typecheck, lint, test, and build for Node projects (from package.json scripts, using the right package manager) or pytest for Python. Use this as the single 'is it healthy?' check before calling a build done, instead of running each command by hand.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Project directory. Defaults to cwd." },
      only: { type: "array", items: { type: "string" }, description: "Restrict to these gates, e.g. ['typecheck','test']. Omit to run all available." },
      allow_unsandboxed: { type: "boolean", description: "Run project scripts without the network/write sandbox. Requires explicit approval." },
    },
  } as any,
  summarize: (a) => `project checks ${a.path ?? "."}`,
  risk: (a) => a.allow_unsandboxed || !supportsCommandSandbox() ? "caution" : "safe",
  async execute(args, ctx): Promise<ToolResult> {
    const root = abs(ctx.cwd, String(args.path ?? "."));
    if (!existsSync(root)) return { content: `Path does not exist: ${root}`, isError: true };
    const only = Array.isArray(args.only) ? args.only.map(String) : null;

    const gates: { name: string; cmd: string[] }[] = [];
    const pkgPath = join(root, "package.json");
    if (existsSync(pkgPath)) {
      const pm = detectNodePM(root) ?? "npm";
      const runner = (s: string) => (pm === "yarn" ? ["yarn", s] : [pm, "run", s]);
      let scripts: Record<string, string> = {};
      try {
        scripts = (JSON.parse(readFileSync(pkgPath, "utf8")).scripts ?? {}) as Record<string, string>;
      } catch {
        return { content: `package.json in ${root} is not valid JSON.`, isError: true };
      }
      for (const gate of ["typecheck", "lint", "test", "build"]) {
        if (scripts[gate] && (!only || only.includes(gate))) gates.push({ name: gate, cmd: runner(gate) });
      }
    } else if (existsSync(join(root, "pyproject.toml")) || existsSync(join(root, "tests"))) {
      const venvPy = join(root, ".venv", "bin", "python");
      const py = existsSync(venvPy) ? venvPy : "python3";
      if (!only || only.includes("test")) gates.push({ name: "pytest", cmd: [py, "-m", "pytest", "-q"] });
    }

    if (!gates.length) {
      return { content: `No runnable checks found in ${root} (no matching package.json scripts or Python tests).`, isError: true, display: "no checks" };
    }

    const lines: string[] = [];
    let failed = 0;
    for (const gate of gates) {
      const out = await run(gate.cmd, root, ctx.signal, !ctx.approved && !args.allow_unsandboxed);
      const pass = out.code === 0;
      if (!pass) failed++;
      lines.push(`${pass ? "PASS" : "FAIL"} · ${gate.name}\n${out.text}`);
    }
    const summary = gates.map((g, i) => `${lines[i]!.startsWith("PASS") ? "✓" : "✗"} ${g.name}`).join("  ");
    const body = `PROJECT CHECKS (${gates.length - failed}/${gates.length} passed): ${summary}\n\n${lines.join("\n\n")}`;
    addJournalEntry({ kind: failed ? "blocker" : "verification", tool: "project_checks", summary: `${gates.length - failed}/${gates.length} checks passed`, evidence: body.slice(0, 800), isError: failed > 0 });
    return { content: body, isError: failed > 0, display: `${gates.length - failed}/${gates.length} checks passed` };
  },
};

export const gitCheckpoint: Tool = {
  name: "git_checkpoint",
  description:
    "Initialize git if needed and commit a snapshot of the project's current state, so work can be reviewed or rolled back. Use after a meaningful step (scaffold, feature, passing checks). Commits locally only — never pushes.",
  parameters: {
    type: "object",
    properties: {
      message: { type: "string", description: "Commit message describing the checkpoint." },
      path: { type: "string", description: "Project directory. Defaults to cwd." },
    },
    required: ["message"],
  },
  summarize: (a) => `checkpoint: ${String(a.message ?? "").slice(0, 40)}`,
  risk: () => supportsCommandSandbox() ? "safe" : "caution",
  async execute(args, ctx) {
    const root = abs(ctx.cwd, String(args.path ?? "."));
    if (!existsSync(root)) return { content: `Path does not exist: ${root}`, isError: true };
    const message = String(args.message ?? "").trim() || "checkpoint";
    const logs: string[] = [];
    if (!existsSync(join(root, ".git"))) {
      logs.push((await run(["git", "init"], root, ctx.signal, true)).text);
      // Set a local identity so commits don't fail on a fresh machine.
      await run(["git", "config", "user.email", "sophie@localhost"], root, ctx.signal, true);
      await run(["git", "config", "user.name", "Sophie"], root, ctx.signal, true);
    }
    logs.push((await run(["git", "add", "-A"], root, ctx.signal, true)).text);
    const commit = await run(["git", "commit", "-m", message], root, ctx.signal, true);
    logs.push(commit.text);
    const nothingToCommit = /nothing to commit/i.test(commit.text);
    const ok = commit.code === 0 || nothingToCommit;
    return {
      content: logs.join("\n\n"),
      isError: !ok,
      display: nothingToCommit ? "nothing to commit" : ok ? "checkpoint committed" : "commit failed",
    };
  },
};
