---
name: explore-codebase
description: Find how something works in a code project without reading everything
when: The user asks where/how something is implemented, or you need to understand code before changing it
---

# Explore a codebase

Goal: build an accurate mental model with the fewest tokens. Don't read whole trees.

1. `list_dir` at the relevant root to see the shape (entry points, src layout).
2. `glob` for the file types that matter (e.g. `**/*.ts`) if structure is unclear.
3. `grep` for the concrete symbol, string, or feature name to locate exact files and lines. This is your main tool — search before you read.
4. `read_file` only the specific files grep pointed to, and use `offset`/`limit` to read the relevant range, not the entire file.
5. Follow imports/definitions the same way: grep the name → read the range.

Rules:
- Never claim how code behaves without having read the actual lines — cite `file:line`.
- Stop once you can answer; don't keep reading "to be safe."
- If something isn't in the code, say it isn't there rather than assuming.
