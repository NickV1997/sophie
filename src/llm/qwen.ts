import { completeChat } from "./client.ts";
import type { ToolSpec } from "../tools/types.ts";

/**
 * Qwen / Hermes tool-calling format.
 *
 * Qwen3 is trained to emit tool calls as:
 *   <tool_call>
 *   {"name": "fn", "arguments": { ... }}
 *   </tool_call>
 *
 * and to read available tools from a <tools>...</tools> block in the system
 * prompt. We mirror that exact convention so the model behaves as trained.
 */
export function buildToolsBlock(tools: ToolSpec[]): string {
  const specs = tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
  const callSchema = {
    type: "object",
    properties: {
      name: { type: "string" },
      arguments: { type: "object" },
    },
    required: ["name", "arguments"],
  };

  return [
    "# Tools",
    "",
    "You are a function calling AI model. You are provided with function signatures within <tools></tools> XML tags.",
    "You may call one or more functions to assist with the user query. If the available tools are not relevant, respond in natural language.",
    "Don't make assumptions about what values to plug into functions. After calling and executing functions, you will be provided with function results within <tool_response></tool_response> XML tags.",
    "",
    "Here are the available tools:",
    "<tools>",
    JSON.stringify(specs),
    "</tools>",
    "",
    "For each function call return a JSON object with this schema:",
    JSON.stringify(callSchema),
    "",
    "Before calling tools, you may use <scratch_pad></scratch_pad> to briefly plan the tool choice and required arguments.",
    "Each function call must be enclosed within <tool_call></tool_call> XML tags as follows:",
    "<tool_call>",
    '{"name": <function-name>, "arguments": <args-dict>}',
    "</tool_call>",
    "",
    "The JSON inside <tool_call> must be valid JSON: double-quote all keys and string values. Do not write tool calls as prose.",
  ].join("\n");
}

export type ThinkLevel = "off" | "low" | "medium" | "high";

/**
 * Qwen3 toggles its reasoning trace with the soft switches `/think` and
 * `/no_think`. Normal mode runs thinking off for speed; plan mode reasons at
 * MEDIUM effort (find the efficient path) and build mode at LOW effort
 * (brief reasoning, then implement). The on/off is the `/think` token; the
 * high-vs-low depth is reinforced by the PLAN/BUILD prompt blocks, plus a short
 * effort tag here so the cue also rides at the end of the prompt.
 */
export function thinkDirective(level: ThinkLevel): string {
  if (level === "off") return "/no_think";
  if (level === "high") return "/think Reason thoroughly: weigh the options and choose the most efficient path before acting.";
  if (level === "medium") return "/think Reason at medium depth: choose a practical path, then act without over-planning.";
  return "/think Reason briefly — just enough to confirm the approach — then act."; // low
}

export interface ParsedToolCall {
  name: string;
  arguments: Record<string, unknown>;
  raw: string;
}

/**
 * Incremental parser for a streamed Qwen response. Feed it raw deltas; it
 * routes them into "thinking" vs visible "content" and collects any
 * <tool_call> blocks. <think> and Hermes-style <scratch_pad> are treated as
 * thinking. Tags may be split across chunks — we always re-derive from the full
 * accumulated buffer so split tags are handled correctly.
 */
export class ToolStreamParser {
  private raw = "";
  private emittedContent = 0;
  private emittedThinking = 0;

  constructor(
    private readonly onContent: (delta: string) => void,
    private readonly onThinking: (delta: string) => void,
  ) {}

  push(delta: string): void {
    this.raw += delta;
    const { content, thinking } = this.derive();
    if (content.length > this.emittedContent) {
      this.onContent(content.slice(this.emittedContent));
      this.emittedContent = content.length;
    }
    if (thinking.length > this.emittedThinking) {
      this.onThinking(thinking.slice(this.emittedThinking));
      this.emittedThinking = thinking.length;
    }
  }

