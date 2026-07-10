import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { listEpisodes, loadEpisode, saveEpisodeSnapshot, searchVerifiedEpisodes } from "../src/agent/episodes.ts";
import type { EpisodeSnapshot } from "../src/agent/episodes.ts";

describe("episodes", () => {
  test("save/list/load episode snapshot", () => {
    process.env.SOPHIE_EPISODES_DIR = `/tmp/sophie-episodes-test-${Date.now().toString(36)}`;
    mkdirSync(process.env.SOPHIE_EPISODES_DIR, { recursive: true });
    const id = `job-test-${Date.now().toString(36)}`;
    const snapshot: EpisodeSnapshot = {
      job: {
        id,
        title: "Test episode",
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      sessionId: "s-test",
      cwd: process.cwd(),
      updatedAt: Date.now(),
      objective: {
        jobId: id,
        content: "Test episode",
        status: "active",
      },
      tasks: [
        { jobId: id, content: "Do work", status: "in_progress" },
        { jobId: id, content: "Verify", status: "pending" },
      ],
      journal: [],
    };

    saveEpisodeSnapshot(snapshot);
    expect(loadEpisode(id)?.job.title).toBe("Test episode");
    const listed = listEpisodes().find((e) => e.id === id);
    expect(listed?.openTasks).toBe(2);
    expect(listed?.status).toBe("active");
  });

  test("searchVerifiedEpisodes returns only verified evidence", () => {
    process.env.SOPHIE_EPISODES_DIR = `/tmp/sophie-episodes-search-${Date.now().toString(36)}`;
    mkdirSync(process.env.SOPHIE_EPISODES_DIR, { recursive: true });
    const id = `job-search-${Date.now().toString(36)}`;
    saveEpisodeSnapshot({
      job: { id, title: "Next.js shadcn dashboard", status: "completed", phase: "completed", createdAt: Date.now(), updatedAt: Date.now() },
      sessionId: "s-search",
      cwd: process.cwd(),
      updatedAt: Date.now(),
      objective: { jobId: id, content: "Build dashboard", status: "completed", evidence: "build passed" },
      tasks: [{ jobId: id, content: "Build dashboard", status: "completed" }],
      journal: [
        { id: "j1", jobId: id, kind: "tool_result", at: Date.now(), summary: "edited files" },
        { id: "j2", jobId: id, kind: "verification", at: Date.now(), summary: "build passed", evidence: "npm run build exit 0" },
      ],
    });

    const results = searchVerifiedEpisodes("shadcn dashboard build");
    expect(results.length).toBe(1);
    expect(results[0]).toContain("verification: build passed");
    expect(results[0]).not.toContain("edited files");
  });
});
