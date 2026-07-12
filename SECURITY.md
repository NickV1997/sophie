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
| Approximate location | `http://ip-api.com` (city-level, from your public IP) | only when `SOPHIE_LOCATION_LOOKUP=true`, then once and saved locally |
| Telegram (optional) | `api.telegram.org` | only if you set `TELEGRAM_BOT_TOKEN` |
| Web search (optional) | DuckDuckGo, or Tavily/Brave if keys are set | only when the `web_search` tool runs |

Approximate location lookup is disabled by default. Everything other than local
model inference is opt-in via `.env` or an explicit tool call.

## Secrets & personal data

- All secrets live in `.env`, which is git-ignored and **never** committed. Only
  `.env.example` (blank template) is tracked.
- Your memories, persona, and onboarding state live in `~/.sophie/`, outside the
  repo, and are never pushed.
- Sophie state files are written atomically with owner-only permissions where
  supported. They are still plaintext readable by your local account; full-disk
  encryption and a protected login account remain part of the trust boundary.
- Web pages, email, Messages, documents, browser content, and MCP responses are
  treated as untrusted data. Instructions embedded in retrieved content do not
  grant authority to run tools or disclose information.
- If a secret is ever exposed, rotate it: Telegram tokens via `@BotFather`
  (`/revoke`), and Tavily/Brave keys from their dashboards.
- `bun run audit:public` scans tracked and unignored files plus commit metadata
  for common secret, local-state, and machine-identity leaks. CI runs the same
  check on every push and pull request.

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

## Background runtime

The optional macOS daemon uses the same runtime safety gate as interactive
Sophie. Scheduled and watched content is labeled by source and trust. Private or
untrusted evidence cannot authorize outward communication. Calls requiring
approval pause in a durable queue; approval is bound to the exact tool name and
arguments and is consumed once. Daemon state, queue files, and audit history are
private to the local account.
