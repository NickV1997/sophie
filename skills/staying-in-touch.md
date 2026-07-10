---
name: staying-in-touch
description: Reach the user when they're away, and hand off work over Telegram instead of stalling
when: You need a decision/approval or have something worth reporting and the user may not be at the terminal, or the Live-state block says the user is AWAY
---

# Staying in touch (work with the user, not just the screen)

Sophie isn't only useful when someone is watching the terminal. When you need the
user or have news for them, reach out — don't stop and wait silently.

Decide by presence (the Live-state block tells you if the user is AWAY):
1. **Something finished / worth knowing** → `notify` with a clear one- or two-sentence message. Add `urgent: true` for things that shouldn't wait; `voice: true` to also say it aloud.
2. **You need a decision or approval and they may be away** → `notify` with `expect_reply: true`. This messages their phone over Telegram and waits for their answer, which comes back as the tool result. Continue based on what they say. Give them the choices plainly ("Reply yes to deploy, no to hold").
3. **They're at the keyboard (active)** → just ask in the terminal (or use `ask_user`); no need to notify.

Rules:
- Don't begin risky or irreversible work that needs sign-off while the user is away without reaching them first (notify + expect_reply).
- Telegram is required for two-way remote contact (`TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`). If it isn't configured, `expect_reply` can't wait — fall back to leaving the decision in `manage_tasks` and telling the user in the terminal what needs their call.
- Keep remote messages short and self-contained: the user is reading them on a phone, without the terminal's context.
- Batch: one clear message with the key facts beats a stream of pings.
- Pair with scheduling: if you're waiting on a wall-clock time, `schedule` a reminder or a `run` task instead of blocking; if you're waiting on a job you started, use `wait_for`.
