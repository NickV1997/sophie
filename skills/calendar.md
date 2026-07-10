---
name: calendar
description: Manage the user's calendar — book meetings and appointments, check availability, reschedule, and rely on automatic pre-event reminders
when: The user mentions a meeting, appointment, or event; someone wants to schedule time with them; they ask what's coming up or when they're free
---

# Calendar

The `calendar` tool is the user's real calendar. Anything with a date/time that
involves other people, a place, or a commitment belongs here — NOT in `schedule`
(which is for plain reminders and cron jobs). Every calendar event automatically
reminds the user (desktop + Telegram) before it starts, so you never need a
separate reminder for an event you added.

**Add an event:**
`calendar(action:'add', title:'Dentist', start:'2026-07-10 14:00', duration_minutes:45, location:'Main St clinic', reminders:[60, 15])`
- `start` accepts `'YYYY-MM-DD HH:MM'`, ISO, `'tomorrow 09:30'`, or `'15:00'` (next occurrence).
- `reminders` are minutes before start; default `[30, 5]` (a heads-up plus an about-to-start ping, both desktop + Telegram). Use `[]` for none; keep the 5 unless the user asks otherwise.
- The result reports any conflict with existing events — always relay a conflict to the user instead of silently double-booking.

**What's on:** `calendar(action:'list', range:'today'|'tomorrow'|'week'|'YYYY-MM-DD')` — ids, times, who, where.
Your prompt already carries the next 7 days, so answer simple "what's on" questions from that; call `list` for other ranges or after changes.

**Availability — check BEFORE committing to a time:**
`calendar(action:'find_free', duration_minutes:30, range:'week')` returns open slots within working hours (9–18 by default; override with `day_start_hour`/`day_end_hour`).

**Booking a meeting for the user (e.g. someone asks for a time via email/message):**
1. `find_free` for the requested duration in the window they proposed.
2. Pick/offer a slot; once settled, `add` with the other person in `attendees` and context in `notes`.
3. Confirm back to the user what was booked and when ("Booked 30 min with Dana, Thu 2:00 PM — I'll remind you 30 and 5 min before"). If they're away, `notify` them on Telegram.
4. The pre-event reminder fires automatically — don't add a duplicate `schedule` reminder.

**Change / cancel:** `calendar(action:'update', id, start:'…')` reschedules (reminders move automatically; can also change title/location/notes/attendees/reminders). `calendar(action:'cancel', id)` cancels and removes its reminders. Find ids with `list` or `search(query)`.

Rules:
- Always confirm the resolved day AND time back to the user — date parsing can surprise.
- Ambiguous request ("book something with Alex next week") → check `find_free`, then ask_user/notify with 2–3 concrete slot options rather than guessing.
- Store standing preferences (working hours, default meeting length, lunch blocks) with `remember` and honor them in `find_free` calls.
