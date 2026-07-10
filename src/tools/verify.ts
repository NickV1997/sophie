import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { isAbsolute, join, resolve } from "node:path";
import { addJournalEntry } from "../agent/tasks.ts";
import { browserCheck } from "./browser.ts";
import type { Tool, ToolResult } from "./types.ts";

type VerifyStatus = "PASS" | "FAIL" | "BLOCKED";

function abs(cwd: string, p: string): string {
  return isAbsolute(p) ? p : resolve(cwd, p);
}

function result(status: VerifyStatus, evidence: string, next: string[] = []): ToolResult {
  const content = [
    `STATUS: ${status}`,
    `EVIDENCE: ${evidence}`,
    `NEXT_ALLOWED_ACTIONS: ${next.length ? next.join("; ") : status === "PASS" ? "mark objective completed with this evidence" : "fix the failure or mark blocked"}`,
  ].join("\n");
  return {
    content,
    isError: status !== "PASS",
    display: status,
  };
}

async function run(cmd: string[], cwd: string, signal?: AbortSignal): Promise<{ code: number; text: string }> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", signal });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return {
    code,
    text: [stdout.trim(), stderr.trim()].filter(Boolean).join("\n").slice(0, 6000),
  };
}

function detectCommand(root: string, kind: string): string[] | null {
  const pkgPath = join(root, "package.json");
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
    const scripts = pkg.scripts ?? {};
    if (kind === "typecheck" && scripts.typecheck) return packageCommand(root, "typecheck");
    if (kind === "test" && scripts.test) return packageCommand(root, "test");
    if (kind === "lint" && scripts.lint) return packageCommand(root, "lint");
    if (kind === "build" && scripts.build) return packageCommand(root, "build");
    if (kind === "auto") {
      for (const script of ["typecheck", "test", "lint", "build"]) {
        if (scripts[script]) return packageCommand(root, script);
      }
    }
  }
  if (existsSync(join(root, "pyproject.toml"))) {
    if (kind === "test" || kind === "auto") {
      const venvPy = join(root, ".venv", "bin", "python");
      return [existsSync(venvPy) ? venvPy : "python3", "-m", "pytest"];
    }
  }
  return null;
}

function packageCommand(root: string, script: string): string[] {
  if (existsSync(join(root, "bun.lock"))) return ["bun", "run", script];
  if (existsSync(join(root, "pnpm-lock.yaml"))) return ["pnpm", "run", script];
  if (existsSync(join(root, "yarn.lock"))) return ["yarn", script];
  return ["npm", "run", script];
}

function pythonPackageName(root: string): string | null {
  const pyproject = join(root, "pyproject.toml");
  if (!existsSync(pyproject)) return null;
  const text = readFileSync(pyproject, "utf8");
  const script = text.match(/\[project\.scripts\][\s\S]*?\n([A-Za-z_][\w-]*)\s*=/);
  if (script) return script[1].replace(/-/g, "_");
  const name = text.match(/^\s*name\s*=\s*["']([^"']+)["']/m);
  return name ? name[1].replace(/[-.]/g, "_") : null;
}

function packageScriptExists(root: string, script: string): boolean {
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) return false;
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
  return Boolean(pkg.scripts?.[script]);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

async function waitForHttp(url: string, signal?: AbortSignal): Promise<boolean> {
  for (let i = 0; i < 80; i++) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      const res = await fetch(url, { signal });
      if (res.status < 500) return true;
    } catch {
      /* server not ready */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function runDetected(root: string, kind: string, signal?: AbortSignal): Promise<ToolResult> {
  const cmd = detectCommand(root, kind);
  if (!cmd) {
    return result("BLOCKED", `No ${kind} verifier command found in ${root}`, ["inspect package.json/pyproject.toml", "choose a manual verifier"]);
  }
  const out = await run(cmd, root, signal);
  const status: VerifyStatus = out.code === 0 ? "PASS" : "FAIL";
  const evidence = `$ ${cmd.join(" ")}\n${out.text || "(no output)"}\n[exit code ${out.code}]`;
  if (status === "PASS") {
    addJournalEntry({ kind: "verification", tool: "verify_project", summary: `${kind} verifier passed.`, evidence });
  }
  return result(status, evidence, status === "PASS" ? ["mark objective completed with this evidence"] : ["fix the reported failure", "rerun verifier"]);
}

export const verifyProject: Tool = {
  name: "verify_project",
  description:
    "Run a typed project verifier and return structured STATUS/EVIDENCE/NEXT_ALLOWED_ACTIONS. Use before completing coding jobs instead of ad hoc verification commands.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Project directory to verify. Defaults to cwd." },
      kind: { type: "string", enum: ["auto", "typecheck", "test", "lint", "build"], description: "Verifier type. Default auto." },
    },
  },
  summarize: (a) => `verify ${a.kind ?? "auto"} ${a.path ?? "."}`,
  risk: () => "safe",
  async execute(args, ctx) {
    const root = abs(ctx.cwd, String(args.path ?? "."));
    if (!existsSync(root)) return result("BLOCKED", `Project path does not exist: ${root}`, ["inspect the path"]);
    const kind = String(args.kind ?? "auto");
    return runDetected(root, kind, ctx.signal);
  },
};

