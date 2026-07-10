# Sophie Skills

Skills are short, on-demand **procedures** that teach Sophie how to do a class of
task well with her tools. They make a small local model far more capable by giving
it explicit, reusable recipes — without bloating its context.

## How it works

- Sophie's system prompt only carries the **catalog**: one line per skill, showing
  its `name` and `when` trigger (falling back to `description` if `when` is absent).
  This is always visible but cheap — it's just enough for Sophie to *recognize* a
  match, so write a sharp `when`.
- When a task matches a skill, Sophie calls the `load_skill` tool to pull the
  **full body** into context, follows it, and the procedure leaves context after
  the turn. This is *progressive disclosure* — detail appears only when needed.

## Add a skill

Drop a `.md` file in this folder (repo skills) or in `~/.sophie/skills/` (your
personal skills; these override repo skills with the same name). Format:

```markdown
---
name: my-skill
description: One line that helps Sophie decide when this is relevant
when: A short trigger phrase — when should she reach for this?
---

# My skill

1. Step one (which tool, what to check)
2. Step two
...

Rules:
- Keep it short and concrete. It's a checklist, not an essay.
- Tell her how to stay factual and efficient.
```

## Guidelines

- **Be concise.** Every line costs the model attention. Checklists beat prose.
- **Name the tools.** "grep for X, then read the range" beats "look through the code."
- **Reinforce the rules.** Cite sources, verify before asserting, no guessing.
- **One job per skill.** Compose small skills rather than writing one giant one.
