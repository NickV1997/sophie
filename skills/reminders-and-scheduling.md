---
name: reminders-and-scheduling
description: Set reminders, alarms, and recurring jobs so things happen at the right time without you waiting
when: The user wants to be reminded, something should happen at a set time or on a schedule, or you want to defer/repeat a task
---

# Reminders & scheduling

The `schedule` tool remembers to do or say something at a wall-clock time so you
don't have to stay busy in between. Two shapes:

**One-off (reminder / alarm):**
- Relative: `schedule(action:add, in_minutes:30, do:notify, message:"Stretch break")` or `in_hours`.
- Absolute: `at:"15:00"` (next occurrence of 3pm), `at:"2026-07-10 09:30"`, or a full ISO time.

**Recurring (cron):** `cron` is 5 fields — `minute hour day-of-month month day-of-week`.
- `"0 9 * * 1-5"` = 09:00 every weekday. `"*/30 * * * *"` = every 30 minutes. `"0 20 * * 0"` = 8pm Sundays.

**What happens when it fires** — pick with `do`:
- `do:notify` (+ `message`, optional `voice:true`) → the user gets a notification/Telegram at that time.
- `do:run` (+ `prompt`) → Sophie wakes and carries out the prompt then. Use for real tasks: `prompt:"Fetch today's weather and my open tasks and message me a morning brief."` Write the prompt as a complete instruction — it runs with fresh context.

**Managing them:** `schedule(action:list)` shows all with ids; `cancel`/`disable`/`enable` take an `id`.
`update` takes an `id` plus any of title/message/prompt/do/a new time (`at`/`in_minutes`/`in_hours`)/`cron`
— use it to move or reword an existing reminder instead of cancel+add.

**Mirrors (automatic — don't duplicate by hand):** a one-off notify reminder is also created in
the macOS Reminders app and confirmed over Telegram when set/updated/cancelled; when it fires the
notification goes to desktop + Telegram and the Apple copy is ticked off. Never call the `apple`
tool to create a reminder the `schedule` tool already mirrors.

Rules:
- Meetings, appointments, and events with people/places belong on the `calendar` tool (load the calendar skill) — it auto-reminds before each event. `schedule` is for plain reminders and recurring jobs.
- Confirm the resolved time back to the user ("Set for Thu 3:00 PM"), since relative/absolute parsing can surprise.
- For a `do:run` job, make the prompt self-contained — it can't see this conversation later.
- Prefer `wait_for` (not `schedule`) when you're waiting on a background job you just started; `schedule` is for clock times and repetition.
- Save standing preferences (quiet hours, morning-brief time, their city) with `remember` so future scheduling matches how they like it.
