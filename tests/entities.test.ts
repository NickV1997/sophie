import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { addDelegate } from "../src/agent/delegates.ts";
import { addAssistantTask } from "../src/assistant_tasks/store.ts";
import { addEvent } from "../src/calendar/store.ts";
import { upsertPerson } from "../src/people/store.ts";
import { upsertProject } from "../src/projects/store.ts";
import { entityLinks, findEntities, getEntity, resetEntityDbForTests } from "../src/system/entities.ts";

let home = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.SOPHIE_HOME;
  home = mkdtempSync(join(tmpdir(), "sophie-entities-"));
  process.env.SOPHIE_HOME = home;
  resetEntityDbForTests();
});

afterEach(() => {
  resetEntityDbForTests();
  if (previousHome === undefined) delete process.env.SOPHIE_HOME;
  else process.env.SOPHIE_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

describe("unified entity graph", () => {
  test("keeps stable entity ids and grows aliases across updates", () => {
    const person = upsertPerson({ name: "Avery Chen", aliases: ["Avery"], emails: ["avery@example.com"] });
    const first = getEntity("person", person.id)!;
    upsertPerson({ name: "Avery Chen", aliases: ["AC"], phones: ["+14165550100"] });
    const updated = getEntity("person", person.id)!;
    expect(updated.id).toBe(first.id);
    expect(updated.aliases).toEqual(expect.arrayContaining(["Avery", "AC", "avery@example.com", "+14165550100"]));
  });

  test("links tasks, stakeholders, and delegations to shared entities", () => {
    const person = upsertPerson({ name: "Avery Chen", aliases: ["Avery"] });
    const project = upsertProject({ name: "Launch", stakeholders: ["Avery"] });
    const task = addAssistantTask({ title: "Review launch brief", project: "Launch" });
    const delegation = addDelegate({ title: "Avery launch update", person: "Avery", topic: "Launch", instruction: "Draft a concise update", channel: "notify", autoSend: false });

    const projectEntity = getEntity("project", project.id)!;
    const taskEntity = getEntity("task", task.id)!;
    const delegationEntity = getEntity("delegation", delegation.id)!;
    expect(entityLinks(projectEntity.id).some((link) => link.entity.sourceId === person.id && link.relation === "has_stakeholder")).toBe(true);
    expect(entityLinks(taskEntity.id).some((link) => link.entity.sourceId === project.id && link.relation === "belongs_to_project")).toBe(true);
    expect(entityLinks(delegationEntity.id).some((link) => link.entity.sourceId === person.id && link.relation === "assigned_to_person")).toBe(true);
  });

  test("indexes internal calendar events", () => {
    const event = addEvent({ title: "Investor review", start: Date.now() + 86_400_000, end: Date.now() + 90_000_000, attendees: ["avery@example.com"], reminderLeads: [] });
    expect(getEntity("calendar_event", event.id)?.name).toBe("Investor review");
    expect(findEntities("avery@example.com", "calendar_event")[0]?.sourceId).toBe(event.id);
  });

  test("switches databases when SOPHIE_HOME changes", () => {
    upsertPerson({ name: "First Profile" });
    const second = mkdtempSync(join(tmpdir(), "sophie-entities-second-"));
    process.env.SOPHIE_HOME = second;
    try {
      expect(findEntities("First Profile", "person")).toHaveLength(0);
      upsertPerson({ name: "Second Profile" });
      expect(findEntities("Second Profile", "person")).toHaveLength(1);
    } finally {
      process.env.SOPHIE_HOME = home;
      resetEntityDbForTests();
      rmSync(second, { recursive: true, force: true });
    }
  });
});
