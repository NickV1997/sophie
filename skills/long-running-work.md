---
name: long-running-work
description: Run work that takes minutes to hours without blocking, then return to the results
when: A task needs a long build/download/script/training run, or you must wait for something to finish
---

# Long-running work (start → sleep → wake → results)

The bash tool is for quick commands (it's killed after minutes). For anything
long, run it detached and sleep until it's done — don't poll in a busy loop.

1. If it's a script, write it first with write_file (or assemble the command).
2. Start it with **run_background** → you get a `job_id`. Output streams to a log and job metadata is persisted under `~/.sophie/jobs`.
3. **wait_for** with that `job_id` to sleep until it finishes (no effort spent while waiting; capped at 1 hour — call it again for longer).
4. **job_status** on the `job_id` to read the exit code and the output log.
5. Act on the result: if it failed (non-zero exit), read the log tail, fix, and rerun. If it succeeded, use the output.

Patterns:
- "Write code that answers a question, then come back to the result": write the script → run_background → wait_for(job_id) → job_status → report the answer from the output.
- Waiting on an external event: wait_for with `until_file` (a path that appears when done) or `seconds` (a plain delay).
- Several long jobs: start them all with run_background, then wait_for each in turn.

Rules:
- Never fabricate a job's result — only report what job_status actually returned.
- Keep a task list (update_tasks) across long jobs so you stay on track between waits. Put the `job_id` in the relevant task note so `/resume` and `/continue` can recover it.
- If a job is still running after a wait_for cap, decide: wait again, or move on and check later.
