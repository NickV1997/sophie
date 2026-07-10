---
name: plan-my-day
description: Build a personalized hour-by-hour plan for the user's day from their profile, calendar, reminders, and weather
when: The user asks to plan their day/morning/evening, wants a daily schedule or morning brief, or asks what they should do today/tomorrow
---

# Plan the user's day

A good day plan is anchored on FIXED commitments (work hours, meetings, appointments)
with the user's real routine and favorites filled in around them. Never invent a
generic plan when you have their profile.

## 1. Gather (4 quick calls, before writing anything)
- `user_profile(action:get)` — wake/sleep times, work schedule, morning routine, pets, food & drink favorites, hobbies, exercise.
- `calendar_list` — today's (or the target day's) real events and appointments.
- `schedule_list` — reminders already set, so you don't double-book or duplicate them.
- `weather` — shapes suggestions (walk vs. indoors, umbrella note).
- `current_time` — know how much of the day is left; if the day is half over, plan from NOW, not from wake-up.

If the profile is empty or missing the anchors (work schedule, wake time), ask the
2-3 most important questions conversationally, save each answer with
`user_profile(action:set)`, then continue. Don't interrogate — a plan with gaps
beats a questionnaire.

## 2. Build the timeline
- Anchor the skeleton: wake time → morning routine → commute/work block → fixed events → evening → bed time.
- Work BACKWARD from fixed commitments: a 9:00 start with a 20-min commute and a shower means wake by ~7:30.
- Weave in their profile specifics by name — their coffee order, their dog's feed/walk, their gym days, their shows. "Make your flat white" lands; "have a beverage" doesn't.
- Meals: reference favorite dishes/restaurants/fast food, respecting dietary notes. Suggest, don't prescribe.
- Evening: one concrete downtime suggestion matched to their interests (a dish to cook, a movie/show in a genre they like) — not a list of ten.
- Leave slack. Don't schedule every minute; flag the 2-3 things that actually matter.

## 3. Offer reminders (once, as a batch)
- Propose reminders for the time-critical items only: "Want me to remind you 30 min before the 1:00 meeting, and at 5:45 to leave for the gym?"
- On yes, set them with `schedule` (one-off `at:`/`in_minutes:` + `do:notify`). Confirm each resolved time back.
- Real events with people/places that aren't on the calendar yet belong on `calendar`, not `schedule`.

## 4. Present it
- A compact timeline, one line per block: `7:30 — wake up, shower, flat white`.
- Bold or call out the fixed commitments and anything weather-dependent.
- End with what you've set reminders for (if any), and nothing else — no lecture.

Rules:
- Fixed commitments are facts from the calendar; never guess meeting times from memory.
- If the user corrects a detail ("I actually start at 8 now"), update the profile with `user_profile(action:set)` immediately.
- A recurring "plan my day every morning" request = a `schedule` cron job (`do:run`, prompt: "Load the plan-my-day skill and message me today's plan") — load the reminders-and-scheduling skill for the syntax.
