import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { resolvePath } from "../system/paths.ts";
import type { Tool } from "./types.ts";

const SCAFFOLD_TIMEOUT_MS = 15 * 60 * 1000;

const DEFAULT_SHADCN_COMPONENTS = [
  "button",
  "card",
  "input",
  "label",
  "textarea",
  "select",
  "dialog",
  "dropdown-menu",
  "tabs",
  "badge",
  "separator",
  "sheet",
];

function abs(cwd: string, p: string): string {
  return resolvePath(cwd, p);
}

function json(v: unknown): string {
  return `${JSON.stringify(v, null, 2)}\n`;
}

function assertProjectPath(cwd: string, rawPath: unknown): { root?: string; error?: string } {
  const path = String(rawPath ?? "").trim();
  if (!path) return { error: "path is required." };
  const root = abs(cwd, path);
  if (root === cwd) {
    return {
      error:
        `Refusing to scaffold directly into the active workspace root: ${root}\n` +
        "Choose a new child directory or explicit project folder.",
    };
  }
  return { root };
}

function isEmptyDir(path: string): boolean {
  return existsSync(path) && readdirSync(path).length === 0;
}

async function runStep(cmd: string[], cwd: string, signal?: AbortSignal): Promise<{ ok: boolean; text: string }> {
  const proc = Bun.spawn(cmd, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    signal,
  });
  const kill = () => {
    try {
      proc.kill();
    } catch {
      /* process may already be gone */
    }
  };
  const timer = setTimeout(kill, SCAFFOLD_TIMEOUT_MS);
  signal?.addEventListener("abort", kill, { once: true });
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const text = [`$ ${cmd.join(" ")}`, stdout.trim(), stderr.trim(), exitCode === 0 ? "" : `[exit code ${exitCode}]`]
      .filter(Boolean)
      .join("\n");
    return { ok: exitCode === 0, text };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", kill);
  }
}

/**
 * Drop a project SOPHIE.md so future sessions (which inject <cwd>/SOPHIE.md into
 * the prompt) start grounded in the stack, paths, and how to run/verify it —
 * instead of re-reading the whole tree each time. Never overwrites an existing
 * one. Best-effort: a write failure must not fail the scaffold.
 */
export function writeProjectMemory(root: string, body: string): void {
  try {
    const path = join(root, "SOPHIE.md");
    if (existsSync(path)) return;
    writeFileSync(path, body.endsWith("\n") ? body : `${body}\n`);
  } catch {
    /* non-fatal: scaffold succeeded regardless */
  }
}

function packageManagerCommand(pm: string, args: string[]): string[] | null {
  switch (pm) {
    case "pnpm":
      return ["pnpm", "dlx", "shadcn@latest", ...args];
    case "npm":
      return ["npx", "shadcn@latest", ...args];
    case "bun":
      return ["bunx", "shadcn@latest", ...args];
    case "yarn":
      return ["yarn", "dlx", "shadcn@latest", ...args];
    default:
      return null;
  }
}

