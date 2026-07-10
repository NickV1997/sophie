# Sophie

**A local-first terminal AI assistant.** Sophie is an open-source agent — a mini
[Claude Code](https://claude.com/claude-code) — that runs entirely on *your*
machine against *your own* local model. No cloud, no API keys, no telemetry.

Where most local-model agents are aimed at coding, Sophie is built to be a
**general personal assistant** that happens to have full access to your computer:
she reads and writes files, runs commands, searches, plans, and gets things done
in the terminal.

Built with [OpenTUI](https://github.com/sst/opentui) for a clean,
Claude-Code-inspired interface, and tuned for **Qwen3** models.

---

## Contents

1. [Features](#features)
2. [Quickstart](#quickstart)
3. [Install](#1-install)
4. [Set up a model server](#2-set-up-a-model-server)
5. [Configure](#3-configure)
6. [Run](#4-run)
7. [Maintain](#5-maintain)
8. [Make Sophie your own](#make-sophie-your-own) — add skills, tools, MCP servers, memory
9. [How it works](#how-it-works)
10. [Security & privacy](#security--privacy)

---

## Features

- 🧠 **Your model, your machine** — talks to any OpenAI-compatible local server
  (Ollama, llama.cpp, LM Studio, vLLM).
- 🛠️ **Full filesystem + shell access** — read, write, edit, glob, grep, and run
  shell commands. Code edits show inline diffs in the transcript.
- 🗺️ **Large-codebase orientation** — `project_map` gives a compact view of a repo
  before Sophie drills into specific code.
- 🧱 **Project scaffolding** — starter environments for Bun/Node TypeScript, Python
  CLIs, static sites, Vite React, and Next.js + shadcn.
- 🌐 **Web search & fetch** — keyless DuckDuckGo out of the box; add
  `TAVILY_API_KEY` / `BRAVE_API_KEY` for higher-quality results.
- 📚 **Skills** — on-demand procedures (`skills/*.md`) that teach Sophie how to do
  tasks well. Only a compact catalog sits in context; full steps load on demand.
- 🧰 **Progressive tool disclosure** — a small model picks the right tool far more
  reliably from ~12 core tools than from ~60. The rest ride in a one-line catalog
  and activate on demand, keeping the prompt lean and the KV cache warm.
- 🎯 **Facts-only** — Sophie speaks only from verified data (tool results, files,
  the live clock, the web) and refuses to guess.
- 🧠 **Persistent memory** — a `SOPHIE.md` notebook she reads every session and
  appends to with the `remember` tool.
- 📌 **Long-term task manager** — durable assistant tasks survive across chats.
- 📱 **Reach you anywhere** — native desktop notifications, optional Telegram for
  two-way remote contact, and a Tailscale-ready phone web app.
- 🛡️ **Smart approvals** — acts freely on safe work; stops to ask before
  destructive actions (`rm -rf`, overwrites, force-push, …).
- 🗂️ **Plan / Normal / Build modes** — plan reasons first (read-only), normal
  executes, build is the coding playbook. Toggle with **Shift+Tab**.
- 🗣️ **Voice** — optional neural TTS (local Kokoro sidecar) or macOS `say`.

---

## Quickstart

```bash
# 1. Get the code and install
git clone <your-fork-url> sophie && cd sophie && ./install.sh

# 2. Start a local model server (fastest path: Ollama)
ollama pull qwen3 && ollama serve            # or use llama.cpp — see below

# 3. Point Sophie at it (edit .env, or use the /setup wizard on first launch)
#    SOPHIE_BASE_URL=http://localhost:11434/v1

# 4. Verify, then run
sophie doctor
sophie
```

The rest of this README walks each step in detail, then shows how to make Sophie
your own.

---

## 1. Install

**Prerequisites**

- [Bun](https://bun.sh) — the installer offers to install it for you if missing.
- A **local model server** (next section). Sophie is the agent; the model runs
  separately.
- *Optional:* `python3` — only needed for the neural TTS voice; everything else
  works without it.

**Steps**

```bash
git clone <your-fork-url> sophie
cd sophie
./install.sh
```

`install.sh`:

1. installs Bun if needed,
2. runs `bun install`,
3. sets up the TTS virtualenv (skipped gracefully if `python3` is absent),
4. creates your `.env` from `.env.example` (leaves an existing `.env` untouched),
5. registers a global `sophie` command via `bun link`.

If Bun's global bin dir isn't on your `PATH` yet, the installer prints the exact
`export PATH=...` line to add to your shell profile (`~/.zshrc` / `~/.bashrc`).

---

## 2. Set up a model server

Sophie needs an **OpenAI-compatible** endpoint with a **Qwen3** model loaded. Pick
one of these.

### Fastest: Ollama

```bash
brew install ollama          # or https://ollama.com/download
ollama pull qwen3            # pick a Qwen3 model that fits your RAM
ollama serve                 # serves http://localhost:11434
```

Then set `SOPHIE_BASE_URL=http://localhost:11434/v1` in `.env`.

### Recommended: llama.cpp + a draft model

Any OpenAI-compatible server works, but `scripts/serve.sh` launches `llama-server`
with the three features Sophie is built to exploit:

- **Prompt-cache reuse** (`--cache-reuse`) — Sophie keeps its system prefix
  byte-stable, so the server skips re-reading it every round.
- **Speculative decoding** (`-md`) — a small same-family draft model (e.g.
  Qwen3-0.6B) proposes tokens the big model verifies: typically **1.5–2.5× faster
  generation with identical output**. Agent output (JSON tool calls, code) drafts
  especially well.
- **Grammar-constrained tool calls** — Sophie sends a lazy GBNF grammar that makes
  malformed tool-call JSON impossible at the sampler (harmless on other servers).

```bash
brew install llama.cpp       # or build from source

# .env (or environment):
#   SOPHIE_MODEL_PATH=~/models/Qwen3-9B-Q4_K_M.gguf
#   SOPHIE_DRAFT_MODEL_PATH=~/models/Qwen3-0.6B-Q8_0.gguf   # optional but fast
./scripts/serve.sh
# then point Sophie at it:
#   SOPHIE_BASE_URL=http://127.0.0.1:8080/v1
```

**Which model?** A ~30–35B Qwen3 MoE (e.g. `Qwen3-35B-A3B`) is the sweet spot on a
64GB machine: big-model quality, small-model speed. On tighter RAM, drop to a 14B
or an 8B at a `Q4_K_M` quant. On Apple Silicon the full unified memory is available
to the GPU, so "VRAM" limits don't apply the way they do on discrete GPUs.

---

## 3. Configure

The first time you launch `sophie`, a **setup wizard** walks you through every
setting — model URL, speech, Telegram, and search keys — and writes them to `.env`.
Re-run it anytime with **`/setup`**.

Prefer to edit by hand? Everything lives in `.env` (see `.env.example` for the full,
commented list). The keys you'll touch most:

| Key | What it does |
|-----|--------------|
| `SOPHIE_BASE_URL` | Your server's OpenAI-compatible endpoint (`…/v1`). |
| `SOPHIE_MODEL` | Model name as the server reports it (llama.cpp ignores this and serves whatever is loaded). |
| `SOPHIE_CONTEXT_WINDOW` | Token budget before Sophie trims old turns. Match your server's `-c`. |
| `SOPHIE_MAX_HISTORY_TOKENS` | Hard cap on working history before compaction — keeps a small model coherent even with a huge window. |
| `SOPHIE_DEFAULT_MODE` | `normal` or `plan` on launch. |
| `SOPHIE_TOOL_GRAMMAR` | Sampler-level tool-call JSON constraint (llama.cpp). Leave `true`. |
| `SOPHIE_MODEL_PATH` / `SOPHIE_DRAFT_MODEL_PATH` | GGUFs for `scripts/serve.sh` (main + speculative draft). |
| `TAVILY_API_KEY` / `BRAVE_API_KEY` | Better web search (optional; DuckDuckGo works keyless). |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Two-way remote contact from your phone (optional). |
| `SOPHIE_SPEAK_REPLIES` / `SOPHIE_SPEAK_VOICE` | Speak every reply aloud, and which voice. |

Sampling defaults (`SOPHIE_TEMPERATURE`, `SOPHIE_TOP_P`, etc.) are already tuned to
Qwen3's recommendations — leave them unless you know why you're changing them.

---

## 4. Run

From **anywhere** in your terminal:

```bash
sophie
```

Check the setup without opening the TUI:

```bash
sophie doctor     # verifies install, .env, and that the model server is reachable
```

**Attach an image** to the current message by referencing its path:

```text
what is in @~/Desktop/screenshot.png?
compare "@/Users/me/Desktop/photo with spaces.jpg" to this design
```

Sophie can also find and inspect images herself (`find_images` + `describe_images`)
using your local vision-capable model.

### Keys

| Key | Action |
|-----|--------|
| `Shift+Tab` | Toggle Plan / Normal mode |
| `/` | Open the slash-command menu (↑/↓ to pick) |
| `Esc` | Interrupt the current response |
| `Ctrl+C` | Quit |

Slash commands: `/plan` · `/normal` · `/setup` · `/continue` · `/new` · `/clear` ·
`/resume` · `/sessions` · `/webapp` · `/memory` · `/commands` · `/help` · `/exit`.

### Phone / web app

`/webapp` starts Sophie's web chat, bound to **this machine and your Tailscale
interface only** — never the open LAN — so you can use it from your phone anywhere
via your tailnet, while strangers on the same wifi can't reach it. On top of that,
every API request requires a per-launch access token: the terminal prints the exact
URLs to open (the token rides in the link). To deliberately bind elsewhere (e.g. a
trusted home LAN) set `SOPHIE_WEBAPP_HOST` or pass `--host`; the token still
protects the API. Stop it with `/webapp stop`, `sophie webapp stop`, or by asking
Sophie to "kill the web app".

---

## 5. Maintain

**Update Sophie** to the latest code:

```bash
cd sophie
git pull
bun install          # in case dependencies changed
./install.sh         # only needed if the launcher/PATH needs refreshing
```

Your `.env` is never overwritten by an update.

**Where Sophie keeps your data** — everything personal lives under `~/.sophie/`:

| Path | Contents |
|------|----------|
| `~/.sophie/SOPHIE.md` | Your persistent memory notebook (facts & preferences). |
| `~/.sophie/memory.jsonl` | Structured/semantic memory entries. |
| `~/.sophie/tasks.json` | Long-term assistant tasks. |
| `~/.sophie/schedule.json`, `calendar.json` | Reminders and scheduled jobs. |
| `~/.sophie/people.jsonl`, `projects.jsonl`, `delegates.jsonl` | Relationship/project context. |
| `~/.sophie/jobs/` | Logs & exit markers for long-running background jobs. |
| `~/.sophie/backups/` | Automatic pre-edit file backups (for undo). |
| `~/.sophie/skills/` | **Your personal skills** (see below). |
| `~/.sophie/mcp.json` | **Your personal MCP servers** (merged with the repo's). |
| `~/.sophie/uploads/`, `screenshots/` | Web-app image uploads and captures. |

**Back up / reset.** To back up everything Sophie knows, copy `~/.sophie/`. To start
fresh, delete it (Sophie recreates what she needs). To edit memory directly, use
**`/memory`** in the TUI (or `/memory project` for the per-project notebook) —
**Ctrl+S** saves, **Esc** cancels.

**Health check.** `sophie doctor` at any time confirms the model server is reachable
and the config is valid — run it first whenever something feels off.

---

## Make Sophie your own

This is the point of a local agent: bend her to *your* workflow. Four extension
points, cheapest first.

### Add a skill (no code)

Skills are markdown **procedures** that teach Sophie how to do a class of task well.
They make a small model punch above its weight without bloating context: only a
one-line catalog stays in the prompt; the full body loads on demand when a task
matches (`load_skill`), then leaves context after the turn.

Drop a `.md` file in [`skills/`](skills/) (ships with Sophie) or in
`~/.sophie/skills/` (personal; overrides a repo skill of the same name):

```markdown
---
name: pay-invoices
description: What this procedure accomplishes, in one line
when: The trigger — when should Sophie reach for this? (this is her routing signal)
---

# Pay invoices

1. Read the invoice PDF with read_document.
2. Extract vendor, amount, due date — state each with its source.
3. Draft the payment note; ask the user to confirm before sending.

Rules:
- Cite the source line for every number. Never guess an amount.
```

**The `when:` line is the most important field** — the always-on catalog shows it as
the trigger, so write it sharply (concrete phrases and situations, not vague
description). Keep the body a short checklist, name the exact tools, and reinforce
"cite sources / don't guess". One job per skill; compose small skills rather than one
giant one. Sophie can even write skills for herself with the `save_skill` tool after
a workflow proves repeatable. Full authoring guide: [`skills/README.md`](skills/README.md).

### Add a tool (code)

Tools are the actions Sophie can take. Implement the `Tool` interface in
[`src/tools/types.ts`](src/tools/types.ts) and register it.

```ts
// src/tools/hello.ts
import type { Tool } from "./types.ts";

export const hello: Tool = {
  name: "hello",
  description: "Greet someone by name. Use when the user asks for a greeting.",
  parameters: {
    type: "object",
    properties: { name: { type: "string", description: "Who to greet." } },
    required: ["name"],
  },
  summarize: (a) => `hello ${a.name}`,          // one line shown in the TUI
  risk: () => "safe",                            // "safe" runs without asking;
                                                 // "caution"/"dangerous" prompt first
  async execute(args) {
    return { content: `Hello, ${args.name}!` };  // returned to the model
  },
};
```

Then register it in [`src/tools/registry.ts`](src/tools/registry.ts) — import it and
add it to the `TOOLS` array. That's enough to make it callable.

**Make it efficient (recommended).** A tool added to `TOOLS` alone is always
disclosed to the model. For anything not needed on every turn, add it to a group in
[`src/tools/groups.ts`](src/tools/groups.ts) (or extend an existing one) so its full
schema only loads when that group activates — either by keyword match on the user's
message, by the model calling `load_tools`, or on first use. This progressive
disclosure is why Sophie stays sharp with ~60 tools installed but only ~12 in the
prompt. Keep `description` and `parameters` tight: every tool schema is prompt tokens
on every round it's disclosed.

**`risk()` is the safety gate.** Return `"safe"` for read-only/reversible work;
`"caution"` or `"dangerous"` for anything that deletes, overwrites, or affects the
outside world — those pause for your `y/n` approval. Classify by the *actual*
arguments (e.g. a `bash` call is safe for `ls`, dangerous for `rm -rf`).

### Add an MCP server (external tools)

Sophie speaks [MCP](https://modelcontextprotocol.io), so any MCP server's tools
become Sophie tools. Add them to [`mcp.json`](mcp.json) (repo-wide) or
`~/.sophie/mcp.json` (personal):

```json
{
  "mcpServers": {
    "shadcn": { "command": "npx", "args": ["shadcn@latest", "mcp"] },
    "my-server": { "command": "npx", "args": ["-y", "@me/my-mcp-server"] }
  }
}
```

Set `"disabled": true` to keep an entry without loading it. MCP tools are deferred
like any other non-core group — cataloged by name, schemas loaded on activation — so
adding servers doesn't bloat the base prompt.

### Give her lasting memory & context

- **Memory:** tell Sophie to "remember" something and she writes it to
  `~/.sophie/SOPHIE.md` with the `remember` tool; she reads it every session. Edit it
  directly with **`/memory`**.
- **Per-project notes:** a `SOPHIE.md` in a project folder is loaded when you work
  there. Sophie also honors `AGENTS.md` / `AGENT.md` / `CLAUDE.md` if present.
- **Voices:** set `SOPHIE_SPEAK_VOICE` (macOS: `say -v '?'` lists voices), or swap
  the Kokoro TTS model/voices via the `SOPHIE_TTS_*` keys in `.env`.

---

## How it works

```
bin/sophie.ts ─► src/index.tsx ─► OpenTUI React app (src/tui)
                                         │
                                         ▼
                                  src/agent/agent.ts   ← think→act→observe loop
                                  ├─ src/llm           ← streaming + Qwen parsing
                                  ├─ src/tools         ← fs + bash + scaffold tools
                                  └─ src/agent/safety  ← approval gate
```

**Tool calling.** Tools are injected into the system prompt in Qwen's `<tools>`
format. Sophie parses `<tool_call>` blocks from the streamed response, runs the tool,
and feeds the result back as a `<tool_response>` — repeating until the turn is done.
This is handled entirely client-side, so it's robust across different servers.

**Thinking.** Normal mode runs with reasoning off (fast). Plan mode reasons at medium
effort (read-only); build mode reasons briefly, then implements.

**Skills & tools (how Sophie stays smart on a small model).** The system prompt is
kept lean and carries only one-line *catalogs* of skills and deferred tool groups.
When a task matches, the full skill body or tool schema is pulled into context, used,
and dropped. This *progressive disclosure* is the key to getting strong behavior out
of a ~30B local model with limited working memory. The prompt design follows current
guidance ([Anthropic context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents),
[AGENTS.md](https://agents.md/)): minimal-but-sufficient, heuristics over brittle
rules, just-in-time context. The facts-only mandate and work loop live in
[src/agent/prompt.ts](src/agent/prompt.ts).

**Safety.** Every tool call passes through one gate ([src/agent/safety.ts](src/agent/safety.ts)).
Read-only calls run instantly; mutating/destructive calls require your `y/n`
approval. Plan mode is locked to read-only tools.

---

## Security & privacy

Sophie runs shell commands and edits files on your machine, and is local-first by
design. See [SECURITY.md](SECURITY.md) for the trust model, exactly what does and
doesn't leave your machine, and how to report a vulnerability.

## License

MIT — see [LICENSE](LICENSE).
