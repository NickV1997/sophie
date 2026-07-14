export interface ResponseConstraints {
  maxWords?: number;
  maxBullets?: number;
  maxSentences?: number;
  maxLines?: number;
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

function toCount(token: string): number | null {
  const n = NUMBER_WORDS[token.toLowerCase()] ?? Number(token);
  return Number.isInteger(n) && n >= 1 && n <= 99 ? n : null;
}

/** Infer ONLY constraints the user explicitly stated (a number of words,
 *  sentences, bullets/steps, or lines). Vague asks like "keep it brief" are
 *  a style preference for the model, never a runtime contract — mapping them
 *  to hidden numbers is guessing, and guessing here silently truncates
 *  answers the user wanted. */
export function responseConstraintsForInput(input: string): ResponseConstraints {
  const text = input.toLowerCase();
  const out: ResponseConstraints = {};
  const count = "(\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)";

  const words = new RegExp(`\\b(?:under|within|at most|no more than|max(?:imum)?(?: of)?)\\s+${count}\\s+words?\\b`).exec(text);
  if (words) out.maxWords = toCount(words[1]!) ?? undefined;

  const sentences = new RegExp(`\\b(?:in|use|answer in|at most|no more than)\\s+${count}\\s+(?:short\\s+)?sentences?\\b`).exec(text);
  if (sentences) out.maxSentences = toCount(sentences[1]!) ?? undefined;

  const lines = new RegExp(`\\b(?:a|in|only|at most)\\s+${count}[- ]lines?\\b`).exec(text);
  if (lines) out.maxLines = toCount(lines[1]!) ?? undefined;

  const bullets = new RegExp(`\\b(?:in|use|exactly|at most|no more than)\\s+${count}\\s+(?:short\\s+)?(?:steps|bullets|bullet points|points)\\b`).exec(text);
  if (bullets) out.maxBullets = toCount(bullets[1]!) ?? undefined;

  return out;
}

export function responseConstraintDirective(input: string): string {
  const c = responseConstraintsForInput(input);
  const parts = [
    c.maxWords ? `at most ${c.maxWords} words` : "",
    c.maxBullets ? `at most ${c.maxBullets} bullets/numbered steps` : "",
    c.maxSentences ? `at most ${c.maxSentences} sentence${c.maxSentences === 1 ? "" : "s"}` : "",
    c.maxLines ? `at most ${c.maxLines} non-empty lines` : "",
  ].filter(Boolean);
  return parts.length
    ? `Response contract: the final user-facing answer must use plain language and be ${parts.join(", ")}. Tool-round narration is unnecessary.`
    : "";
}

function trimWords(text: string, limit: number): string {
  const words = text.trim().split(/\s+/);
  if (words.length <= limit) return text.trim();
  const clipped = words.slice(0, limit).join(" ");
  const sentence = clipped.match(/^([\s\S]*[.!?])(?:\s|$)/)?.[1];
  return (sentence && sentence.split(/\s+/).length >= Math.floor(limit * 0.55) ? sentence : clipped).trim();
}

function takeSentences(text: string, limit: number): string {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (!".!?".includes(char)) continue;
    // A decimal point is not a sentence boundary ("$317.80 remains").
    if (char === "." && /\d/.test(text[i - 1] ?? "") && /\d/.test(text[i + 1] ?? "")) continue;
    if (text[i + 1] && !/\s/.test(text[i + 1]!)) continue;
    count++;
    if (count >= limit) return text.slice(0, i + 1).trim();
  }
  return text.trim();
}

/** Last-mile guard for explicit length requests only. Intermediate tool
 * narration is hidden separately, so this operates only on the final
 * user-facing answer. */
export function applyResponseConstraints(text: string, input: string): string {
  const constraints = responseConstraintsForInput(input);
  let out = text.trim();
  if (!out) return out;
  if (constraints.maxBullets) {
    let seen = 0;
    out = out.split(/\r?\n/).filter((line) => {
      if (!/^\s*(?:[-*•]|\d+[.)])\s+/.test(line)) return true;
      seen++;
      return seen <= constraints.maxBullets!;
    }).join("\n");
  }
  if (constraints.maxLines) {
    out = out.split(/\r?\n/).filter((line) => line.trim()).slice(0, constraints.maxLines).join("\n");
  }
  if (constraints.maxSentences) {
    out = takeSentences(out, constraints.maxSentences);
  }
  if (constraints.maxWords) out = trimWords(out, constraints.maxWords);
  return out;
}