export const scaffoldPythonProject: Tool = {
  name: "scaffold_python_project",
  description:
    "Create a ready-to-run Python project with pyproject.toml, package source, tests, .gitignore, README, and a local .venv. Use this instead of hand-writing Python setup commands.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory to create, relative to cwd unless absolute." },
      package_name: { type: "string", description: "Import/package name. Defaults to the folder name normalized for Python." },
      install_editable: { type: "boolean", description: "Run .venv/bin/python -m pip install -e . after creating the venv. Default true." },
      force_empty: { type: "boolean", description: "Allow using an existing empty directory. Default true." },
    },
    required: ["path"],
  },
  summarize: (a) => `scaffold python at ${a.path}`,
  risk: () => "caution",
  async execute(args, ctx) {
    const { root, error } = assertProjectPath(ctx.cwd, args.path);
    if (!root) return { content: error ?? "Invalid path.", isError: true };

    const forceEmpty = args.force_empty ?? true;
    if (existsSync(root) && !(forceEmpty && isEmptyDir(root))) {
      return { content: `Refusing to overwrite non-empty directory: ${root}`, isError: true };
    }

    const rawName = String(args.package_name ?? basename(root)).trim();
    const packageName = rawName.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^(\d)/, "_$1").toLowerCase() || "app";
    mkdirSync(join(root, packageName), { recursive: true });
    mkdirSync(join(root, "tests"), { recursive: true });

    writeFileSync(
      join(root, "setup.cfg"),
      `[metadata]
name = ${packageName.replace(/_/g, "-")}
version = 0.1.0

[options]
packages = find:
python_requires = >=3.9

[options.entry_points]
console_scripts =
    ${packageName} = ${packageName}.main:main
`,
    );
    // Keep pyproject present for modern tooling, but write setup.cfg too so
    // older pip versions in system-created venvs can still do editable installs.
    const pyprojectPath = join(root, "pyproject.toml");
    writeFileSync(
      pyprojectPath,
      `[project]
name = "${packageName.replace(/_/g, "-")}"
version = "0.1.0"
requires-python = ">=3.9"
dependencies = []

[project.scripts]
${packageName} = "${packageName}.main:main"

[build-system]
requires = ["setuptools"]
build-backend = "setuptools.build_meta"
`,
    );
    writeFileSync(join(root, "setup.py"), "from setuptools import setup\n\nsetup()\n");
    writeFileSync(join(root, packageName, "__init__.py"), "");
    writeFileSync(
      join(root, packageName, "main.py"),
      `def main() -> None:
    print("Hello from ${packageName}")


if __name__ == "__main__":
    main()
`,
    );
    writeFileSync(
      join(root, packageName, "__main__.py"),
      `from .main import main


main()
`,
    );
    writeFileSync(
      join(root, "tests", "test_main.py"),
      `from ${packageName}.main import main


def test_main_runs(capsys):
    main()
    assert "Hello from ${packageName}" in capsys.readouterr().out
`,
    );
    writeFileSync(join(root, ".gitignore"), ".venv/\n__pycache__/\n*.py[cod]\n.pytest_cache/\n");
    writeFileSync(join(root, "README.md"), `# ${packageName}\n\nPython project scaffolded by Sophie.\n`);

    const logs: string[] = [];
    const venv = await runStep(["python3", "-m", "venv", ".venv"], root, ctx.signal);
    logs.push(venv.text);
    if (!venv.ok) return { content: `Created files but failed to create venv.\n\n${logs.join("\n\n")}`, isError: true };

    if (args.install_editable ?? true) {
      // Old pip versions enter PEP 517 build isolation whenever pyproject.toml
      // exists, then try to download setuptools/wheel. For an offline local
      // scaffold, install through the setup.py/setup.cfg path and restore
      // pyproject.toml immediately afterward.
      const pyprojectPath = join(root, "pyproject.toml");
      const hiddenPyprojectPath = join(root, ".pyproject.toml.sophie-install");
      let hidPyproject = false;
      try {
        if (existsSync(pyprojectPath)) {
          renameSync(pyprojectPath, hiddenPyprojectPath);
          hidPyproject = true;
        }
        const install = await runStep([".venv/bin/python", "-m", "pip", "install", "-e", "."], root, ctx.signal);
        logs.push(install.text);
        if (!install.ok) {
          return { content: `Created project and venv, but editable install failed.\n\n${logs.join("\n\n")}`, isError: true };
        }
      } finally {
        if (hidPyproject && existsSync(hiddenPyprojectPath)) renameSync(hiddenPyprojectPath, pyprojectPath);
      }
    }

    writeProjectMemory(
      root,
      `# ${packageName}\n\n` +
        `Python project scaffolded by Sophie.\n\n` +
        `## Stack\n` +
        `- Python (>=3.9), packaged with pyproject.toml/setup.cfg (setuptools)\n` +
        `- Local virtualenv at \`.venv/\`\n\n` +
        `## Key paths\n` +
        `- \`${packageName}/\` — package source; \`${packageName}/main.py\` (entry: \`main()\`)\n` +
        `- \`tests/\` — pytest tests\n\n` +
        `## Run & verify\n` +
        `- Run: \`.venv/bin/python -m ${packageName}\`\n` +
        `- Test: \`.venv/bin/python -m pytest\`\n` +
        `- Use the project's \`.venv\` interpreter, not the system Python. Verify with verify_python_project.\n`,
    );

    return {
      content:
        `Created Python project in ${root}.\n\n` +
        `Package: ${packageName}\n` +
        "Files: pyproject.toml, README.md, .gitignore, package source, tests, .venv\n\n" +
        `Next commands:\n- cd ${root}\n- .venv/bin/python -m ${packageName}\n- .venv/bin/python -m pytest\n\n` +
        "Wrote SOPHIE.md with the stack, paths, and run/verify commands for future sessions.",
      display: `python scaffold ready: ${packageName}`,
    };
  },
};