export const verifyNextApp: Tool = {
  name: "verify_next_app",
  description:
    "Verify a Next.js app with structured PASS/FAIL/BLOCKED output. Checks package.json contains next and runs the build script when available.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Next.js project directory. Defaults to cwd." },
      start_dev: { type: "boolean", description: "Start a dev server on a free port and browser_check after build passes." },
      url: { type: "string", description: "Existing URL to browser_check instead of starting a dev server." },
      expected_text: { type: "string", description: "Text expected in the rendered page." },
      inspect_visual: { type: "boolean", description: "browser_check captures and inspects a screenshot with the vision model." },
    },
  },
  summarize: (a) => `verify next ${a.path ?? "."}`,
  risk: () => "safe",
  async execute(args, ctx) {
    const root = abs(ctx.cwd, String(args.path ?? "."));
    const pkgPath = join(root, "package.json");
    if (!existsSync(pkgPath)) return result("BLOCKED", `No package.json found in ${root}`, ["inspect the project path"]);
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, string> };
    if (!pkg.dependencies?.next && !pkg.devDependencies?.next) {
      return result("BLOCKED", `package.json in ${root} does not declare next`, ["inspect framework", "use verify_project instead"]);
    }
    if (!pkg.scripts?.build) return result("BLOCKED", "Next.js app has no build script.", ["add or inspect build script"]);
    const verified = await runDetected(root, "build", ctx.signal);
    if (verified.isError) return verified;

    const url = typeof args.url === "string" && args.url.trim() ? args.url.trim() : "";
    const shouldBrowserCheck = Boolean(args.start_dev) || Boolean(url);
    if (!shouldBrowserCheck) {
      addJournalEntry({ kind: "verification", tool: "verify_next_app", summary: "Next.js build verifier passed.", evidence: verified.content });
      return verified;
    }

    let proc: ReturnType<typeof Bun.spawn> | null = null;
    let checkUrl = url;
    try {
      if (!checkUrl) {
        if (!packageScriptExists(root, "dev")) {
          return result("BLOCKED", "Next.js app has no dev script for browser verification.", ["add dev script", "run verify_next_app without start_dev"]);
        }
        const port = await freePort();
        const cmd = packageCommand(root, "dev");
        proc = Bun.spawn(cmd, {
          cwd: root,
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, PORT: String(port), NEXT_TELEMETRY_DISABLED: "1" },
          signal: ctx.signal,
        });
        checkUrl = `http://127.0.0.1:${port}`;
        const ready = await waitForHttp(checkUrl, ctx.signal);
        if (!ready) return result("FAIL", `Dev server did not become ready at ${checkUrl}`, ["inspect dev server logs", "fix startup failure"]);
      }
      const browser = await browserCheck.execute({
        url: checkUrl,
        expected_text: args.expected_text,
        screenshot: true,
        inspect_visual: Boolean(args.inspect_visual),
      }, { cwd: root, signal: ctx.signal });
      if (browser.isError) {
        return result("FAIL", `${verified.content}\n\nBrowser verification failed:\n${browser.content}`, ["fix rendered UI/runtime errors", "rerun verify_next_app"]);
      }
      const evidence = `${verified.content}\n\nBrowser verification passed at ${checkUrl}:\n${browser.content}`;
      addJournalEntry({ kind: "verification", tool: "verify_next_app", summary: "Next.js build and browser verifier passed.", evidence });
      return result("PASS", evidence, ["mark objective completed with this evidence"]);
    } finally {
      try {
        proc?.kill();
      } catch {
        /* ignore */
      }
    }
  },
};

