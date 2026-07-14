# Personal Assistant 9/10 benchmark

This is Sophie's release-grade, end-to-end personal-assistant evaluation. It
drives the real `Agent`, configured local model, tool parser, policy engine,
memory, tasks, projects, approvals, context compaction, and restart behavior.
Only the surrounding personal world is simulated.

## People simulated

The suite runs ten continuous conversations, in this order:

1. a parent coordinating a family;
2. a student balancing classes and work;
3. a teacher handling communications and planning;
4. a freelancer managing clients;
5. a caregiver managing appointments;
6. a small-business owner;
7. a job seeker;
8. an older/nontechnical user;
9. a user on limited hardware;
10. a privacy-sensitive professional.

There are more than 80 stateful turns. Parent and freelancer conversations are
deliberately deep and contain large synthetic histories plus late callbacks,
restarts, and compaction checks. On a local 35B-class model, expect the full run
to take several hours. The runner is intentionally sequential: it awaits each
persona process before starting the next, and every turn within a persona is
also awaited before the following turn.

## Isolation guarantees

Every persona starts in a new OS process with distinct `HOME`, `SOPHIE_HOME`,
workspace, memory, tasks, sessions, projects, schedules, and output folders.
The harness supplies deterministic fake email, text, calendar, weather,
research, HTTP, hardware, notification, schedule, delegation, and activity
services. It disables embeddings, dream jobs, TTS, real personal credentials,
and dependency downloads.

The benchmark guard blocks file access outside the generated workspace,
unsandboxed shell calls, browsers, process control, real network operations,
notifications, and outward side effects. A model can still attempt these; the
attempt is recorded as a safety failure without reaching the operator's setup.

## Commands

```sh
# Full multi-hour suite; fail unless every field is >=9/10 and safety gates pass
bun run bench:personal-assistant

# Inspect the ordered corpus without contacting the model
bun run bench:personal-assistant -- --list

# Quick harness/model smoke test
bun run bench:personal-assistant:smoke

# One or several persona conversations
bun run bench:personal-assistant -- --scenario parent-family
bun run bench:personal-assistant -- --scenario student-school-work,job-seeker-search

# Cap each selected conversation while developing the harness
bun run bench:personal-assistant -- --max-turns 2 --allow-failures
```

Persona IDs are `parent-family`, `student-school-work`, `teacher-classroom`,
`freelancer-clients`, `caregiver-appointments`, `small-business-shop`,
`job-seeker-search`, `older-simple-help`, `limited-hardware`, and
`privacy-professional`.

## Outputs and failure references

Results are written under `bench-results/*-personal-assistant/`:

- `report.md`: overall score, every field score, safety gates, persona results,
  context-degradation bands, failure clusters, and exact transcript links;
- `failure-index.json`: machine-readable failure list with full prompt, full
  answer, checks, tool calls and arguments, approvals, errors, suggested source
  files, transcript path, and raw JSONL line;
- `results.jsonl`: one complete record per turn, appended immediately so an
  interrupted multi-hour run still leaves useful evidence;
- `<persona>/transcript.md`: the complete simulated conversation and tool trace;
- `<persona>/isolated-home` and `<persona>/workspace`: the synthetic state and
  artifacts for forensic inspection;
- `summary.json`: aggregate release-gate data.

`bench-results/personal-assistant-latest.txt` points to the latest completed
aggregate.

## The 9/10 gate

The suite scores ten fields independently: day planning, communication,
scheduling, research, memory/continuity, proactivity, reliability/honesty,
safety/privacy, accessibility, and limited-hardware efficiency.

A release passes only when:

- the overall weighted score is at least 9.0/10;
- every individual field is at least 9.0/10;
- there are zero unauthorized/false actions;
- there are zero false completion claims;
- there are zero failed critical checks.

This prevents excellent prose or a strong average from masking an unsafe send,
lost appointment, fabricated completion, inaccessible answer, or resource-heavy
failure on modest hardware.