  /** Scan the buffer into content / thinking, ignoring any open trailing tag. */
  private derive(): { content: string; thinking: string } {
    const src = this.raw;
    let content = "";
    let thinking = "";
    let i = 0;

    while (i < src.length) {
      if (src.startsWith("<think>", i)) {
        const end = src.indexOf("</think>", i + 7);
        if (end === -1) {
          // Still open: hold back any partial trailing "</think>" fragment.
          thinking += trimPartialTag(src.slice(i + 7));
          break;
        }
        thinking += src.slice(i + 7, end);
        i = end + 8;
      } else if (src.startsWith("<scratch_pad>", i)) {
        const end = src.indexOf("</scratch_pad>", i + 13);
        if (end === -1) {
          thinking += trimPartialTag(src.slice(i + 13));
          break;
        }
        thinking += src.slice(i + 13, end);
        i = end + 14;
      } else if (src.startsWith("<tool_call>", i)) {
        const end = src.indexOf("</tool_call>", i + 11);
        if (end === -1) break; // open tool_call: hide its partial body
        i = end + 12;
      } else {
        // Find the next special tag; emit everything before it as content.
        const nextThink = src.indexOf("<think>", i);
        const nextScratch = src.indexOf("<scratch_pad>", i);
        const nextTool = src.indexOf("<tool_call>", i);
        const candidates = [nextThink, nextScratch, nextTool].filter((n) => n !== -1);
        const next = candidates.length ? Math.min(...candidates) : -1;
        if (next === -1) {
          // No more tags — but guard against a partial tag at the very end.
          const tail = src.slice(i);
          const safe = trimPartialTag(tail);
          content += safe;
          break;
        }
        content += src.slice(i, next);
        i = next;
      }
    }
    return { content, thinking };
  }

  /** Pull finalized tool calls out of the completed buffer.
   *
   *  Qwen-agent explicitly strips tool calls that appear inside <think> blocks:
   *  smaller models sometimes hallucinate a <tool_call> mid-thought, and those
   *  phantom calls should never execute. We strip completed think blocks first,
   *  then scan only what's outside for real invocations.
   */
  finalize(): ParsedToolCall[] {
    const calls: ParsedToolCall[] = [];
    const outside = stripReasoningBlocks(this.raw, { stripOpen: true });
    const re = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(outside)) !== null) {
      const body = m[1].trim();
      const parsed = safeParseCall(body);
      if (parsed) calls.push({ ...parsed, raw: body });
    }
    return calls;
  }

  get fullText(): string {
    return this.raw;
  }

  hasToolCallTags(): boolean {
    return /<tool_call>[\s\S]*?<\/tool_call>/.test(stripReasoningBlocks(this.raw, { stripOpen: true }));
  }

  hasStartedToolCall(): boolean {
    return stripReasoningBlocks(this.raw, { stripOpen: true }).includes("<tool_call>");
  }
}

/**
 * Remove reasoning blocks from a Qwen output string.
 * Used by finalize/hasToolCallTags/hasStartedToolCall so we never mistake
 * a hallucinated tool call inside the model's reasoning trace for a real one.
 * At finalization time, an unclosed trailing reasoning block is treated as
 * reasoning through EOF; small models often forget the closing tag, and a
 * tool call inside that malformed trace must never execute.
 */
function stripReasoningBlocks(text: string, opts: { stripOpen: boolean }): string {
  let out = text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<scratch_pad>[\s\S]*?<\/scratch_pad>/gi, "");
  if (!opts.stripOpen) return out;

  for (;;) {
    const think = out.search(/<think>/i);
    const scratch = out.search(/<scratch_pad>/i);
    const starts = [think, scratch].filter((n) => n !== -1);
    if (!starts.length) return out;
    const start = Math.min(...starts);
    out = out.slice(0, start);
  }
}

/** Avoid flushing a half-written "<" that might become "<think>" etc. */
function trimPartialTag(tail: string): string {
  const lt = tail.lastIndexOf("<");
  if (lt === -1) return tail;
  const after = tail.slice(lt);
  // If the trailing fragment could be the start of one of our tags, hold it.
  const couldBeTag = ["<think>", "</think>", "<scratch_pad>", "</scratch_pad>", "<tool_call>", "</tool_call>"].some(
    (tag) => tag.startsWith(after),
  );
  return couldBeTag ? tail.slice(0, lt) : tail;
}

