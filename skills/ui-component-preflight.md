---
name: ui-component-preflight
description: Verify available frontend components and dependencies before installing UI packages or using component CLIs
when: The user asks Sophie to add, fix, style, or scaffold UI with shadcn, component libraries, icon packs, Tailwind plugins, or new frontend dependencies
---

# UI component preflight

Goal: avoid hallucinated package/component installs. Discover what the project already has, then only install when the dependency is real and necessary.

1. Identify the stack:
   - Read `package.json`.
   - Inspect the lockfile to infer the package manager.
   - Check framework/config files such as `next.config.*`, `vite.config.*`, `tailwind.config.*`, `postcss.config.*`, and `tsconfig.json` when relevant.
2. Inventory local UI:
   - Read `components.json` if present.
   - List likely component folders: `components`, `src/components`, `app/components`, `src/components/ui`, `components/ui`.
   - Grep imports for the library or component name the task mentions.
3. Decide before installing:
   - Prefer existing local components, existing dependencies, and small local implementations.
   - Verify new package or shadcn component names from installed dependency metadata or current official docs/search.
   - If the component/package cannot be verified, do not install it. Say what was checked and implement locally when practical.
4. Install only after evidence:
   - Use the detected package manager.
   - For a new Next.js project with shadcn already configured, use `scaffold_next_shadcn_project` instead of hand-running CLI commands.
   - The current headless shadcn CLI pattern for new Next.js apps is `shadcn@latest init -t next --name <project> --yes --defaults`, followed by `shadcn@latest add <components> --cwd <project> --yes`.
   - Prefix intentional package/component install commands with `SOPHIE_INSTALL_PREFLIGHT=1`.
   - Record the evidence in the task note or final answer.
5. Verify UI work:
   - Run the narrowest useful typecheck/build/lint.
   - For rendered UI, start the app with `run_background` when needed and verify with `browser_check`.
