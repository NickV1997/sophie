---
name: fix-runtime-error
description: Diagnose and clear a pasted runtime/console/React error, then verify it's gone
when: The user pastes an error message or stack trace (console error, React/Next warning, exception) and wants it fixed or "cleared"
---

# Fix a runtime error

1. Parse the error first. Pull out: the error type/message, any named symbol (a prop, component, hook, import), and the file:line if the stack gives one. Don't start editing until you know what the error is actually about.
2. Locate the source — don't guess the file. If a file:line is given, read it. Otherwise `grep` the project for the named symbol (the prop, component, or string from the message) to find where it's used. In an unfamiliar project, `project_map` first.
3. Read the implicated file/region and understand the cause before changing anything.
4. Fix the root cause minimally, matching existing patterns (`edit_file` for a surgical change; for `.tsx/.jsx` pass `expected_old`). Fix the cause, not the symptom — don't silence a warning by deleting the feature.
5. Verify the specific error is gone: with a dev server running, `browser_check` the page and confirm RENDER is ok AND CONSOLE is clean (zero console errors). For type/build errors, run the verifier (`verify_next_app` / `bash` typecheck). Keep going until that exact error no longer appears.
6. Report what the error was, the root cause, and the one change that fixed it.

## Common React/Next causes (recognize these fast)
- **"React does not recognize the `X` prop on a DOM element"** → a non-HTML prop is leaking to the DOM. Often `asChild` on a component that doesn't implement Radix `Slot` forwarding, or a custom prop spread onto a native element. Fix: forward via `Slot`/`asChild` properly, or stop passing the prop.
- **Hydration mismatch / "cannot be a descendant of"** → invalid nested HTML: `<button>` inside `<button>`, `<a>` inside `<a>`, `<div>`/block inside `<p>`. Fix the nesting (e.g. `asChild` so a trigger renders one element, not a button-in-button).
- **"Cannot read properties of undefined"** → data used before it's loaded; add a null guard or default.
- **Hook / event handler errors in Next App Router** → a Server Component using `useState`/`onClick`. Add `"use client"` at the top of that component file.
- **"Module not found"** → missing dependency or wrong import path; verify the package is installed and the path exists before "fixing" it.

Rules:
- One concrete error at a time; verify it's cleared before moving on.
- A failing verifier or a non-clean console means it's NOT fixed yet — don't call a pre-existing error "unrelated" to avoid fixing it.
- For framework/library errors you're unsure about, check current docs (`web_search`/`web_fetch`) before editing config.
