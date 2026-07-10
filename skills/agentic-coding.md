---
name: agentic-coding
description: Complete coding tasks end-to-end with task journal evidence and verification
when: The user asks Sophie to build, fix, debug, scaffold, or improve a coding project
---

# Agentic coding

Goal: finish the user's coding task like an autonomous coding agent, with evidence.

1. Establish the objective with `update_tasks`. Keep exactly one task `in_progress`.
2. Inspect before acting:
   - Read project instructions first: `AGENTS.md`, `AGENT.md`, `CLAUDE.md`, `SOPHIE.md` when present.
   - Use `project_map` for unfamiliar projects.
   - Use `grep`/`glob` to locate relevant files, then `read_file` targeted ranges.
   - For UI libraries, component CLIs, shadcn, icon packs, or new packages, inspect `package.json`, the lockfile/package manager, `components.json`, existing component folders, and current imports before any install/add command.
   - For new projects, prefer specialized scaffold tools: `scaffold_python_project` for Python and `scaffold_next_shadcn_project` for new Next.js + shadcn apps.
3. Edit safely:
   - Prefer `edit_file` for exact, unique replacements.
   - Use `write_file` for intentional full component/file rewrites.
   - Avoid `replace_lines` in JSX/TSX unless the range was just read and `expected_old` is passed.
4. Verify after every meaningful change:
   - Re-read changed code or inspect command output.
   - Run the narrowest useful check: typecheck, test, build, lint, or browser_check for UI.
   - For frontend visual/styling work, use `browser_check` with screenshot and visual inspection.
5. Recover deliberately:
   - If a tool corrupts a file, stop using that edit method on the file.
   - If a command or package/component install fails twice in the same area, stop guessing. Inspect help/docs/available items or mark the step blocked with the concrete failure.
   - Restore from `~/.sophie/backups` when available or rewrite the complete valid file.
   - Re-run verification before continuing.
6. Finish only with proof:
   - Mark each task completed with a concise `note`.
   - Mark the final objective completed with `objective_evidence` naming the checks that passed.
   - If blocked, mark the objective blocked with the exact blocker.

Rules:
- Never claim done based on intention. Claim done only from task journal evidence and verification output.
- Do not run `npm install <package>`, `pnpm add`, `bun add`, `yarn add`, `npx shadcn`, `pnpm dlx shadcn`, or similar package/component commands until availability has been verified. If the install is still needed after preflight, rerun it with `SOPHIE_INSTALL_PREFLIGHT=1`.
- Keep context lean: read targeted ranges, summarize findings in task notes, and let the journal carry tool evidence.
- Use `run_background` for dev servers and long-running checks; store the `job_id` in the relevant task note.