export const scaffoldNextShadcnProject: Tool = {
  name: "scaffold_next_shadcn_project",
  description:
    "Create a new Next.js project with shadcn/ui initialized headlessly, then add a verified set of shadcn components. Use this for new Next.js apps when the user wants shadcn ready to go.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory to create, relative to cwd unless absolute." },
      package_manager: { type: "string", description: "One of pnpm, npm, bun, yarn. Default pnpm." },
      components: {
        type: "array",
        description: `shadcn components to add. Defaults to: ${DEFAULT_SHADCN_COMPONENTS.join(", ")}.`,
        items: { type: "string" },
      },
    },
    required: ["path"],
  } as any,
  summarize: (a) => `scaffold next+shadcn at ${a.path}`,
  risk: () => "caution",
  async execute(args, ctx) {
    const { root, error } = assertProjectPath(ctx.cwd, args.path);
    if (!root) return { content: error ?? "Invalid path.", isError: true };
    if (existsSync(root) && !isEmptyDir(root)) {
      return { content: `Refusing to overwrite non-empty directory: ${root}`, isError: true };
    }

    const pm = String(args.package_manager ?? "pnpm").trim();
    const requested = Array.isArray(args.components) && args.components.length
      ? args.components.map((c) => String(c).trim()).filter(Boolean)
      : DEFAULT_SHADCN_COMPONENTS;
    // The shadcn CLI validates names against the live registry and errors
    // clearly on unknown ones, so we don't keep a stale local allowlist.

    const init = packageManagerCommand(pm, ["init", "-t", "next", "--name", basename(root), "--yes", "--defaults"]);
    const add = packageManagerCommand(pm, ["add", ...requested, "--cwd", root, "--yes"]);
    if (!init || !add) {
      return { content: "package_manager must be one of: pnpm, npm, bun, yarn.", isError: true };
    }

    mkdirSync(dirname(root), { recursive: true });
    const logs: string[] = [];
    const initResult = await runStep(init, dirname(root), ctx.signal);
    logs.push(initResult.text);
    if (!initResult.ok) {
      return { content: `Failed to create Next.js + shadcn project.\n\n${logs.join("\n\n")}`, isError: true };
    }

    const addResult = await runStep(add, dirname(root), ctx.signal);
    logs.push(addResult.text);
    if (!addResult.ok) {
      return { content: `Created project, but failed to add shadcn components.\n\n${logs.join("\n\n")}`, isError: true };
    }

    writeProjectMemory(
      root,
      `# ${basename(root)}\n\n` +
        `Next.js + shadcn/ui app scaffolded by Sophie.\n\n` +
        `## Stack\n` +
        `- Next.js (App Router) + React + TypeScript\n` +
        `- shadcn/ui + Tailwind CSS\n` +
        `- Package manager: ${pm}\n\n` +
        `## Key paths\n` +
        `- \`app/\` — routes; \`app/page.tsx\` (home), \`app/layout.tsx\`, \`app/globals.css\`\n` +
        `- \`components/ui/\` — shadcn components; \`components.json\` — shadcn config\n` +
        `- \`lib/utils.ts\` — the \`cn()\` helper\n\n` +
        `## Components installed\n${requested.map((c) => `- ${c}`).join("\n")}\n\n` +
        `## Conventions\n` +
        `- Add more shadcn components with add_ui_component; when a trusted shadcn MCP server is configured, browse/search it first. ` +
        `Don't hand-write components that exist in the registry.\n` +
        `- Reuse existing \`components/ui\` parts and the \`cn()\` helper; keep Tailwind classes consistent with what's there.\n\n` +
        `## Run & verify\n` +
        `- Dev: \`${pm} run dev\` (port 3000) — start with run_background, not bash.\n` +
        `- Verify with verify_next_app / browser_check before claiming UI work is done.\n`,
    );

    return {
      content:
        `Created Next.js + shadcn project in ${root}.\n\n` +
        `Package manager: ${pm}\n` +
        `Added shadcn components: ${requested.join(", ")}\n\n` +
        `Next commands:\n- cd ${root}\n- ${pm} run dev\n\n` +
        "Use run_background for the dev server, then browser_check to verify the app.\n" +
        "Wrote SOPHIE.md with the stack, paths, and conventions for future sessions.",
      display: `next+shadcn ready: ${requested.length} components`,
    };
  },
};
