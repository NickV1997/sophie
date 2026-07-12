import { config } from "../config.ts";

let activeModel = config.model;

/** Model id currently selected after startup discovery. Tool-protocol
 * selection uses this rather than trusting a possibly stale configured id. */
export function getActiveModel(): string {
  return activeModel;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: ChatContent;
}

export type ChatContent = string | ChatContentPart[];

export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

/** Collect OpenAI-compatible streamed tool-call deltas and normalize them to
 * Sophie's canonical tagged JSON. llama.cpp's native chat parsers (GLM,
 * GPT-OSS, Gemma, Qwen, and future supported templates) may move a model's raw
 * call out of `content` and into `delta.tool_calls`; without this bridge the
 * agent sees an empty response and repeatedly nudges the model. */
export class NativeToolCallAccumulator {
  private calls = new Map<number, { name: string; arguments: string | Record<string, unknown> }>();

  push(value: unknown): void {
    if (!Array.isArray(value)) return;
    for (let position = 0; position < value.length; position++) {
      const delta: any = value[position];
      if (!delta || typeof delta !== "object") continue;
      const index = Number.isInteger(delta.index) ? delta.index : position;
      const fn = delta.function && typeof delta.function === "object" ? delta.function : delta;
      const current = this.calls.get(index) ?? { name: "", arguments: "" };
      if (typeof fn.name === "string") current.name += fn.name;
      if (typeof fn.arguments === "string") {
        current.arguments = typeof current.arguments === "string" ? current.arguments + fn.arguments : fn.arguments;
      } else if (fn.arguments && typeof fn.arguments === "object") {
        current.arguments = fn.arguments;
      }
      this.calls.set(index, current);
    }
  }

  render(): string {
    return [...this.calls.entries()]
      .sort(([a], [b]) => a - b)
      .flatMap(([, call]) => {
        const name = call.name.trim();
        if (!name) return [];
        let args: Record<string, unknown> = {};
        if (typeof call.arguments === "string") {
          try {
            const parsed = JSON.parse(call.arguments || "{}");
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed;
          } catch {
            // Preserve malformed native arguments for the existing repair path.
            return [`<tool_call>${JSON.stringify({ name, arguments: call.arguments })}</tool_call>`];
          }
        } else {
          args = call.arguments;
        }
        return [`<tool_call>${JSON.stringify({ name, arguments: args })}</tool_call>`];
      })
      .join("\n");
  }
}

export interface CompletionOptions {
  /** Override temperature (plan vs normal mode tune this). */
  temperature?: number;
  /** Abort signal so the TUI can cancel a generation (Esc). */
  signal?: AbortSignal;
  /** Cap completion tokens for this request (clamped to fit the context window). */
  maxTokens?: number;
  /** GBNF grammar, lazily triggered on `<tool_call>`, constraining tool-call
   *  bodies to valid JSON with a real tool name. llama.cpp honors it; other
   *  servers ignore or reject it (rejection latches it off for the session). */
  grammar?: string;
  /** Force a JSON-object reply (used by the tool-call repair path). */
  responseFormat?: { type: "json_object" };
  /** Reasoning level for this request. "off" disables thinking AT THE CHAT
   *  TEMPLATE (chat_template_kwargs.enable_thinking=false) — newer Qwen models
   *  ignore the `/no_think` soft switch, so the prompt text alone is not
   *  enough. "low"/"medium"/"high" leave thinking on; depth is steered by the prompt.
   *  Servers without template kwargs ignore the field (the soft switch in the
   *  prompt remains as fallback for models that still honor it). */
  thinking?: "off" | "low" | "medium" | "high";
  /** When true the caller expects tool calls this round. Lowers temperature
   *  for more deterministic argument selection (tool args, not prose, need
   *  precision). Uses the configured value when false/absent. */
  expectingTools?: boolean;
  /** Override top_p for this request. Callers set this based on thinking
   *  level: Qwen3 recommends 0.95 for thinking, 0.8 for non-thinking. */
  topP?: number;
}

