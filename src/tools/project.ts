import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { resolvePath } from "../system/paths.ts";
import type { Tool } from "./types.ts";

const SKIP = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".svelte-kit",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
  "target",
  ".turbo",
]);

const IMPORTANT = new Set([
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "README.md",
  "AGENTS.md",
  "AGENT.md",
  "CLAUDE.md",
  "SOPHIE.md",
  "tsconfig.json",
  "vite.config.ts",
  "next.config.js",
  "next.config.ts",
  "bun.lock",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);

function abs(cwd: string, p: string): string {
  return resolvePath(cwd, p);
}

function readJson(path: string): any | null {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export const projectMap: Tool = {
  name: "project_map",
  description:
    "Summarize a coding project without reading every file: top directories, " +
    "important config files, language/file counts, package scripts, and framework clues. " +
    "Use this early on large codebases before targeted grep/read_file calls.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Project root to inspect (defaults to cwd)." },
      max_files: { type: "number", description: "Maximum files to scan (default 1500, max 5000)." },
    },
    required: [],
  },
  summarize: (a) => `map ${a.path ?? "."}`,
  risk: () => "safe",
  async execute(args, ctx) {
    const root = abs(ctx.cwd, String(args.path ?? "."));
    if (!existsSync(root)) return { content: `Not found: ${root}`, isError: true };
    if (!statSync(root).isDirectory()) return { content: `${root} is not a directory.`, isError: true };

    const maxFiles = Math.min(Math.max(Number(args.max_files) || 1500, 100), 5000);
    const dirs = new Set<string>();
    const important: string[] = [];
    const extCounts = new Map<string, number>();
    const samples: string[] = [];
    let scanned = 0;
    let truncated = false;

    const walk = (dir: string, depth: number) => {
      if (scanned >= maxFiles) {
        truncated = true;
        return;
      }
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (scanned >= maxFiles) {
          truncated = true;
          return;
        }
        if (entry.name.startsWith(".") && entry.name !== ".github") continue;
        const full = join(dir, entry.name);
        const rel = relative(root, full);
        if (entry.isDirectory()) {
          if (SKIP.has(entry.name)) continue;
          if (depth <= 2) dirs.add(rel);
          if (depth < 5) walk(full, depth + 1);
          continue;
        }
        if (!entry.isFile()) continue;
        scanned++;
        const base = basename(entry.name);
        if (IMPORTANT.has(base) || rel.startsWith(".github/")) important.push(rel);
        const ext = extname(entry.name).slice(1) || base;
        extCounts.set(ext, (extCounts.get(ext) ?? 0) + 1);
        if (samples.length < 80) samples.push(rel);
      }
    };

    walk(root, 0);

    const pkgPath = join(root, "package.json");
    const pkg = existsSync(pkgPath) ? readJson(pkgPath) : null;
    const deps = pkg ? { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) } : {};
    const frameworks = [
      deps.next ? "Next.js" : "",
      deps.vite || existsSync(join(root, "vite.config.ts")) ? "Vite" : "",
      deps.react ? "React" : "",
      deps.vue ? "Vue" : "",
      deps.svelte ? "Svelte" : "",
      deps.express ? "Express" : "",
      deps["@opentui/react"] ? "OpenTUI React" : "",
      existsSync(join(root, "pyproject.toml")) ? "Python" : "",
      existsSync(join(root, "Cargo.toml")) ? "Rust" : "",
      existsSync(join(root, "go.mod")) ? "Go" : "",
      existsSync(join(root, "bun.lock")) ? "Bun" : "",
    ].filter(Boolean);

    const topExt = [...extCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([ext, n]) => `.${ext}: ${n}`)
      .join(", ");

    const scripts = pkg?.scripts
      ? Object.entries(pkg.scripts).map(([k, v]) => `- ${k}: ${v}`).join("\n")
      : "(none detected)";

    return {
      content:
        `Project: ${root}\n` +
        `Scanned files: ${scanned}${truncated ? ` (truncated at ${maxFiles})` : ""}\n` +
        `Framework clues: ${frameworks.length ? frameworks.join(", ") : "(none detected)"}\n` +
        `Top file types: ${topExt || "(none)"}\n\n` +
        `Top directories:\n${[...dirs].slice(0, 60).map((d) => `- ${d}/`).join("\n") || "(none)"}\n\n` +
        `Important files:\n${important.slice(0, 80).map((f) => `- ${f}`).join("\n") || "(none)"}\n\n` +
        `Package scripts:\n${scripts}\n\n` +
        `Sample files:\n${samples.slice(0, 80).map((f) => `- ${f}`).join("\n")}`,
      display: `${scanned} files · ${frameworks.join(", ") || "no framework"}`,
    };
  },
};
