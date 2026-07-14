# Sophie

**A local-first terminal AI assistant.** Sophie is an open-source agent — a mini
[Claude Code](https://claude.com/claude-code) — that runs entirely on *your*
machine against *your own* local model. No cloud, no API keys, no telemetry.

Where most local-model agents are aimed at coding, Sophie is built to be a
**general personal assistant** that happens to have full access to your computer:
she reads and writes files, runs commands, searches, plans, and gets things done
in the terminal.

Built with [OpenTUI](https://github.com/sst/opentui) for a clean,
Claude-Code-inspired interface, with protocol adapters for tool-capable local
models including **Qwen, GLM, Gemma, and GPT-OSS**.

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
  appends to with the `remember` tool, plus a structured memory engine that
  learns from your messages and injects only the few facts relevant to each turn.
- 🌙 **Dream pass** — a ~daily background consolidation (also `sophie dream`)
  that merges near-duplicate memories, prunes junk, summarizes verbose ones,
  retires contradicted facts, and mirrors everything Sophie believes into a
  readable `~/.sophie/memory-report.md`. Disable with `SOPHIE_DREAM=false`.
- 📌 **Long-term task manager** — durable assistant tasks survive across chats.
- 📱 **Reach you anywhere** — native desktop notifications, optional Telegram for
  two-way remote contact, and a Tailscale-ready phone web app.
- 🛡️ **Smart approvals and command sandboxing** — acts freely on scoped work;
  stops before destructive, outward, persistent, sensitive, downloaded, or
  unsandboxed actions. Approval screens show the exact redacted arguments and hash.
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

To skip the optional Python TTS environment, use
`SOPHIE_INSTALL_TTS=0 ./install.sh`. Sophie itself and macOS speech continue to
work without it. Kokoro autostart is off in a fresh configuration; enable it in
`/setup` after installing its model files.

If Bun's global bin dir isn't on your `PATH` yet, the installer prints the exact
`export PATH=...` line to add to your shell profile (`~/.zshrc` / `~/.bashrc`).

---

## 2. Set up a model server

Sophie needs an **OpenAI-compatible** endpoint with a tool-capable instruction
model loaded. Qwen remains a strong default; GLM, Gemma, and GPT-OSS are also
supported. Base models or chat models without tool training can still chat but
cannot be expected to operate the agent reliably.

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
compare "@/path/to/photo with spaces.jpg" to this design
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

### Optional background Sophie (macOS)

Sophie can run continuously under `launchd` for reminders, watchers, Telegram,
calendar reconciliation, and approved background work:

```bash
sophie daemon install
sophie daemon start
sophie daemon status
# later: sophie daemon stop
```

Background work uses the same provenance, capability, and approval guardrails as
the TUI. A task pauses when it needs approval; open Sophie and ask to list
background work, then approve the exact pending call. Approvals are one-use and
argument-bound. The daemon keeps a durable crash-recoverable queue.

### Platform capabilities

Sophie is macOS-first. On macOS she exposes Apple Calendar, Messages, Notes,
Reminders, Contacts, screen capture, and notifications. On Linux or Windows,
Apple-only tools are hidden and the built-in calendar, tasks, memory, filesystem,
web, and general agent tools remain available.

### Secrets and privacy

Run `sophie secrets migrate` on macOS to copy configured API tokens and the Gmail
app password into Keychain. Environment variables remain an explicit override.
The `privacy` tool can inventory, export, retain, or delete scoped local data;
exports deliberately exclude `.env`, credentials, and tokens.

Approximate location lookup is disabled by default. Set
`SOPHIE_LOCATION_LOOKUP=true` only if you want Sophie to make a one-time request
to `ip-api.com` and remember the returned city-level location locally.

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
| `~/.sophie/mcp.json` | **Your personal MCP servers** (merged with trusted project configs). |
| `~/.sophie/mcp-project-trust.json` | Content-hash-bound trust grants for project MCP configs. |
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

**`risk()` is the safety gate.** Return `"safe"` only for scoped,
read-only/reversible work; use `"caution"` or `"dangerous"` for anything that
deletes, overwrites, downloads or executes opaque code, persists authority, or
affects the outside world. Those calls pause for `y/n` approval with redacted exact
arguments and a hash. Runtime provenance can further elevate a nominally safe call
when it follows private or untrusted evidence.

### Add an MCP server (external tools)

Sophie speaks [MCP](https://modelcontextprotocol.io), so trusted MCP servers can
become Sophie tools. Personal servers go in `~/.sophie/mcp.json`. A project's
`.mcp.json` or `.sophie/mcp.json` is ignored until you review it and bind trust to
its current SHA-256 hash with `sophie mcp trust`; changing the file revokes trust.

```json
{
  "mcpServers": {
    "my-reviewed-server": {
      "command": "/absolute/path/to/pinned-mcp-server",
      "args": ["serve"],
      "permissions": { "network": true, "filesystem": "cwd" }
    }
  }
}
```

Use `sophie mcp status` or `sophie mcp revoke` to inspect/revoke project trust.
MCP children receive a minimal environment; credentials must be explicitly supplied
in that server's `env`. On supported macOS systems they default to no network and
cwd/temp-only writes; opt into `permissions.network` or `filesystem: "all"` only
when the reviewed server genuinely needs it. Unknown/mutating MCP tools require
per-call approval; only tools explicitly annotated read-only run freely. MCP tools
remain progressively disclosed, so adding servers does not bloat the base prompt.
Prefer an absolute local executable or an exact package version; do not put
`@latest` package runners in an automatically loaded personal config.

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
                                  ├─ src/llm           ← streaming + model protocol adapters
                                  ├─ src/tools         ← fs + bash + scaffold tools
                                  └─ src/agent/safety  ← approval gate
```

**Tool calling.** `src/llm/tool-protocol.ts` selects a model-family adapter after
startup model discovery. Adapters own tool prompting, parsing, grammar, repair,
and retry syntax. The streaming client also normalizes OpenAI-compatible
`delta.tool_calls` emitted by llama.cpp's native model parsers into Sophie's
canonical internal call shape. Qwen/Hermes JSON and GLM's native arg tags are
supported today; unknown models use the established Qwen/Hermes fallback. Tools
are schema-validated and safety-gated after normalization, so model-specific
syntax never leaks into the execution engine.

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

## Real-world benchmark

`bun run bench:personal-assistant` is the multi-hour release benchmark for
Sophie's core mission. It runs more than 80 sequential, stateful turns across a
parent, student, teacher, freelancer, caregiver, small-business owner, job
seeker, older/nontechnical user, limited-hardware user, and privacy-sensitive
professional. Each persona gets an isolated process and synthetic personal
world. The gate requires at least 9/10 in every field—not merely on average—plus
zero false actions or completion claims. See the
[personal-assistant benchmark guide](src/bench/PERSONAL_ASSISTANT.md).

`bun run bench:real-world` runs 28 stateful interactions across simulated
founder, business-owner, COO, and technical-founder workweeks through the real
Sophie runtime and configured local model. Personal services are deterministic
fakes, each persona receives an isolated Sophie home, and coding tasks execute
only in generated benchmark workspaces. The release gate requires at least 95%
weighted success and zero false actions. See
[the benchmark guide](src/bench/REAL_WORLD.md) for scenarios, scoring, and smoke
commands.

---

## Security & privacy

Sophie runs shell commands and edits files on your machine, and is local-first by
design. See [SECURITY.md](SECURITY.md) for the trust model, exactly what does and
doesn't leave your machine, and how to report a vulnerability.

Before publishing a branch, run `bun run audit:public`. It scans the exact tracked
and unignored file set for local state, private keys, common credential formats,
machine-specific home paths, and unsafe commit metadata. The same check runs in
CI.

## License

MIT — see [LICENSE](LICENSE).