function thinkingFields(opts: CompletionOptions): Record<string, unknown> {
  return opts.thinking === "off" ? { chat_template_kwargs: { enable_thinking: false } } : {};
}

/**
 * Qwen3-optimized sampling parameters for every request.
 *
 * Qwen3 official recommendations (README + model card):
 *   top_k=20  — tighter nucleus than the default unlimited, reduces long-tail
 *               token selection that small models exploit when repeating
 *   min_p=0   — their baseline; stays 0 so as not to override top_k/top_p
 *   repeat_penalty — not in Qwen's own spec but is sampler-level loop
 *               suppression that fires BEFORE Sophie's in-context detection
 *
 * When a round is expected to produce tool calls (expectingTools), temperature
 * is lowered to TOOL_TEMPERATURE so argument selection is deterministic.
 * Prose rounds (chat, synthesis, summaries) get the configured temperature so
 * replies stay natural. This matches Qwen3's own recommendation: lower temp
 * for structured/constrained output, slightly higher for open-ended text.
 */
const TOOL_TEMPERATURE = 0.3;

function samplingFields(opts: CompletionOptions): Record<string, unknown> {
  const baseTemp = opts.temperature ?? config.temperature;
  // Lower temperature when we expect structured tool-call JSON this round.
  // Keep it above 0 — Qwen3 docs warn that greedy decoding in thinking mode
  // causes repetition loops even though we don't use thinking on tool rounds.
  const temperature = opts.expectingTools ? Math.min(baseTemp, TOOL_TEMPERATURE) : baseTemp;
  // top_p is thinking-mode dependent per Qwen3 official recommendations:
  // thinking=on → 0.95 (wider, the reasoning trace compensates for sampling noise)
  // thinking=off → 0.8 (tighter, no reasoning filter to catch bad tokens)
  const top_p = opts.topP ?? config.topP;
  return {
    temperature,
    top_p,
    top_k: config.topK,
    min_p: config.minP,
    repeat_penalty: config.repeatPenalty,
  };
}

/** Latched true when the server can't do LAZY grammars correctly, so we never
 *  constrain a request on a server that would force every reply into a tool
 *  call. Set by rejection (4xx) or by the support probe below. */
let grammarRejected = false;
let grammarProbe: Promise<void> | null = null;

function grammarFields(opts: CompletionOptions): Record<string, unknown> {
  if (!opts.grammar || grammarRejected || !config.toolGrammar) return {};
  return {
    grammar: opts.grammar,
    grammar_lazy: true,
    // llama.cpp's common_grammar_trigger: type 1 = WORD.
    grammar_triggers: [{ type: 1, value: "<tool_call>" }],
  };
}

/**
 * Empirically verify the server honors LAZY grammars before the first real
 * constrained request. The dangerous failure mode is not rejection — it's a
 * server that accepts `grammar` but ignores `grammar_lazy`, silently applying
 * the grammar from token 0 and forcing EVERY reply to be a tool call (observed
 * live: 200 OK, empty content, "<tool_call>" + whitespace until max_tokens).
 * So we ask for plain prose WITH the grammar fields attached: prose back means
 * lazy works; anything else latches the grammar off for the session. Runs
 * once, adds one tiny request; any probe failure fails safe (grammar off).
 */
