import type { Tool } from "./types.ts";

/**
 * Exact arithmetic for a model that is not. A 35B model reliably reasons about
 * WHICH numbers to combine but frequently slips on the actual computation, so
 * this evaluates a math expression deterministically with a hand-written parser
 * (never eval) and returns the precise result.
 *
 * Supports + - * / % (modulo) ^ (power, right-assoc), unary minus, parentheses,
 * the constants pi/e/tau, and common functions (sqrt, cbrt, abs, round, floor,
 * ceil, ln, log/log10, log2, exp, the trig/hyperbolic family, min, max, pow,
 * hypot, gcd, lcm, sign, fact). Percentages are written as decimals, e.g.
 * "15% of 200" → 0.15*200.
 */

type Tok =
  | { t: "num"; v: number }
  | { t: "op"; v: string }
  | { t: "lparen" }
  | { t: "rparen" }
  | { t: "comma" }
  | { t: "name"; v: string };

const CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  e: Math.E,
  tau: Math.PI * 2,
};

function factorial(n: number): number {
  if (n < 0 || !Number.isInteger(n)) throw new Error("fact expects a non-negative integer");
  if (n > 170) return Infinity; // beyond double precision
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

function gcd(a: number, b: number): number {
  a = Math.abs(Math.trunc(a));
  b = Math.abs(Math.trunc(b));
  while (b) [a, b] = [b, a % b];
  return a;
}

const FUNCTIONS: Record<string, (...a: number[]) => number> = {
  mean: (...a: number[]) => a.reduce((sum, n) => sum + n, 0) / a.length,
  avg: (...a: number[]) => a.reduce((sum, n) => sum + n, 0) / a.length,
  stdev: (...a: number[]) => {
    const mean = a.reduce((sum, n) => sum + n, 0) / a.length;
    return Math.sqrt(a.reduce((sum, n) => sum + (n - mean) ** 2, 0) / a.length);
  },
  stddev: (...a: number[]) => {
    const mean = a.reduce((sum, n) => sum + n, 0) / a.length;
    return Math.sqrt(a.reduce((sum, n) => sum + (n - mean) ** 2, 0) / a.length);
  },
  stdevs: (...a: number[]) => {
    const mean = a.reduce((sum, n) => sum + n, 0) / a.length;
    return Math.sqrt(a.reduce((sum, n) => sum + (n - mean) ** 2, 0) / Math.max(1, a.length - 1));
  },
  sqrt: Math.sqrt,
  cbrt: Math.cbrt,
  abs: Math.abs,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
  trunc: Math.trunc,
  sign: Math.sign,
  ln: Math.log,
  log: Math.log10,
  log10: Math.log10,
  log2: Math.log2,
  exp: Math.exp,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  atan2: Math.atan2,
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
  min: Math.min,
  max: Math.max,
  pow: Math.pow,
  hypot: Math.hypot,
  fact: factorial,
  gcd,
  lcm: (a: number, b: number) => (a === 0 || b === 0 ? 0 : Math.abs(Math.trunc(a) * Math.trunc(b)) / gcd(a, b)),
};

function tokenize(input: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const s = input;
  while (i < s.length) {
    const c = s[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "_" || c === ",") {
      // Underscores and commas are digit-group separators; a bare comma is also
      // an argument separator, handled explicitly below only inside parens.
      if (c === ",") toks.push({ t: "comma" });
      i++;
      continue;
    }
    if (c >= "0" && c <= "9") {
      let j = i;
      while (j < s.length && /[0-9_]/.test(s[j])) j++;
      if (s[j] === ".") {
        j++;
        while (j < s.length && /[0-9_]/.test(s[j])) j++;
      }
      if (s[j] === "e" || s[j] === "E") {
        let k = j + 1;
        if (s[k] === "+" || s[k] === "-") k++;
        if (/[0-9]/.test(s[k] ?? "")) {
          k++;
          while (k < s.length && /[0-9]/.test(s[k])) k++;
          j = k;
        }
      }
      toks.push({ t: "num", v: Number(s.slice(i, j).replace(/_/g, "")) });
      i = j;
      continue;
    }
    if (c === ".") {
      let j = i + 1;
      while (j < s.length && /[0-9]/.test(s[j])) j++;
      if (j === i + 1) throw new Error(`unexpected '.' at position ${i}`);
      toks.push({ t: "num", v: Number(s.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[a-zA-Z]/.test(c)) {
      let j = i;
      while (j < s.length && /[a-zA-Z0-9]/.test(s[j])) j++;
      toks.push({ t: "name", v: s.slice(i, j).toLowerCase() });
      i = j;
      continue;
    }
    if ("+-*/%^".includes(c)) {
      // ** as an alias for ^
      if (c === "*" && s[i + 1] === "*") {
        toks.push({ t: "op", v: "^" });
        i += 2;
        continue;
      }
      toks.push({ t: "op", v: c });
      i++;
      continue;
    }
    if (c === "(") {
      toks.push({ t: "lparen" });
      i++;
      continue;
    }
    if (c === ")") {
      toks.push({ t: "rparen" });
      i++;
      continue;
    }
    throw new Error(`unexpected character '${c}' at position ${i}`);
  }
  return toks;
}

/** Recursive-descent evaluator over the token stream. */
function evaluate(toks: Tok[]): number {
  let pos = 0;
  const peek = () => toks[pos];
  const next = () => toks[pos++];

  function parseExpr(): number {
    let left = parseTerm();
    for (let tk = peek(); tk?.t === "op" && (tk.v === "+" || tk.v === "-"); tk = peek()) {
      next();
      const right = parseTerm();
      left = tk.v === "+" ? left + right : left - right;
    }
    return left;
  }

  function parseTerm(): number {
    let left = parseUnary();
    for (let tk = peek(); tk?.t === "op" && (tk.v === "*" || tk.v === "/" || tk.v === "%"); tk = peek()) {
      next();
      const right = parseUnary();
      left = tk.v === "*" ? left * right : tk.v === "/" ? left / right : left % right;
    }
    return left;
  }

  function parseUnary(): number {
    const tk = peek();
    if (tk?.t === "op" && (tk.v === "+" || tk.v === "-")) {
      next();
      const val = parseUnary();
      return tk.v === "-" ? -val : val;
    }
    return parsePower();
  }

  function parsePower(): number {
    const base = parsePrimary();
    const tk = peek();
    if (tk?.t === "op" && tk.v === "^") {
      next();
      const exp = parseUnary(); // right-associative, and binds tighter than unary on the right
      return Math.pow(base, exp);
    }
    return base;
  }

  function parsePrimary(): number {
    const tk = next();
    if (!tk) throw new Error("unexpected end of expression");
    if (tk.t === "num") return tk.v;
    if (tk.t === "lparen") {
      const v = parseExpr();
      if (peek()?.t !== "rparen") throw new Error("missing closing parenthesis");
      next();
      return v;
    }
    if (tk.t === "name") {
      if (tk.v in CONSTANTS) return CONSTANTS[tk.v];
      const fn = FUNCTIONS[tk.v];
      if (!fn) throw new Error(`unknown name '${tk.v}'`);
      if (peek()?.t !== "lparen") throw new Error(`'${tk.v}' must be called with parentheses`);
      next();
      const args: number[] = [];
      if (peek()?.t !== "rparen") {
        args.push(parseExpr());
        while (peek()?.t === "comma") {
          next();
          args.push(parseExpr());
        }
      }
      if (peek()?.t !== "rparen") throw new Error(`missing closing parenthesis after '${tk.v}('`);
      next();
      return fn(...args);
    }
    throw new Error("unexpected token in expression");
  }

  const result = parseExpr();
  if (pos !== toks.length) throw new Error("trailing tokens after a complete expression");
  return result;
}

export function calculate(expression: string): number {
  const toks = tokenize(expression);
  if (!toks.length) throw new Error("empty expression");
  const result = evaluate(toks);
  if (typeof result !== "number" || Number.isNaN(result)) throw new Error("expression did not evaluate to a number");
  return result;
}

/** Human-friendly formatting: keep integers exact, trim float noise. */
function format(n: number): string {
  if (!Number.isFinite(n)) return n > 0 ? "Infinity" : n < 0 ? "-Infinity" : "NaN";
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
  // Round away binary float noise (e.g. 0.1+0.2) while keeping real precision.
  const rounded = Number(n.toPrecision(12));
  return String(rounded);
}

export const calc: Tool = {
  name: "calc",
  description:
    "Evaluate a math expression exactly. Use this for ANY arithmetic instead of " +
    "computing in your head — you are unreliable at mental math. Supports + - * / " +
    "% (modulo) ^ (power), parentheses, constants (pi, e, tau) and functions " +
    "(sqrt, abs, round, floor, ceil, ln, log, log2, exp, sin/cos/tan, min, max, mean, stddev, " +
    "pow, hypot, gcd, lcm, fact). Write percentages as decimals, e.g. '15% of 200' " +
    "as '0.15*200'.",
  parameters: {
    type: "object",
    properties: {
      expression: {
        type: "string",
        description: "The math expression to evaluate, e.g. '(1234.5 * 0.0825) + 10' or 'sqrt(2)^2'.",
      },
    },
    required: ["expression"],
  },
  summarize: (a) => String(a.expression ?? "").slice(0, 60),
  risk: () => "safe",
  async execute(args) {
    const expression = String(args.expression ?? "").trim();
    if (!expression) return { content: "calc needs an expression.", isError: true };
    try {
      const result = calculate(expression);
      const out = format(result);
      return { content: `${expression} = ${out}`, display: out };
    } catch (e: any) {
      return {
        content: `Could not evaluate "${expression}": ${e?.message ?? "invalid expression"}.`,
        isError: true,
        display: "invalid",
      };
    }
  },
};
