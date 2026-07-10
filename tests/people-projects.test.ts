/**
 * Tests for people store, projects store, and delegates store.
 * Each suite runs in an isolated SOPHIE_HOME tmp dir so the real
 * ~/.sophie is never touched.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── isolation setup ───────────────────────────────────────────────────────────

let home: string;
const origHome = process.env.SOPHIE_HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sophie-pp-"));
  process.env.SOPHIE_HOME = home;
  // Pre-create the .sophie dir so stores don't have to race to mkdir it.
  mkdirSync(join(home, ".sophie"), { recursive: true });
});

afterEach(() => {
  if (origHome === undefined) delete process.env.SOPHIE_HOME;
  else process.env.SOPHIE_HOME = origHome;
  rmSync(home, { recursive: true, force: true });
});

// ── people store ──────────────────────────────────────────────────────────────

describe("people store", () => {
  test("upsert creates a new record", async () => {
    const { upsertPerson, listPeople } = await import("../src/people/store.ts");
    const rec = upsertPerson({ name: "Paul Hunter", role: "investor", relationship: "Lead investor in Stivy." });
    expect(rec.name).toBe("Paul Hunter");
    expect(rec.role).toBe("investor");
    expect(rec.id).toMatch(/^p_/);
    expect(listPeople().length).toBe(1);
  });

  test("upsert merges arrays and appends notes on second call", async () => {
    const { upsertPerson } = await import("../src/people/store.ts");
    upsertPerson({ name: "Jane Smith", phones: ["555-1111"], tags: ["client"] });
    const merged = upsertPerson({ name: "Jane Smith", phones: ["555-2222"], tags: ["vip"], notes: "Great meeting today." });
    expect(merged.phones).toContain("555-1111");
    expect(merged.phones).toContain("555-2222");
    expect(merged.tags).toContain("client");
    expect(merged.tags).toContain("vip");
    expect(merged.notes).toContain("Great meeting today.");
  });

  test("upsert does not duplicate array entries", async () => {
    const { upsertPerson } = await import("../src/people/store.ts");
    upsertPerson({ name: "Bob", tags: ["friend"] });
    const r = upsertPerson({ name: "Bob", tags: ["friend"] });
    expect(r.tags.filter((t) => t === "friend").length).toBe(1);
  });

  test("lookup by exact name", async () => {
    const { upsertPerson, lookupPeople } = await import("../src/people/store.ts");
    upsertPerson({ name: "Alice Wang" });
    const hits = lookupPeople("Alice Wang");
    expect(hits.length).toBe(1);
    expect(hits[0]!.name).toBe("Alice Wang");
  });

  test("lookup by startsWith (case-insensitive)", async () => {
    const { upsertPerson, lookupPeople } = await import("../src/people/store.ts");
    upsertPerson({ name: "Carlos Rivera" });
    const hits = lookupPeople("carlos");
    expect(hits.length).toBe(1);
  });

  test("lookup by contains / tag", async () => {
    const { upsertPerson, lookupPeople } = await import("../src/people/store.ts");
    upsertPerson({ name: "Dana Kim", tags: ["advisor"] });
    const hits = lookupPeople("advisor");
    expect(hits.some((r) => r.name === "Dana Kim")).toBe(true);
  });

  test("lookup returns empty when no match", async () => {
    const { lookupPeople } = await import("../src/people/store.ts");
    expect(lookupPeople("nobody")).toEqual([]);
  });

  test("logContact bumps lastContact and appends note", async () => {
    const { upsertPerson, logContact } = await import("../src/people/store.ts");
    upsertPerson({ name: "Eve Torres" });
    const before = Date.now();
    const rec = logContact("Eve Torres", "Had a great call.");
    expect(rec).not.toBeNull();
    expect(rec!.lastContact).toBeGreaterThanOrEqual(before);
    expect(rec!.notes).toContain("Had a great call.");
  });

  test("logContact returns null for unknown person", async () => {
    const { logContact } = await import("../src/people/store.ts");
    expect(logContact("Nobody")).toBeNull();
  });

  test("addThread adds an open thread", async () => {
    const { upsertPerson, addThread } = await import("../src/people/store.ts");
    upsertPerson({ name: "Frank Lee" });
    const rec = addThread("Frank Lee", "Follow up on Q3 proposal");
    expect(rec!.openThreads).toContain("Follow up on Q3 proposal");
  });

  test("closeThread removes matching threads", async () => {
    const { upsertPerson, addThread, closeThread } = await import("../src/people/store.ts");
    upsertPerson({ name: "Grace Patel" });
    addThread("Grace Patel", "Send contract draft");
    addThread("Grace Patel", "Schedule intro call");
    const rec = closeThread("Grace Patel", "contract");
    expect(rec!.openThreads.some((t) => t.includes("contract"))).toBe(false);
    expect(rec!.openThreads.some((t) => t.includes("intro call"))).toBe(true);
  });

  test("deletePerson removes the record", async () => {
    const { upsertPerson, deletePerson, listPeople } = await import("../src/people/store.ts");
    upsertPerson({ name: "Hank Gray" });
    expect(listPeople().length).toBe(1);
    const ok = deletePerson("Hank Gray");
    expect(ok).toBe(true);
    expect(listPeople().length).toBe(0);
  });

  test("deletePerson returns false for unknown person", async () => {
    const { deletePerson } = await import("../src/people/store.ts");
    expect(deletePerson("Unknown Person")).toBe(false);
  });
});

// ── projects store ─────────────────────────────────────────────────────────────

describe("projects store", () => {
  test("upsertProject creates a new record", async () => {
    const { upsertProject, listProjects } = await import("../src/projects/store.ts");
    const p = upsertProject({ name: "Stivy", description: "SaaS booking platform", goals: ["Launch MVP"] });
    expect(p.name).toBe("Stivy");
    expect(p.status).toBe("active");
    expect(p.id).toMatch(/^proj_/);
    expect(listProjects().length).toBe(1);
  });

  test("upsertProject merges stakeholders on second call", async () => {
    const { upsertProject } = await import("../src/projects/store.ts");
    upsertProject({ name: "SolGames", stakeholders: ["Paul Hunter"] });
    const merged = upsertProject({ name: "SolGames", stakeholders: ["Jane Smith"] });
    expect(merged.stakeholders).toContain("Paul Hunter");
    expect(merged.stakeholders).toContain("Jane Smith");
  });

  test("upsertProject replaces milestones when provided", async () => {
    const { upsertProject } = await import("../src/projects/store.ts");
    upsertProject({ name: "TestProj", milestones: [{ title: "Alpha", done: false }] });
    const updated = upsertProject({
      name: "TestProj",
      milestones: [{ title: "Beta", done: false }, { title: "Launch", done: false }],
    });
    expect(updated.milestones.length).toBe(2);
    expect(updated.milestones[0]!.title).toBe("Beta");
  });

  test("lookupProject finds by name", async () => {
    const { upsertProject, lookupProject } = await import("../src/projects/store.ts");
    upsertProject({ name: "Apollo" });
    const p = lookupProject("apollo");
    expect(p).not.toBeUndefined();
    expect(p!.name).toBe("Apollo");
  });

  test("lookupProject finds by description substring", async () => {
    const { upsertProject, lookupProject } = await import("../src/projects/store.ts");
    upsertProject({ name: "Nexus", description: "Real-time analytics dashboard" });
    const p = lookupProject("analytics");
    expect(p!.name).toBe("Nexus");
  });

  test("listProjects filters by status", async () => {
    const { upsertProject, listProjects } = await import("../src/projects/store.ts");
    upsertProject({ name: "Active One", status: "active" });
    upsertProject({ name: "Paused One", status: "paused" });
    expect(listProjects("active").length).toBe(1);
    expect(listProjects("paused").length).toBe(1);
    expect(listProjects("all").length).toBe(2);
  });

  test("addMilestone appends a milestone", async () => {
    const { upsertProject, addMilestone } = await import("../src/projects/store.ts");
    upsertProject({ name: "Orion" });
    const p = addMilestone("Orion", { title: "Phase 1", done: false });
    expect(p!.milestones.length).toBe(1);
    expect(p!.milestones[0]!.title).toBe("Phase 1");
  });

  test("completeMilestone marks matching milestone done", async () => {
    const { upsertProject, addMilestone, completeMilestone } = await import("../src/projects/store.ts");
    upsertProject({ name: "Vega" });
    addMilestone("Vega", { title: "Design review", done: false });
    addMilestone("Vega", { title: "Code complete", done: false });
    const p = completeMilestone("Vega", "design");
    const m = p!.milestones.find((m) => m.title === "Design review")!;
    expect(m.done).toBe(true);
    expect(m.date).toBeGreaterThan(0);
    // Other milestone untouched
    expect(p!.milestones.find((m) => m.title === "Code complete")!.done).toBe(false);
  });

  test("addMilestone returns null for unknown project", async () => {
    const { addMilestone } = await import("../src/projects/store.ts");
    expect(addMilestone("NoProject", { title: "X", done: false })).toBeNull();
  });
});

// ── delegates store ───────────────────────────────────────────────────────────

describe("delegates store", () => {
  test("addDelegate creates a record", async () => {
    const { addDelegate, listDelegates } = await import("../src/agent/delegates.ts");
    const d = addDelegate({
      title: "Paul / Stivy updates",
      person: "Paul Hunter",
      topic: "Stivy progress",
      instruction: "Keep him informed on milestones and blockers.",
      channel: "imessage",
      autoSend: false,
    });
    expect(d.id).toMatch(/^del_/);
    expect(d.enabled).toBe(true);
    expect(d.lastSent).toBeNull();
    expect(listDelegates().length).toBe(1);
  });

  test("listDelegates excludes disabled by default", async () => {
    const { addDelegate, cancelDelegate, listDelegates } = await import("../src/agent/delegates.ts");
    const d1 = addDelegate({ title: "A", person: "Alice", topic: "t", instruction: "i", channel: "imessage", autoSend: false });
    const d2 = addDelegate({ title: "B", person: "Bob", topic: "t", instruction: "i", channel: "imessage", autoSend: false });
    cancelDelegate(d1.id);
    expect(listDelegates().length).toBe(1);
    expect(listDelegates()[0]!.id).toBe(d2.id);
    expect(listDelegates(true).length).toBe(2);
  });

  test("cancelDelegate disables the record", async () => {
    const { addDelegate, cancelDelegate, getDelegate } = await import("../src/agent/delegates.ts");
    const d = addDelegate({ title: "X", person: "X", topic: "t", instruction: "i", channel: "imessage", autoSend: false });
    cancelDelegate(d.id);
    // getDelegate still finds it
    const rec = getDelegate(d.id);
    expect(rec!.enabled).toBe(false);
  });

  test("cancelDelegate returns false for unknown id", async () => {
    const { cancelDelegate } = await import("../src/agent/delegates.ts");
    expect(cancelDelegate("del_nonexistent")).toBe(false);
  });
});

// ── prompt helpers ─────────────────────────────────────────────────────────────

describe("activeProjectsForPrompt", () => {
  test("returns empty string when no projects", async () => {
    const { activeProjectsForPrompt } = await import("../src/projects/store.ts");
    expect(activeProjectsForPrompt()).toBe("");
  });

  test("returns block for active projects only", async () => {
    const { upsertProject, activeProjectsForPrompt } = await import("../src/projects/store.ts");
    upsertProject({ name: "LiveApp", status: "active", description: "Main product" });
    upsertProject({ name: "OldThing", status: "archived" });
    const block = activeProjectsForPrompt();
    expect(block).toContain("# Active projects");
    expect(block).toContain("LiveApp");
    expect(block).not.toContain("OldThing");
  });

  test("includes milestone counts", async () => {
    const { upsertProject, addMilestone, completeMilestone, activeProjectsForPrompt } = await import("../src/projects/store.ts");
    upsertProject({ name: "Tracked" });
    addMilestone("Tracked", { title: "M1", done: false });
    addMilestone("Tracked", { title: "M2", done: false });
    completeMilestone("Tracked", "M1");
    const block = activeProjectsForPrompt();
    expect(block).toContain("1/2 milestones");
  });
});

describe("activeDelegatesForPrompt", () => {
  test("returns empty string when no delegates", async () => {
    const { activeDelegatesForPrompt } = await import("../src/agent/delegates.ts");
    expect(activeDelegatesForPrompt()).toBe("");
  });

  test("returns block for active delegates", async () => {
    const { addDelegate, activeDelegatesForPrompt } = await import("../src/agent/delegates.ts");
    addDelegate({
      title: "Paul / Stivy",
      person: "Paul Hunter",
      topic: "Stivy progress",
      instruction: "Weekly update on milestones.",
      channel: "imessage",
      autoSend: false,
    });
    const block = activeDelegatesForPrompt();
    expect(block).toContain("# Standing delegations");
    expect(block).toContain("Paul Hunter");
    expect(block).toContain("Stivy progress");
  });

  test("does not include disabled delegates", async () => {
    const { addDelegate, cancelDelegate, activeDelegatesForPrompt } = await import("../src/agent/delegates.ts");
    const d = addDelegate({ title: "X", person: "Zara", topic: "t", instruction: "i", channel: "imessage", autoSend: false });
    cancelDelegate(d.id);
    expect(activeDelegatesForPrompt()).toBe("");
  });
});
