# Security

Sophie is a local-first terminal agent. It is powerful *on purpose* — it can run
shell commands, read and edit files, and reach the network on your behalf. Please
understand the trust model before running it.

## What Sophie can do on your machine

- **Run shell commands and edit files** in your working directory (like any coding
  agent). Run Sophie under your normal user account, not as root, and preferably in
  a directory scoped to the project you're working on.
- Sophie asks before destructive or outward-facing actions, but you are ultimately
  the sandbox. Treat it with the same caution as running code you didn't write.

## What leaves your machine (and what doesn't)

By default Sophie is local-first. Outbound network calls only happen for:

| Feature | Endpoint | When |
| --- | --- | --- |
| Model inference | your `SOPHIE_BASE_URL` (localhost by default) | every turn |
| Approximate location | `http://ip-api.com` (city-level, from your public IP) | **once**, on first run, saved to memory |
| Telegram (optional) | `api.telegram.org` | only if you set `TELEGRAM_BOT_TOKEN` |
| Web search (optional) | DuckDuckGo, or Tavily/Brave if keys are set | only when the `web_search` tool runs |

The one-time location lookup on first run is best-effort and can be skipped by
staying offline during the first launch. Everything else is opt-in via `.env`.

## Secrets & personal data

- All secrets live in `.env`, which is git-ignored and **never** committed. Only
  `.env.example` (blank template) is tracked.
- Your memories, persona, and onboarding state live in `~/.sophie/`, outside the
  repo, and are never pushed.
- If a secret is ever exposed, rotate it: Telegram tokens via `@BotFather`
  (`/revoke`), and Tavily/Brave keys from their dashboards.

## Web app trust model

`/webapp` binds only to loopback and your Tailscale interface (100.64.0.0/10) —
never `0.0.0.0` — so the open LAN can't see it; Tailscale's own authentication
and encryption are the network perimeter. Independently of that, every `/api/*`
request must carry a random per-launch token (generated at start, delivered in
the URL fragment of the links Sophie prints, checked in constant time), so even
a device that can reach the port cannot drive the agent or approve tool calls
without the link. Overriding the bind host (`SOPHIE_WEBAPP_HOST` / `--host`) is
your explicit choice; the token gate stays on regardless.

## Telegram trust model

The Telegram bridge only accepts messages from the single `TELEGRAM_CHAT_ID` you
authorize during setup. Messages from any other chat are ignored — the bot will
never take instructions from a stranger.

## Reporting a vulnerability

Please open a private security advisory on the GitHub repository rather than a
public issue. Include steps to reproduce and the impact you observed.
