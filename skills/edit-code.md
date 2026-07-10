---
name: edit-code
description: Change files safely and correctly, matching the existing code
when: The user asks you to modify, fix, refactor, or add to existing files
---

# Edit code

1. If the project is unfamiliar or large, run `project_map` first to identify structure, scripts, frameworks, and important files.
2. Read the target file (or the exact range) first — never edit blind.
3. Match the surrounding style: naming, indentation, imports, patterns already in use.
4. Make the smallest change that does the job. Use `edit_file` with a unique `old_string`; use `replace_lines` for known line ranges; use `write_file` only for new files or intentional full rewrites.
5. After editing, verify: re-read the changed region or inspect the diff, and if there's a build/test/typecheck command, run it with `bash` or `run_background` for long checks and read the output.
6. If verification fails, read the error, fix, and re-verify — don't hand back broken work.

Rules:
- Don't invent APIs, imports, or file paths — confirm they exist with grep/read first.
- Report exactly what you changed (`file:line`, what and why), based on the diff you actually made.
- Preserve behavior you weren't asked to change.
