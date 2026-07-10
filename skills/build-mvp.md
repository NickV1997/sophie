---
name: build-mvp
description: Take a build request from one prompt to a working MVP — plan in phases, then build and verify each phase
when: The user asks you to build/create/scaffold an app, feature, page, dashboard, or tool (build mode)
---

# Build an MVP in one shot

You are running the build pipeline: PLAN the whole thing first (high reasoning), then BUILD it phase by phase (low reasoning), verifying as you go, until a working MVP exists. Don't stop half-way and don't ask for review — drive it to done.

## 1. Plan (planning phase)
1. Pin the MVP. If scope/stack/must-have features/look are unclear enough to change the plan, call `ask_user` with 1-4 sharp questions ONCE, then wait. Otherwise decide sensibly and proceed.
2. Write the full plan with `update_tasks` as a PHASED list (use the `phase` field), e.g.:
   - **Phase 1: Scaffold** — create project with the right scaffold tool; read the structure.
   - **Phase 2: Core** — the primary screen/feature with real, wired UI (no placeholders).
   - **Phase 3: Integration** — data flow, interactions, routing, empty/loading states.
   - **Phase 4: Verify & polish** — verifier + browser_check, fix everything until clean.
   Set `objective` to the user's end goal. Prefer many small verifiable steps over a few big ones (small models execute better that way).
3. Mark the first task in_progress and start building.

## 2. Build (building phase)
- One task at a time, in order: in_progress → do it with the most specific local tool → mark completed with a short note → next.
- Scaffold with `scaffold_next_shadcn_project` / `scaffold_python_project` / `scaffold_project`. Add shadcn components with the `mcp__shadcn__*` tools; reuse `components/ui` and `cn()`. Don't hand-build what a tool provides.
- Start dev servers with `run_background`, never `bash`.
- At the end of each phase, verify it (`verify_next_app` / `verify_python_project` / … and `browser_check` for UI). A failing verifier or a non-clean console is the next task to fix — never rationalize it away.

## 3. Finish
- When every phase is done and the final verifier passes, call `update_tasks` with `objective_status: 'completed'` and `objective_evidence` (what you verified). The runtime exits build mode automatically.

Rules:
- Real MVP, not a stub: the core feature must actually work end to end.
- Keep the task list current every step — it's your memory across a long build.
- Prefer local components and native CSS over new dependencies (dependency preflight still applies).