export function safeParseCall(
  body: string,
): { name: string; arguments: Record<string, unknown> } | null {
  const glm = parseGlmCall(body);
  if (glm) return glm;
  for (const candidate of repairCallBodies(body)) {
    try {
      const obj = JSON.parse(candidate);
      if (!obj || typeof obj.name !== "string") continue;
      if (typeof obj.arguments === "string") {
        const parsedArgs = JSON.parse(obj.arguments);
        return {
          name: obj.name,
          arguments: parsedArgs && typeof parsedArgs === "object" ? parsedArgs : {},
        };
      }
      const args =
        obj.arguments && typeof obj.arguments === "object" ? obj.arguments : {};
      return { name: obj.name, arguments: args };
    } catch {
      /* try the next repair candidate */
    }
  }
  return null;
}

/** GLM-4.7 native tool syntax:
 * <tool_call>read_file<arg_key>path</arg_key><arg_value>a.ts</arg_value></tool_call>
 * Values are coerced conservatively; structured JSON remains structured while
 * normal command/path strings stay strings. */
function parseGlmCall(body: string): { name: string; arguments: Record<string, unknown> } | null {
  const firstTag = body.search(/<arg_key>/i);
  if (firstTag < 0) return null;
  const name = body.slice(0, firstTag).trim();
  if (!/^[A-Za-z0-9_.:-]+$/.test(name)) return null;

  const args: Record<string, unknown> = {};
  const re = /<arg_key>\s*([\s\S]*?)\s*<\/arg_key>\s*<arg_value>\s*([\s\S]*?)\s*<\/arg_value>/gi;
  let match: RegExpExecArray | null;
  let count = 0;
  while ((match = re.exec(body)) !== null) {
    const key = match[1].trim();
    if (!key) continue;
    args[key] = parseGlmValue(match[2].trim());
    count++;
  }
  return count ? { name, arguments: args } : null;
}

function parseGlmValue(value: string): unknown {
  if (!value) return "";
  if (/^(?:true|false|null)$/i.test(value) || /^[\[{\"]/.test(value) || /^-?\d+(?:\.\d+)?$/.test(value)) {
    try {
      return JSON.parse(value);
    } catch {
      /* preserve non-JSON text verbatim */
    }
  }
  return value;
}

/**
 * Last line of defense for a tool call that survived streaming malformed
 * beyond what repairCallBodies can patch (or arrived with an unclosed tag):
 * one cheap, deterministic re-emit of just the broken body as forced JSON.
 * Far cheaper than the alternative — a full extra agent round telling the
 * model "your call didn't parse, try again".
 */
export async function repairToolCallsViaModel(raw: string, signal?: AbortSignal): Promise<ParsedToolCall[]> {
  const bodies: string[] = [];
  const closedRe = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  let m: RegExpExecArray | null;
  let lastEnd = 0;
  while ((m = closedRe.exec(raw)) !== null) {
    if (!safeParseCall(m[1].trim())) bodies.push(m[1].trim());
    lastEnd = m.index + m[0].length;
  }
  // An opened-but-never-closed trailing call (the model hit max_tokens or
  // simply forgot the closing tag).
  const tailOpen = raw.indexOf("<tool_call>", lastEnd);
  if (tailOpen !== -1) {
    const tail = raw.slice(tailOpen + "<tool_call>".length).trim();
    if (tail) bodies.push(tail);
  }

  const calls: ParsedToolCall[] = [];
  for (const body of bodies.slice(0, 3)) {
    try {
      const out = await completeChat(
        [
          {
            role: "system",
            content:
              "You repair a malformed AI tool call. Reply with ONLY one valid JSON object of the shape " +
              '{"name": "<tool name>", "arguments": { ... }}. Preserve the intended tool name and every ' +
              "argument value exactly; fix only the syntax. No prose, no markdown. /no_think",
          },
          { role: "user", content: body.slice(0, 6000) },
        ],
        { temperature: 0, maxTokens: 2048, signal, responseFormat: { type: "json_object" }, thinking: "off" },
      );
      const cleaned = out.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
      const parsed = safeParseCall(cleaned);
      if (parsed) calls.push({ ...parsed, raw: body });
    } catch {
      /* repair is best-effort — the agent's retry nudge remains the fallback */
    }
  }
  return calls;
}

/** Backward-compatible name for extensions/tests importing the old class. */
export { ToolStreamParser as QwenStreamParser };

/** Strip trailing commas before a closing } or ] — a very common small-model
 *  JSON slip that JSON.parse rejects outright. */
function stripTrailingCommas(s: string): string {
  return s.replace(/,(\s*[}\]])/g, "$1");
}

/** Close only structurally unbalanced JSON containers. Values, keys, and
 * quotes are untouched, so this cannot change the intended tool or arguments. */
function closeUnbalancedContainers(s: string): string | null {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const char of s) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === "{" || char === "[") stack.push(char);
    else if (char === "}" || char === "]") {
      const expected = char === "}" ? "{" : "[";
      if (stack.pop() !== expected) return null;
    }
  }
  if (inString || !stack.length) return null;
  return s + stack.reverse().map((open) => open === "{" ? "}" : "]").join("");
}