export const verifyPythonProject: Tool = {
  name: "verify_python_project",
  description:
    "Verify a Python project with structured PASS/FAIL/BLOCKED output. Uses .venv when present and runs pytest when available.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Python project directory. Defaults to cwd." },
    },
  },
  summarize: (a) => `verify python ${a.path ?? "."}`,
  risk: () => "safe",
  async execute(args, ctx) {
    const root = abs(ctx.cwd, String(args.path ?? "."));
    if (!existsSync(join(root, "pyproject.toml"))) return result("BLOCKED", `No pyproject.toml found in ${root}`, ["inspect the project path"]);
    let verified = await runDetected(root, "test", ctx.signal);
    // Fall back to an import check when pytest is missing OR when pytest ran but
    // collected no tests (exit 5 / "no tests ran"): a project that simply has no
    // tests yet shouldn't be reported as a hard verification failure.
    if (verified.display === "BLOCKED" || (verified.display === "FAIL" && /No module named pytest|pytest: command not found|no tests ran|collected 0 items/i.test(verified.content))) {
      const pkg = pythonPackageName(root);
      if (!pkg) return verified;
      const venvPy = join(root, ".venv", "bin", "python");
      const py = existsSync(venvPy) ? venvPy : "python3";
      const out = await run([py, "-c", `import ${pkg}; print(${pkg}.__name__)`], root, ctx.signal);
      const status: VerifyStatus = out.code === 0 ? "PASS" : "FAIL";
      verified = result(status, `$ ${py} -c 'import ${pkg}'\n${out.text || "(no output)"}\n[exit code ${out.code}]`, status === "PASS" ? ["mark objective completed with this evidence"] : ["fix package import", "rerun verifier"]);
    }
    if (!verified.isError) {
      addJournalEntry({ kind: "verification", tool: "verify_python_project", summary: "Python project verifier passed.", evidence: verified.content });
    }
    return verified;
  },
};

export const verifyStaticSite: Tool = {
  name: "verify_static_site",
  description:
    "Verify a static site structure with structured PASS/FAIL/BLOCKED output. Checks index.html and referenced local CSS/JS assets.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Static site directory. Defaults to cwd." },
    },
  },
  summarize: (a) => `verify static ${a.path ?? "."}`,
  risk: () => "safe",
  async execute(args, ctx) {
    const root = abs(ctx.cwd, String(args.path ?? "."));
    const index = join(root, "index.html");
    if (!existsSync(index)) return result("BLOCKED", `No index.html found in ${root}`, ["inspect the project path"]);
    const html = readFileSync(index, "utf8");
    const refs = [...html.matchAll(/(?:href|src)=["']\.\/([^"']+)["']/g)].map((m) => m[1]);
    const missing = refs.filter((ref) => !existsSync(join(root, ref)));
    if (missing.length) return result("FAIL", `Missing referenced local assets: ${missing.join(", ")}`, ["create missing assets", "fix index.html references"]);
    const evidence = `index.html exists and ${refs.length} local asset reference(s) were found; missing assets: 0`;
    addJournalEntry({ kind: "verification", tool: "verify_static_site", summary: "Static site verifier passed.", evidence });
    return result("PASS", evidence, ["mark objective completed with this evidence"]);
  },
};

export const verifyPackageInstall: Tool = {
  name: "verify_package_install",
  description:
    "Verify that npm package dependencies and/or shadcn component files are actually present. Returns structured PASS/FAIL/BLOCKED output.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Project directory. Defaults to cwd." },
      packages: { type: "array", items: { type: "string" }, description: "Package names expected in package.json dependencies/devDependencies." },
      shadcn_components: { type: "array", items: { type: "string" }, description: "shadcn component file basenames expected under components/ui or src/components/ui." },
    },
  } as any,
  summarize: (a) => `verify packages ${a.path ?? "."}`,
  risk: () => "safe",
  async execute(args, ctx) {
    const root = abs(ctx.cwd, String(args.path ?? "."));
    const pkgPath = join(root, "package.json");
    if (!existsSync(pkgPath)) return result("BLOCKED", `No package.json found in ${root}`, ["inspect project path"]);
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    const packages = Array.isArray(args.packages) ? args.packages.map(String).filter(Boolean) : [];
    const components = Array.isArray(args.shadcn_components) ? args.shadcn_components.map(String).filter(Boolean) : [];
    const missingPackages = packages.filter((p) => !deps[p]);
    const componentDirs = [join(root, "components", "ui"), join(root, "src", "components", "ui")];
    const missingComponents = components.filter((c) => !componentDirs.some((dir) => existsSync(join(dir, `${c}.tsx`)) || existsSync(join(dir, `${c}.ts`))));
    if (missingPackages.length || missingComponents.length) {
      return result(
        "FAIL",
        [
          missingPackages.length ? `Missing package(s): ${missingPackages.join(", ")}` : "",
          missingComponents.length ? `Missing shadcn component file(s): ${missingComponents.join(", ")}` : "",
        ].filter(Boolean).join("; "),
        ["inspect dependency/component names", "install or implement missing items", "rerun verifier"],
      );
    }
    const evidence = [
      packages.length ? `Packages present: ${packages.join(", ")}` : "No package expectations provided",
      components.length ? `shadcn component files present: ${components.join(", ")}` : "No shadcn component expectations provided",
    ].join("; ");
    addJournalEntry({ kind: "verification", tool: "verify_package_install", summary: "Package/component verifier passed.", evidence });
    return result("PASS", evidence, ["continue implementation or mark objective completed if all checks are done"]);
  },
};
