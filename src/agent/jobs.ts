import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { sanitizedCommandEnvironment, sandboxedShellCommand } from "../system/command-sandbox.ts";

/**
 * Durable background jobs for long-running work. Jobs are recorded on disk with
 * an exit-code marker written by the child shell, so the TUI can close and a
 * later Sophie session can still discover whether the command finished.
 */
export type JobStatus = "running" | "exited" | "failed";

export interface Job {
  id: string;
  command: string;
  cwd: string;
  logPath: string;
  exitPath: string;
  pid: number | null;
  startedAt: number;
  updatedAt: number;
  status: JobStatus;
  exitCode: number | null;
}

interface JobInternal {
  job: Job;
  proc?: ReturnType<typeof Bun.spawn>;
}

const JOBS_DIR = join(homedir(), ".sophie", "jobs");
const jobs = new Map<string, JobInternal>();
let seq = 0;
let loaded = false;

function ensureDir(): void {
  if (!existsSync(JOBS_DIR)) mkdirSync(JOBS_DIR, { recursive: true });
}

function metaPath(id: string): string {
  return join(JOBS_DIR, `${id}.json`);
}

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function save(job: Job): void {
  ensureDir();
  job.updatedAt = Date.now();
  writeFileSync(metaPath(job.id), JSON.stringify(job));
}

function loadAll(): void {
  if (loaded) return;
  loaded = true;
  ensureDir();
  for (const f of readdirSync(JOBS_DIR)) {
    if (!f.endsWith(".json")) continue;
    try {
      const job = JSON.parse(readFileSync(join(JOBS_DIR, f), "utf8")) as Job;
      jobs.set(job.id, { job: refresh(normalize(job)) });
    } catch {
      /* skip corrupt metadata */
    }
  }
}

function normalize(job: Job): Job {
  return {
    ...job,
    exitPath: job.exitPath ?? join(JOBS_DIR, `${job.id}.exit`),
    pid: job.pid ?? null,
    updatedAt: job.updatedAt ?? job.startedAt ?? Date.now(),
    exitCode: job.exitCode ?? null,
    status: job.status ?? "failed",
  };
}

function pidAlive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function refresh(job: Job): Job {
  if (existsSync(job.exitPath)) {
    const raw = readFileSync(job.exitPath, "utf8").trim();
    const code = Number(raw);
    job.exitCode = Number.isFinite(code) ? code : null;
    job.status = job.exitCode === 0 ? "exited" : "failed";
    save(job);
    return job;
  }

  if (job.status === "running" && job.pid && !pidAlive(job.pid)) {
    job.status = "failed";
    job.exitCode = null;
    save(job);
  }
  return job;
}

export function startJob(command: string, cwd: string, opts: { sandboxed?: boolean } = {}): Job {
  loadAll();
  ensureDir();
  const id = `job-${Date.now().toString(36)}-${seq++}`;
  const logPath = join(JOBS_DIR, `${id}.log`);
  const exitPath = join(JOBS_DIR, `${id}.exit`);
  const wrapped =
    `(${command}) > ${shQuote(logPath)} 2>&1; ` +
    `code=$?; printf "%s" "$code" > ${shQuote(exitPath)}; exit "$code"`;

  const proc = Bun.spawn(opts.sandboxed === false ? ["bash", "-lc", wrapped] : sandboxedShellCommand(wrapped, cwd, [JOBS_DIR]), {
    cwd,
    env: sanitizedCommandEnvironment(),
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
  });
  (proc as any).unref?.();

  const job: Job = {
    id,
    command,
    cwd,
    logPath,
    exitPath,
    pid: proc.pid ?? null,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    status: "running",
    exitCode: null,
  };
  jobs.set(id, { job, proc });
  save(job);

  proc.exited.then((code) => {
    job.status = code === 0 ? "exited" : "failed";
    job.exitCode = code;
    save(job);
  });

  return job;
}

export function getJob(id: string): Job | undefined {
  loadAll();
  const entry = jobs.get(id);
  return entry ? refresh(entry.job) : undefined;
}

export function listJobs(): Job[] {
  loadAll();
  return [...jobs.values()]
    .map((j) => refresh(j.job))
    .sort((a, b) => b.startedAt - a.startedAt);
}

/** Tail of a job's combined stdout/stderr log. */
export function jobLog(id: string, maxChars = 4000): string {
  const job = getJob(id);
  if (!job) return `No job "${id}".`;
  if (!existsSync(job.logPath)) return "(no output yet)";
  const text = readFileSync(job.logPath, "utf8");
  return text.length > maxChars ? `...${text.slice(-maxChars)}` : text || "(no output yet)";
}

export interface WaitResult {
  reason: "job-exited" | "file-appeared" | "timeout" | "slept";
  detail: string;
}

/**
 * Efficiently wait for one of: a job to finish, a file to appear, or a fixed
 * delay. For restored jobs, waiting polls the durable exit marker instead of
 * requiring the original Bun process object to still exist.
 */
export async function waitFor(opts: {
  jobId?: string;
  seconds?: number;
  untilFile?: string;
  maxMs: number;
  signal?: AbortSignal;
}): Promise<WaitResult> {
  const deadline = Date.now() + opts.maxMs;

  if (opts.seconds && !opts.jobId && !opts.untilFile) {
    const ms = Math.min(opts.seconds * 1000, opts.maxMs);
    await sleep(ms, opts.signal);
    return { reason: "slept", detail: `slept ${Math.round(ms / 1000)}s` };
  }

  if (opts.jobId) {
    while (Date.now() < deadline) {
      const job = getJob(opts.jobId);
      if (!job) return { reason: "timeout", detail: `no job "${opts.jobId}"` };
      if (job.status !== "running") {
        return { reason: "job-exited", detail: `${job.status} (exit ${job.exitCode})` };
      }
      await sleep(Math.min(1000, deadline - Date.now()), opts.signal);
    }
    const job = getJob(opts.jobId);
    const name = job ? `${basename(job.logPath)} still running` : `no job "${opts.jobId}"`;
    return { reason: "timeout", detail: `${name} after ${Math.round(opts.maxMs / 1000)}s` };
  }

  if (opts.untilFile) {
    while (Date.now() < deadline) {
      if (existsSync(opts.untilFile)) return { reason: "file-appeared", detail: opts.untilFile };
      await sleep(Math.min(1000, deadline - Date.now()), opts.signal);
    }
    return { reason: "timeout", detail: `${opts.untilFile} did not appear` };
  }

  return { reason: "timeout", detail: "nothing to wait for" };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const t = setTimeout(resolve, Math.max(0, ms));
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}