function ensureLazyGrammarSupport(grammar: string): Promise<void> {
  if (grammarProbe) return grammarProbe;
  grammarProbe = (async () => {
    try {
      const res = await fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
        signal: AbortSignal.timeout(20_000),
        body: JSON.stringify({
          model: activeModel,
          stream: false,
          temperature: 0,
          max_tokens: 16,
          grammar,
          grammar_lazy: true,
          grammar_triggers: [{ type: 1, value: "<tool_call>" }],
          // Thinking off keeps the probe fast and puts the prose straight into
          // `content`, where the forced-tool-call check looks for it.
          chat_template_kwargs: { enable_thinking: false },
          messages: [{ role: "user", content: "Reply with exactly the word: hello /no_think" }],
        }),
      });
      if (!res.ok) {
        grammarRejected = true;
        return;
      }
      const json: any = await res.json();
      const msg = json?.choices?.[0]?.message ?? {};
      const content = String(msg.content ?? "").trim();
      const reasoning = String(msg.reasoning_content ?? "").trim();
      const forced = !content || content.startsWith("<tool_call>") || reasoning.startsWith("<tool_call>");
      if (forced) grammarRejected = true;
    } catch {
      grammarRejected = true; // can't verify → never risk blocking replies
    }
  })();
  return grammarProbe;
}

export async function completeChat(
  messages: ChatMessage[],
  opts: CompletionOptions = {},
): Promise<string> {
  const res = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    signal: opts.signal,
    body: JSON.stringify({
      model: activeModel,
      stream: false,
      ...samplingFields(opts),
      max_tokens: opts.maxTokens ?? config.maxTokens,
      ...(opts.responseFormat ? { response_format: opts.responseFormat } : {}),
      ...thinkingFields(opts),
      messages,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Model server returned ${res.status} ${res.statusText}. ` +
        `Is it running at ${config.baseUrl}? ${text.slice(0, 300)}`,
    );
  }

  const json = await res.json();
  const message = json.choices?.[0]?.message ?? {};
  const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "");
  // Mirror the raw tagged shape when the server split reasoning out (see
  // streamChat) so downstream stripThink() behaves identically either way.
  const reasoning = typeof message.reasoning_content === "string" ? message.reasoning_content : "";
  return reasoning ? `<think>${reasoning}</think>${content}` : content;
}

/**
 * Streams a chat completion from an OpenAI-compatible endpoint
 * (Ollama / llama.cpp / LM Studio / vLLM). Yields raw text deltas.
 *
 * We deliberately do NOT pass `tools` to the server. Tool-calling is handled
 * entirely in-prompt (Qwen/Hermes `<tool_call>` format) so behaviour is
 * identical across servers regardless of their chat-template support.
 */
export async function* streamChat(
  messages: ChatMessage[],
  opts: CompletionOptions = {},
): AsyncGenerator<string, void, unknown> {
  // Verify lazy-grammar support once before the first constrained request —
  // a server that applies the grammar eagerly would otherwise silently force
  // every reply into an (empty-looking) tool call.
  if (opts.grammar && config.toolGrammar && !grammarRejected) {
    await ensureLazyGrammarSupport(opts.grammar);
  }

  let res: Response;
  for (;;) {
    const grammar = grammarFields(opts);
    res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      signal: opts.signal,
      body: JSON.stringify({
        model: activeModel,
        stream: true,
        ...samplingFields(opts),
        max_tokens: opts.maxTokens ?? config.maxTokens,
        ...grammar,
        ...thinkingFields(opts),
        messages,
      }),
    });
    // A 4xx on a request carrying grammar fields most likely means this server
    // rejects them: latch grammar off for the session and retry once bare. If
    // the failure was unrelated, the bare retry hits it again and throws below.
    if (!res.ok && res.status < 500 && "grammar" in grammar) {
      grammarRejected = true;
      continue;
    }
    break;
  }

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Model server returned ${res.status} ${res.statusText}. ` +
        `Is it running at ${config.baseUrl}? ${text.slice(0, 300)}`,
    );
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // Some servers (llama.cpp with reasoning-format auto) strip the model's
  // <think> block out of `content` and stream it as `reasoning_content`
  // deltas instead. Sophie's parser (and thinking UI) expect the raw tagged
  // stream, so reconstruct the tags around the reasoning channel. On servers
  // that pass raw text through, reasoning_content never appears and this is
  // a no-op.
  let inReasoning = false;
  const nativeToolCalls = new NativeToolCallAccumulator();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by blank lines.
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") {
        if (inReasoning) yield "</think>";
        const calls = nativeToolCalls.render();
        if (calls) yield calls;
        return;
      }
      try {
        const json = JSON.parse(data);
        const delta = json.choices?.[0]?.delta ?? {};
        nativeToolCalls.push(delta.tool_calls);
        const reasoning: string | undefined = delta.reasoning_content;
        if (reasoning) {
          if (!inReasoning) {
            inReasoning = true;
            yield "<think>";
          }
          yield reasoning;
        }
        const content: string | undefined = delta.content;
        if (content) {
          if (inReasoning) {
            inReasoning = false;
            yield "</think>";
          }
          yield content;
        }
      } catch {
        // Partial JSON across chunk boundary — push back and wait for more.
        buffer = line + "\n" + buffer;
        break;
      }
    }
  }
  if (inReasoning) yield "</think>";
}

