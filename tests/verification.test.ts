import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { addJournalEntry, beginObjective, clearTasks, setTasks, type JournalEntry } from "../src/agent/tasks.ts";
import { updateTasks } from "../src/tools/tasks.ts";
import { hasVerifierEvidence, lastFailedVerifier, missingVerifierMessage, needsVerifierEvidence } from "../src/agent/verification.ts";
import { verifyNextApp, verifyPackageInstall, verifyProject, verifyPythonProject, verifyStaticSite } from "../src/tools/verify.ts";

afterEach(() => clearTasks());

test("everyday plans do not require a coding verifier", () => {
  expect(needsVerifierEvidence({ content: "Build a practical workday plan", status: "active" }, [{ content: "Review calendar and inbox", status: "completed" }])).toBe(false);
  expect(needsVerifierEvidence({ content: "Build a Python CLI app", status: "active" }, [])).toBe(true);
});

function entry(p: Partial<JournalEntry> & { kind: JournalEntry["kind"]; summary: string }): JournalEntry {
  return { id: Math.random().toString(36).slice(2), at: Date.now(), ...p };
}

describe("failing-verifier handling", () => {
  test("lastFailedVerifier finds the most recent failed verifier/build", () => {
    const journal: JournalEntry[] = [
      entry({ kind: "tool_result", tool: "read_file", summary: "20 lines" }),
      entry({ kind: "blocker", tool: "verify_next_app", summary: "FAIL", evidence: "type error at page.tsx:202", isError: true }),
      entry({ kind: "tool_result", tool: "job_status", summary: "running" }),
    ];
    const failed = lastFailedVerifier(journal);
    expect(failed?.tool).toBe("verify_next_app");
  });

  test("non-verifier errors are not treated as failed verifiers", () => {
    const journal: JournalEntry[] = [entry({ kind: "blocker", tool: "read_file", summary: "missing", isError: true })];
    expect(lastFailedVerifier(journal)).toBeNull();
  });

  test("later verifier pass clears earlier failed verifier state", () => {
    const journal: JournalEntry[] = [
      entry({ kind: "blocker", tool: "verify_next_app", summary: "FAIL", evidence: "type error", isError: true }),
      entry({ kind: "verification", tool: "verify_next_app", summary: "PASS", evidence: "build passed" }),
    ];
    expect(lastFailedVerifier(journal)).toBeNull();
    expect(hasVerifierEvidence(null, journal)).toBe(true);
    expect(missingVerifierMessage(journal).toLowerCase()).toContain("run a concrete verifier");
  });

  test("later verifier failure overrides older pass", () => {
    const journal: JournalEntry[] = [
      entry({ kind: "verification", tool: "bash", summary: "test passed", evidence: "bun test exit 0" }),
      entry({ kind: "blocker", tool: "bash", summary: "build failed", evidence: "npm run build exited 1", isError: true }),
    ];
    expect(hasVerifierEvidence(null, journal)).toBe(false);
    expect(lastFailedVerifier(journal)?.summary).toBe("build failed");
  });

  test("gate message tells the model to FIX a failed verifier, not just 'run one'", () => {
    const journal: JournalEntry[] = [
      entry({ kind: "blocker", tool: "verify_next_app", summary: "FAIL", evidence: "type error", isError: true }),
    ];
    const msg = missingVerifierMessage(journal);
    expect(msg).toContain("verify_next_app");
    expect(msg.toLowerCase()).toContain("fail");
    expect(msg.toLowerCase()).toContain("fix");
    expect(msg).toContain("pre-existing"); // explicitly forbids the rationalization
  });

  test("gate message falls back to 'run a verifier' when none has run", () => {
    expect(missingVerifierMessage([]).toLowerCase()).toContain("run a concrete verifier");
  });

  test("update_tasks completion is still refused after a FAILED verifier", async () => {
    beginObjective("Fix the Next.js app build");
    setTasks([{ content: "Fix the page component", status: "completed" }]);
    addJournalEntry({ kind: "blocker", tool: "verify_next_app", summary: "FAIL", evidence: "type error", isError: true });

    const result = await updateTasks.execute({
      objective: "Fix the Next.js app build",
      objective_status: "completed",
      objective_evidence: "server runs; the type error is pre-existing",
      tasks: [{ content: "Fix the page component", status: "completed" }],
    }, { cwd: process.cwd() });

    expect(result.isError).toBe(true);
    expect(result.display).toBe("missing verifier");
    expect(result.content.toLowerCase()).toContain("fix");
  });
});

