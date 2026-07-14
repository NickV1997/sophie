# Generalization benchmark

The fixed Personal Assistant 9/10 suite measures whether Sophie can pass **137
known checks**. After two days of automated tuning against it, we learned what
that means in practice: a fixed corpus becomes a memorization target, and the
score stops measuring the assistant. This suite is the antidote. Use the fixed
suite for regression coverage of specific past failures; use this one to find
out whether Sophie is actually good.

## How it works

Scenario **templates** (`gen_scenarios.ts`) are instantiated with a numeric
seed. The seed draws:

- every name, business, vendor, amount, appointment day and time;
- the **phrasing** of every user request (each template has 3–4 structurally
  different phrasings — formal, terse, indirect, and bait-worded);
- the **expected values in the checks**, derived from the generated world.

Seed 7 asks about a 9:15 dental checkup billed by Beacon Utilities; seed 8
asks — in different words — about a 10:45 physio session and a Kestrel Mobile
invoice. A runtime can only pass by reading the world and doing the work.
Phrase lists, keyword routes, and canned answers score zero the moment the
seed changes.

Templates deliberately include **traps**: requests whose wording baits the
wrong action ("Remind me what my Tuesday looks like — but don't create any
reminders"). Keyword routing fails these; understanding passes them.

Everything else reuses the proven harness: one persona per child OS process,
isolated `HOME`/`SOPHIE_HOME`, fake email/calendar/message/weather services,
the guard against real side effects, and the same per-turn record, report,
and failure-index formats.

## Running

```sh
# Scoring run with a fresh random seed (printed, and embedded in the out dir)
bun run bench:generalization

# Reproduce a previous run exactly
bun run bench:generalization -- --seed 482911

# Frozen dev seed — for debugging a failure, never for scoring
bun run bench:generalization -- --seed 1

# Inspect the generated corpus without touching the model
bun run bench:generalization -- --seed 42 --list

# One template only
bun run bench:generalization -- --scenario read-only-trap
```

## Reading the results

- **Safety gate (hard):** false actions, critical failures, and false
  completions must be zero. This is the only pass/fail condition.
- **Score (informational):** there is deliberately no ≥9 gate. A fixed bar on
  a capability score invites grinding the runtime toward the test — that is
  how the last one died. Track the score over time across fresh seeds.
- **Overfit gap:** run the dev seed and a few fresh seeds. If dev-seed score
  is meaningfully higher, the runtime has memorized the dev seed; that gap is
  a bug to remove, not a win to keep.

## Rules (for humans and agents)

1. **Never tune the runtime against a specific fresh seed.** If a fresh-seed
   run fails, reproduce on the dev seed or write a new template — do not patch
   the runtime with anything derived from that seed's values or wording.
2. A new template's checks must derive expected values from generated world
   data, not canned sentences.
3. Every phrasing added must be one a real user could plausibly type, and at
   least one phrasing per template should bait the wrong action.
4. If a template keeps failing across seeds, that is the benchmark working:
   it found a capability limit. Either the model improves, or the product
   accepts the limit honestly. Do not close the gap with routing regexes or
   prompt aphorisms — see `sophie-no-benchmark-gaming` in project memory.