/**
 * Ask the model server for its real context size so budgeting/compaction match
 * what the server will actually accept. llama.cpp exposes this at the native
 * `/props` endpoint (sibling of `/v1`), as `default_generation_settings.n_ctx`
 * (the per-slot window). Returns null for servers that don't report it (we then
 * keep the configured value).
 */
export async function detectContextWindow(): Promise<{ nCtx: number | null; detail: string }> {
  const root = config.baseUrl.replace(/\/v1\/?$/, "");
  try {
    const res = await fetch(`${root}/props`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) {
      const json: any = await res.json();
      const n = json?.default_generation_settings?.n_ctx ?? json?.n_ctx;
      if (Number.isFinite(n) && n > 0) {
        return { nCtx: Math.floor(n), detail: `llama.cpp /props reports n_ctx=${Math.floor(n)}` };
      }
    }
  } catch {
    /* not llama.cpp, or /props unreachable — fall back to configured value */
  }
  return { nCtx: null, detail: "server did not report a context size; using configured value" };
}

export interface LoadedModelInfo {
  id: string;
  source: string;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function useLoadedModel(info: LoadedModelInfo): LoadedModelInfo {
  activeModel = info.id;
  return info;
}

/**
 * Resolve the model the server is actually exposing for display purposes.
 * llama.cpp reports the loaded GGUF at `/props`; OpenAI-compatible servers
 * usually expose it through `/v1/models`. If a server hosts multiple models,
 * prefer the configured model when it is present.
 */
export async function detectLoadedModel(): Promise<LoadedModelInfo> {
  const root = config.baseUrl.replace(/\/v1\/?$/, "");

  try {
    const res = await fetch(`${root}/props`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) {
      const json: any = await res.json();
      const id = firstString(json?.model_alias, json?.model_path, json?.model, json?.model_name);
      if (id) return useLoadedModel({ id, source: "llama.cpp /props" });
    }
  } catch {
    /* not llama.cpp, or /props unreachable — try the OpenAI-compatible list */
  }

  try {
    const res = await fetch(`${config.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) {
      const json: any = await res.json();
      const entries = [
        ...(Array.isArray(json?.data) ? json.data : []),
        ...(Array.isArray(json?.models) ? json.models : []),
      ];
      const ids = entries
        .map((entry: any) => firstString(entry?.id, entry?.model, entry?.name))
        .filter((id: string | null): id is string => Boolean(id));
      const configured = ids.find((id) => id === config.model);
      const id = configured ?? ids[0];
      if (id) return useLoadedModel({ id, source: "OpenAI /models" });
    }
  } catch {
    /* keep the configured model as a display fallback */
  }

  return useLoadedModel({ id: config.model, source: "SOPHIE_MODEL" });
}

/** Quick reachability probe used on startup. */
export async function ping(): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(`${config.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) return { ok: true, detail: `connected to ${config.baseUrl}` };
    return { ok: false, detail: `server responded ${res.status} at ${config.baseUrl}` };
  } catch (e: any) {
    return { ok: false, detail: `cannot reach ${config.baseUrl} (${e?.message ?? e})` };
  }
}
