/**
 * GBNF grammar that makes malformed tool calls impossible at the sampler.
 *
 * llama.cpp supports lazy grammars: generation is unconstrained prose until a
 * trigger word appears, then the grammar constrains everything after it. We
 * trigger on "<tool_call>" so normal answers are untouched, but the moment the
 * model opens a tool call it can only emit
 *   <tool_call>{"name": <a real tool name>, "arguments": {valid JSON}}</tool_call>
 * (repeatable, whitespace-separated). This deletes the whole class of
 * small-model JSON slips (single quotes, "name"= assignments, trailing commas,
 * unclosed tags) that client-side repair could only patch after the fact.
 *
 * The name enum deliberately covers EVERY registered tool, not just the
 * currently disclosed ones — calling a deferred/cataloged tool directly is a
 * supported escape hatch and the grammar must never block it.
 *
 * Servers that don't understand the grammar fields either ignore them (Ollama,
 * LM Studio) or reject the request, which the client catches and latches off
 * for the session — so this is a pure upgrade on llama.cpp and a no-op elsewhere.
 */

/** The trigger that flips the lazy grammar on. Must match the tag the model is
 *  trained to open tool calls with (and what QwenStreamParser scans for). */
export const TOOL_CALL_TRIGGER = "<tool_call>";

export function toolCallGrammar(toolNames: string[]): string {
  const names = toolNames
    .filter((n) => /^[A-Za-z0-9_.:-]+$/.test(n)) // never let an exotic name break the grammar
    .map((n) => `"\\"${n}\\""`)
    .join(" | ");
  if (!names) return "";
  return [
    // The lazy grammar starts matching AT the trigger word, so root begins with
    // the tag. After the final call, only whitespace is allowed — which also
    // stops the model from rambling after its calls.
    `root ::= call (ws call)* ws`,
    `call ::= "<tool_call>" ws "{" ws "\\"name\\"" ws ":" ws toolname ws "," ws "\\"arguments\\"" ws ":" ws object ws "}" ws "</tool_call>"`,
    `toolname ::= ${names}`,
    // Standard JSON value rules (mirrors llama.cpp's json.gbnf).
    `object ::= "{" ws ( member ( ws "," ws member )* )? ws "}"`,
    `member ::= string ws ":" ws value`,
    `array ::= "[" ws ( value ( ws "," ws value )* )? ws "]"`,
    `value ::= object | array | string | number | "true" | "false" | "null"`,
    `string ::= "\\"" char* "\\""`,
    `char ::= [^"\\\\\\x7F\\x00-\\x1F] | "\\\\" (["\\\\bfnrt/] | "u" hex hex hex hex)`,
    `hex ::= [0-9a-fA-F]`,
    `number ::= "-"? ([0-9] | [1-9] [0-9]*) ("." [0-9]+)? ([eE] [-+]? [0-9]+)?`,
    `ws ::= [ \\t\\n\\r]*`,
  ].join("\n");
}