describe("verification contract", () => {
  test("refuses to complete coding objective without verifier evidence", async () => {
    beginObjective("Build a Next.js app");
    setTasks([{ content: "Implement page UI", status: "completed" }]);

    const result = await updateTasks.execute({
      objective: "Build a Next.js app",
      objective_status: "completed",
      objective_evidence: "I edited the page.",
      tasks: [{ content: "Implement page UI", status: "completed" }],
    }, { cwd: process.cwd() });

    expect(result.isError).toBe(true);
    expect(result.display).toBe("missing verifier");
  });

  test("allows coding objective completion after verifier evidence", async () => {
    beginObjective("Build a Next.js app");
    setTasks([{ content: "Implement page UI", status: "completed" }]);
    addJournalEntry({
      kind: "verification",
      tool: "bash",
      summary: "build passed",
      evidence: "npm run build exited 0",
    });
    setTasks([
      { content: "Implement page UI", status: "completed" },
      { content: "Verify build", status: "completed" },
    ]);

    const result = await updateTasks.execute({
      objective: "Build a Next.js app",
      objective_status: "completed",
      objective_evidence: "npm run build exited 0",
      tasks: [
        { content: "Implement page UI", status: "completed" },
        { content: "Verify build", status: "completed" },
      ],
    }, { cwd: process.cwd() });

    expect(result.isError).toBeUndefined();
    expect(result.display).toBe("2/2 done");
  });

  test("verify_project returns structured PASS for a detected npm script", async () => {
    const root = `/tmp/sophie-verify-test-${Date.now().toString(36)}`;
    mkdirSync(root, { recursive: true });
    writeFileSync(root + "/package.json", JSON.stringify({
      scripts: { typecheck: "node -e \"process.exit(0)\"" },
    }));

    const result = await verifyProject.execute({ path: root, kind: "typecheck" }, { cwd: process.cwd() });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("STATUS: PASS");
    expect(result.content).toContain("NEXT_ALLOWED_ACTIONS:");
  });

  test("verify_project returns structured BLOCKED when no verifier exists", async () => {
    const root = `/tmp/sophie-verify-empty-${Date.now().toString(36)}`;
    mkdirSync(root, { recursive: true });
    const result = await verifyProject.execute({ path: root, kind: "auto" }, { cwd: process.cwd() });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("STATUS: BLOCKED");
  });

  test("verify_static_site passes for existing local assets", async () => {
    const root = `/tmp/sophie-static-verify-${Date.now().toString(36)}`;
    mkdirSync(root, { recursive: true });
    writeFileSync(root + "/index.html", '<link rel="stylesheet" href="./styles.css"><script src="./app.js"></script>');
    writeFileSync(root + "/styles.css", "body{}");
    writeFileSync(root + "/app.js", "console.log('ok')");
    const result = await verifyStaticSite.execute({ path: root }, { cwd: process.cwd() });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("STATUS: PASS");
  });

  test("verify_next_app blocks when package is not Next.js", async () => {
    const root = `/tmp/sophie-next-blocked-${Date.now().toString(36)}`;
    mkdirSync(root, { recursive: true });
    writeFileSync(root + "/package.json", JSON.stringify({ dependencies: {}, scripts: { build: "node -e 0" } }));
    const result = await verifyNextApp.execute({ path: root }, { cwd: process.cwd() });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("STATUS: BLOCKED");
  });

  test("verify_package_install passes for dependency and shadcn component file", async () => {
    const root = `/tmp/sophie-package-verify-${Date.now().toString(36)}`;
    mkdirSync(`${root}/components/ui`, { recursive: true });
    writeFileSync(root + "/package.json", JSON.stringify({ dependencies: { "lucide-react": "^1.0.0" } }));
    writeFileSync(`${root}/components/ui/button.tsx`, "export function Button(){return null}");
    const result = await verifyPackageInstall.execute({ path: root, packages: ["lucide-react"], shadcn_components: ["button"] }, { cwd: process.cwd() });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("STATUS: PASS");
  });

  test("verify_python_project falls back to import check when pytest is unavailable", async () => {
    const root = `/tmp/sophie-python-verify-${Date.now().toString(36)}`;
    mkdirSync(`${root}/demo_pkg`, { recursive: true });
    writeFileSync(root + "/pyproject.toml", `[project]\nname = "demo-pkg"\nversion = "0.1.0"\n`);
    writeFileSync(`${root}/demo_pkg/__init__.py`, "");
    const result = await verifyPythonProject.execute({ path: root }, { cwd: process.cwd() });
    expect(result.content).toContain("STATUS:");
    expect(result.content).toContain("import demo_pkg");
  });
});