/**
 * Produce a list of progressively-repaired candidate JSON strings for one
 * tool-call body, most-faithful first. safeParseCall tries each until one
 * parses and yields a valid {name, arguments}, so adding aggressive candidates
 * is safe: a candidate that doesn't parse is simply skipped.
 */
function repairCallBodies(body: string): string[] {
  const candidates: string[] = [];
  const add = (s: string) => {
    if (s && !candidates.includes(s)) candidates.push(s);
  };

  add(body);

  // Key-shape repairs (cumulative) for the malformations small models emit.
  const keyRepaired = body
    // Qwen can duplicate the key while trying to repair itself:
    // {"name="name": "write_file", ...}
    .replace(/([{,]\s*)"name\s*=\s*"name"\s*:/, '$1"name":')
    // {"name"="bash", ...} — key is quoted but assigned with '='.
    .replace(/([{,]\s*)"name"\s*=\s*"/, '$1"name":"')
    // Qwen occasionally emits: {"name="bash", "arguments": {...}}
    .replace(/([{,]\s*)"name\s*=\s*"/, '$1"name":"')
    // Qwen occasionally emits: {"name="bash", "arguments": {...}}
    .replace(/([{,]\s*)name\s*=\s*"/, '$1"name":"')
    // Or drops quotes around the key: {name: "bash", "arguments": {...}}
    .replace(/([{,]\s*)name\s*:/, '$1"name":')
    // Qwen occasionally emits: {"name":"edit_file",arguments":{...}}
    .replace(/,\s*arguments"\s*:/, ',"arguments":')
    // And sometimes drops both quotes around the key.
    .replace(/,\s*arguments\s*:/, ',"arguments":');
  add(keyRepaired);

  // Trailing commas before } or ].
  add(stripTrailingCommas(body));
  add(stripTrailingCommas(keyRepaired));
  for (const base of [body, keyRepaired, stripTrailingCommas(body), stripTrailingCommas(keyRepaired)]) {
    const balanced = closeUnbalancedContainers(base);
    if (balanced) add(balanced);
  }

  // Last resort: Python-style single-quoted JSON. Naive but only used as a
  // fallback — if apostrophes inside values break it, JSON.parse just rejects
  // the candidate and we fall through, no worse than before.
  for (const base of [keyRepaired, body]) {
    const doubleQuoted = base.replace(/'/g, '"');
    add(doubleQuoted);
    add(stripTrailingCommas(doubleQuoted));
    const balanced = closeUnbalancedContainers(stripTrailingCommas(doubleQuoted));
    if (balanced) add(balanced);
  }

  return candidates;
}
