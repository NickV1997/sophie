/**
 * Reflection on failure — the loop that makes Sophie improve with use.
 *
 * When a job finishes SUCCESSFULLY but its journal shows real failures along
 * the way (≥2 errored entries), we distill what went wrong and what finally
 * worked into one transferable lesson and store it as a "convention" memory.
 * Lessons flow back through the normal per-turn recall path, so the next time
 * a similar task comes up the hard-won fix is already in context.
 *
 * Runs fire-and-forget at the end of a turn (one small non-thinking model
 * call); failures are swallowed — reflection must never break a reply.
 */
import { completeChat } from "../llm/client.ts";
import { stripThink } from "./context.ts";
import { addMemory } from "../memory/facts.ts";
import { addJournalEntry, getCurrentJob, getJournal, type JournalEntry } from "./tasks.ts";

const reflectedJobs = new Set<string>();
const UNTRUSTED_TOOLS = new Set(["web_search", "web_fetch", "email", "apple", "read_document", "browser_check", "browser_act", "http_request"]);
function trustedForLearning(entry: JournalEntry): boolean {
  return !entry.tool || (!UNTRUSTED_TOOLS.has(entry.tool) && !entry.tool.startsWith("mcp__"));
}

function clip(s: string | undefined, n: number): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

async function distillLesson(jobTitle: string, errors: JournalEntry[], successes: JournalEntry[]): Promise<string | null> {
  const errorLines = errors.slice(-6).map((j) => `- ${j.tool ?? j.kind}: ${clip(j.summary, 160)}${j.evidence ? ` | ${clip(j.evidence, 200)}` : ""}`);
  const successLines = successes.slice(-4).map((j) => `- ${j.tool ?? j.kind}: ${clip(j.summary, 160)}`);
  const reply = await completeChat(
    [
      {
        role: "system",
        content:
          "You extract one reusable lesson from an agent's work log. Reply with exactly one line in the form " +
          "'LESSON: <when X, do Y — because Z>'. It must be transferable to future similar tasks, concrete, and " +
          "under 220 characters. No preamble. /no_think",
      },
      {
        role: "user",
        content:
          `Task: ${clip(jobTitle, 160)}\n\nWhat failed first:\n${errorLines.join("\n")}\n\n` +
          `What eventually worked:\n${successLines.join("\n") || "- the task completed after changing approach"}`,
      },
    ],
    { temperature: 0.2, maxTokens: 200, thinking: "off" },
  );
  const text = stripThink(reply);
  const m = text.match(/LESSON:\s*(.+)/i);
  const lesson = (m ? m[1] : text).replace(/\s+/g, " ").trim();
  if (lesson.length < 20 || lesson.length > 300) return null;
  return lesson;
}

/**
 * Called at the end of every turn. If the current job just completed with
 * failures in its history and hasn't been reflected on yet, save a lesson in
 * the background.
 */
export function maybeReflectOnJob(cwd: string): void {
  const job = getCurrentJob();
  if (!job || job.status !== "completed" || reflectedJobs.has(job.id)) return;
  const entries = getJournal().filter((j) => j.jobId === job.id);
  const errors = entries.filter((j) => j.isError && trustedForLearning(j));
  if (errors.length < 2) return; // smooth runs teach nothing new
  reflectedJobs.add(job.id);
  const successes = entries.filter((j) => trustedForLearning(j) && !j.isError && (j.kind === "verification" || j.kind === "tool_result"));

  void (async () => {
    try {
      const lesson = await distillLesson(job.title, errors, successes);
      if (!lesson) return;
      addMemory(`Lesson: ${lesson}`, cwd, { type: "convention", salience: 0.6 });
      addJournalEntry({
        kind: "decision",
        summary: "Reflected on this job's failures and saved a lesson to memory.",
        evidence: clip(lesson, 220),
      });
    } catch {
      /* best-effort — never surface reflection failures */
    }
  })();
}

/** Test helper. */
export function resetReflection(): void {
  reflectedJobs.clear();
}
