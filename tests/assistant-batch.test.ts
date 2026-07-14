import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAssistantTasks } from "../src/assistant_tasks/store.ts";
import { listPeople } from "../src/people/store.ts";
import { listProjects } from "../src/projects/store.ts";
import { getTool } from "../src/tools/registry.ts";

let home: string;
const originalHome = process.env.SOPHIE_HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sophie-batch-"));
  process.env.SOPHIE_HOME = home;
  mkdirSync(home, { recursive: true });
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.SOPHIE_HOME;
  else process.env.SOPHIE_HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

describe("small-model-friendly assistant batches", () => {
  test("creates projects, people, and tasks with one call per record type", async () => {
    const projects = await getTool("projects")!.execute({ action: "add", projects: [
      { name: "Northstar", stakeholders: ["Dana"] },
      { name: "Maple Dental", stakeholders: ["Luis"] },
    ] }, {} as any);
    const people = await getTool("people")!.execute({ action: "upsert", people: [
      { name: "Dana", role: "client owner" },
      { name: "Luis", role: "client owner" },
    ] }, {} as any);
    const tasks = await getTool("manage_tasks")!.execute({ action: "add", tasks: [
      { title: "Northstar launch", project: "Northstar" },
      { title: "Maple monthly report", project: "Maple Dental" },
    ] }, {} as any);
    expect(projects.isError).not.toBe(true);
    expect(people.isError).not.toBe(true);
    expect(tasks.isError).not.toBe(true);
    expect(listProjects("all").map((item) => item.name)).toEqual(expect.arrayContaining(["Northstar", "Maple Dental"]));
    expect(listPeople().map((item) => item.name)).toEqual(expect.arrayContaining(["Dana", "Luis"]));
    expect(readAssistantTasks().map((item) => item.title)).toEqual(expect.arrayContaining(["Northstar launch", "Maple monthly report"]));
  });

  test("validates every item before writing a malformed batch", async () => {
    const result = await getTool("projects")!.execute({ action: "add", projects: [{ name: "Good" }, { description: "missing name" }] }, {} as any);
    expect(result.isError).toBe(true);
    expect(listProjects("all")).toHaveLength(0);
  });

  test("rejects an ISO due date that contradicts its own weekday note", async () => {
    const result = await getTool("manage_tasks")!.execute({
      action: "add",
      tasks: [{ title: "Pay electricity bill", due: "2026-09-15", notes: "Due Friday" }],
    }, {} as any);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("is tuesday");
    expect(result.content).toContain("says friday");
  });
});
