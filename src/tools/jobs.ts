import { getJob, jobLog, listJobs, startJob, waitFor } from "../agent/jobs.ts";
import { protectedPathBlockReason } from "../system/protected-paths.ts";
import { protectedProcessBlockReason } from "../system/protected-processes.ts";
import { classifyCommand } from "./bash.ts";
import type { Tool } from "./types.ts";

const ONE_HOUR_MS = 60 * 60 * 1000;

// ── run_background ──────────────────────────────────────────────────────────
export const runBackground: Tool = {
  name: "run_background",
  description:
    "Start a long-running shell command detached (no time limit) and return a " +
    "job id; output streams to a log. Use for minutes-to-hours work — builds, " +
    "downloads, dev servers, watch processes, file servers, long-lived apps. " +
    "Then wait_for to sleep until it finishes, then job_status. Not for quick " +
    "commands — use bash for those.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command to run in the background." },
    },
    required: ["command"],
  },
  summarize: (a) => a.command,
  risk: (a) => classifyCommand(a.command ?? ""),
  async execute(args, ctx) {
    const command = String(args.command ?? "").trim();
    if (!command) return { content: "Error: empty command.", isError: true };
    const processReason = protectedProcessBlockReason(command);
    if (processReason) {
      return {
        content:
          `${processReason}\n` +
          "This is a hard runtime safety block. Do not retry with another kill, pkill, killall, service stop, or port-kill variation. Ask the user to manage the LLM server manually if they truly want it stopped.",
        isError: true,
        display: "restricted: LLM process protected",
      };
    }
    const destructiveReason = protectedPathBlockReason(command, ctx.cwd);
    if (destructiveReason) {
      return {
        content:
          `${destructiveReason}\n` +
          "This is a hard safety block enforced by the runtime. It cannot be approved, retried, or rephrased — do not attempt a variation of this command. " +
          "If a narrower action is safe, target a specific non-protected subfolder or move files to a named backup directory instead. " +
          "If the user genuinely wants this destructive action on a protected location, tell them you are not permitted to do it and they must do it themselves.",
        isError: true,
        display: "restricted: protected path blocked",
      };
    }
    const job = startJob(command, ctx.cwd);
    return {
      content:
        `Started background job ${job.id} (pid running).\n` +
        `Command: ${command}\nLog: ${job.logPath}\n` +
        `Next: wait_for with job_id "${job.id}" to sleep until it finishes, then job_status to read output.`,
      display: job.id,
    };
  },
};

// ── job_status ──────────────────────────────────────────────────────────────
export const jobStatus: Tool = {
  name: "job_status",
  description:
    "Check a background job: its status (running / exited / failed), exit code, " +
    "and the tail of its output log. Call after wait_for to read results.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "Job id from run_background (omit to list all jobs)." },
    },
    required: [],
  },
  summarize: (a) => (a.id ? `${a.id}` : "all jobs"),
  risk: () => "safe",
  async execute(args) {
    const id = args.id ? String(args.id) : "";
    if (!id) {
      const all = listJobs();
      if (!all.length) return { content: "No background jobs.", display: "0 jobs" };
      return {
        content: all.map((j) => `${j.id} · ${j.status}${j.exitCode != null ? ` (exit ${j.exitCode})` : ""} · ${j.command}`).join("\n"),
        display: `${all.length} jobs`,
      };
    }
    const job = getJob(id);
    if (!job) return { content: `No job "${id}".`, isError: true };
    const elapsed = Math.round((Date.now() - job.startedAt) / 1000);
    return {
      content:
        `Job ${job.id}\nStatus: ${job.status}${job.exitCode != null ? ` (exit ${job.exitCode})` : ""}\n` +
        `Command: ${job.command}\nElapsed: ${elapsed}s\n\n--- log tail ---\n${jobLog(id)}`,
      display: `${job.status}${job.exitCode != null ? ` ${job.exitCode}` : ""}`,
    };
  },
};

// ── wait_for ────────────────────────────────────────────────────────────────
export const waitForTool: Tool = {
  name: "wait_for",
  description:
    "Sleep efficiently until something happens, then wake up. Wait for a " +
    "background job to finish (job_id), for a file to appear (until_file), or " +
    "for a fixed delay (seconds). While waiting you spend no effort — use this " +
    "instead of polling in a loop. Returns what happened. Capped at one hour.",
  parameters: {
    type: "object",
    properties: {
      job_id: { type: "string", description: "Wait until this background job finishes." },
      until_file: { type: "string", description: "Wait until this file path exists." },
      seconds: { type: "number", description: "Or just sleep this many seconds." },
      max_seconds: { type: "number", description: "Hard cap on the wait (default 3600)." },
    },
    required: [],
  },
  summarize: (a) =>
    a.job_id ? `job ${a.job_id}` : a.until_file ? `file ${a.until_file}` : `${a.seconds ?? 0}s`,
  risk: () => "safe",
  async execute(args, ctx) {
    const requestedSeconds =
      Number(args.max_seconds) ||
      (args.job_id && args.seconds ? Number(args.seconds) : 3600);
    const maxMs = Math.min(requestedSeconds * 1000, ONE_HOUR_MS);
    const result = await waitFor({
      jobId: args.job_id ? String(args.job_id) : undefined,
      untilFile: args.until_file ? String(args.until_file) : undefined,
      seconds: args.seconds ? Number(args.seconds) : undefined,
      maxMs,
      signal: ctx.signal,
    });
    return { content: `Woke up: ${result.reason} — ${result.detail}`, display: result.reason };
  },
};
