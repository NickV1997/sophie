import { describe, expect, test } from "bun:test";
import { argumentRepairMessages, parseArgumentRepairReply } from "../src/agent/argument_repair.ts";
import { messagesTokens } from "../src/agent/context.ts";
import { projectsTool } from "../src/tools/projects.ts";

describe("focused schema argument repair", () => {
  test("accepts only the pinned tool and object arguments", () => {
    expect(parseArgumentRepairReply(
      '```json\n{"name":"projects","arguments":{"action":"add","projects":[{"name":"Hiring pipeline"}]}}\n```',
      "projects",
    )?.arguments).toMatchObject({ action: "add" });
    expect(parseArgumentRepairReply('{"name":"email","arguments":{}}', "projects")).toBeNull();
    expect(parseArgumentRepairReply('{"name":"projects","arguments":[]}', "projects")).toBeNull();
    expect(parseArgumentRepairReply("not json", "projects")).toBeNull();
  });

  test("repair prompt is compact and supplies the exact nested schema error", () => {
    const messages = argumentRepairMessages(
      { name: "projects", arguments: { action: "add", projects: [{ description: "Track hiring" }] }, raw: "" },
      projectsTool,
      ["projects.projects[0].name is required"],
      "Create a hiring pipeline project.",
    );
    expect(messages[1]!.content).toContain("projects.projects[0].name is required");
    expect(messagesTokens(messages)).toBeLessThan(900);
  });
});
