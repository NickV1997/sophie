import { fetchWithTimeout } from "../system/net.ts";
import type { Tool } from "./types.ts";

const MAX_TEXT = 12_000;

type SearchHit = { title: string; url: string; snippet: string };

/** Strip tags + common entities from an HTML fragment to plain text. */
function toText(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

/** Drop every occurrence of a container tag and its contents. */
function dropBlocks(html: string, tags: string[]): string {
  for (const tag of tags) {
    html = html.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`, "gi"), " ");
  }
  return html;
}

/**
 * Full-page HTML → readable article text. Readability-style: strip the
 * chrome (nav/header/footer/aside/forms/scripts), prefer the page's declared
 * main content (<main>/<article>/role="main") when present, and keep block
 * structure as line breaks. Every boilerplate token removed here is a token
 * of the model's working memory saved.
 */
export function stripHtml(html: string): string {
  let work = html
    .replace(/<!--[\s\S]*?-->/g, " ");
  work = dropBlocks(work, ["script", "style", "noscript", "svg", "iframe", "template", "head"]);

  // Prefer the declared main-content container when the page has one; pick the
  // largest in case of several (some sites wrap widgets in <article>).
  const containers: string[] = [];
  const containerRe = /<(main|article)\b[^>]*>([\s\S]*?)<\/\1>|<(div|section)\b[^>]*role="main"[^>]*>([\s\S]*?)<\/\3>/gi;
  let cm: RegExpExecArray | null;
  while ((cm = containerRe.exec(work))) containers.push(cm[2] ?? cm[4] ?? "");
  const best = containers.sort((a, b) => b.length - a.length)[0];
  // Only trust the container when it holds a real article, not an empty shell.
  if (best && best.replace(/<[^>]+>/g, "").trim().length > 200) work = best;

  work = dropBlocks(work, ["nav", "header", "footer", "aside", "form", "button", "select", "dialog"]);

  return decodeEntities(
    work
      .replace(/<(li)\b[^>]*>/gi, "\n- ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|section|tr|h[1-6]|ul|ol|blockquote|pre|table|figcaption)>/gi, "\n")
      .replace(/<(h[1-6])\b[^>]*>/gi, "\n\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The page's <title>, for a one-line orientation header. */
export function pageTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(toText(m[1])).slice(0, 200) : "";
}

/** Unwrap DuckDuckGo's `/l/?uddg=` redirect into the real destination URL. */
function ddgHref(raw: string): string {
  const m = raw.match(/[?&]uddg=([^&]+)/);
  let href = m ? decodeURIComponent(m[1]) : raw;
  if (href.startsWith("//")) href = `https:${href}`;
  return href;
}

/** Keyless fallback: scrape DuckDuckGo's HTML endpoint (no signup required). */
async function duckduckgoSearch(query: string, signal?: AbortSignal): Promise<SearchHit[]> {
  const res = await fetchWithTimeout("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    },
    body: new URLSearchParams({ q: query }).toString(),
    signal,
    timeoutMs: 15_000,
  });
  if (!res.ok) throw new Error(`DuckDuckGo ${res.status}`);
  const html = await res.text();
  const hits: SearchHit[] = [];
  const linkRe = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snipRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const snippets: string[] = [];
  let s: RegExpExecArray | null;
  while ((s = snipRe.exec(html))) snippets.push(toText(s[1]));
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) && hits.length < 6) {
    const url = ddgHref(m[1]);
    hits.push({ title: toText(m[2]) || url, url, snippet: snippets[hits.length] ?? "" });
  }
  return hits;
}

/** Tavily (preferred) → Brave (if keyed) → keyless DuckDuckGo. */
async function search(query: string, signal?: AbortSignal): Promise<{ hits: SearchHit[]; via: string }> {
  const tavily = process.env.TAVILY_API_KEY?.trim();
  if (tavily) {
    const res = await fetchWithTimeout("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: tavily, query, max_results: 6, search_depth: "basic" }),
      signal,
      timeoutMs: 15_000,
    });
    if (!res.ok) throw new Error(`Tavily ${res.status}`);
    const json = (await res.json()) as { results?: Array<{ title: string; url: string; content: string }> };
    return {
      hits: (json.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.content })),
      via: "tavily",
    };
  }

  const brave = process.env.BRAVE_API_KEY?.trim();
  if (brave) {
    const res = await fetchWithTimeout(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=6`,
      { headers: { accept: "application/json", "x-subscription-token": brave }, signal, timeoutMs: 15_000 },
    );
    if (!res.ok) throw new Error(`Brave ${res.status}`);
    const json = (await res.json()) as {
      web?: { results?: Array<{ title: string; url: string; description: string }> };
    };
    return {
      hits: (json.web?.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.description })),
      via: "brave",
    };
  }

  return { hits: await duckduckgoSearch(query, signal), via: "duckduckgo" };
}

// ── web_search ─────────────────────────────────────────────────────────────
export const webSearch: Tool = {
  name: "web_search",
  description:
    "Search the web and return ranked title/url/snippet results. Use to find " +
    "current information, then web_fetch the most relevant URL for detail. " +
    "Works keyless via DuckDuckGo; uses Tavily or Brave if a key is configured.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "What to search for." },
    },
    required: ["query"],
  },
  summarize: (a) => `“${a.query}”`,
  risk: () => "safe",
  async execute(args, ctx) {
    const query = String(args.query ?? "").trim();
    if (!query) return { content: "Error: empty query.", isError: true };
    try {
      const { hits, via } = await search(query, ctx.signal);
      if (!hits.length) return { content: "No results.", display: "0 results" };
      const body = hits
        .map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet.slice(0, 280)}`)
        .join("\n\n");
      return { content: body, display: `${hits.length} results · ${via}` };
    } catch (e: any) {
      return {
        content:
          `Error: ${e?.message ?? "search failed"}. ` +
          `If this persists, set TAVILY_API_KEY or BRAVE_API_KEY, or web_fetch a known URL.`,
        isError: true,
      };
    }
  },
};

// ── web_fetch ──────────────────────────────────────────────────────────────
export const webFetch: Tool = {
  name: "web_fetch",
  description:
    "Fetch a URL and return its text (HTML is stripped to readable text, JSON " +
    "is returned raw). Use to read docs, articles, or pages found via web_search.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "Absolute http(s) URL." },
      max_chars: { type: "number", description: `Cap on returned characters (default ${MAX_TEXT}).` },
    },
    required: ["url"],
  },
  summarize: (a) => `${a.url}`,
  risk: () => "safe",
  async execute(args, ctx) {
    const url = String(args.url ?? "");
    if (!/^https?:\/\//.test(url)) return { content: "Error: url must be http(s).", isError: true };
    const cap = Math.min(Number(args.max_chars) || MAX_TEXT, 40_000);
    try {
      const res = await fetchWithTimeout(url, {
        signal: ctx.signal,
        headers: { "user-agent": "sophie/0.1 (+local assistant)" },
        timeoutMs: 30_000,
      });
      const type = res.headers.get("content-type") ?? "";
      const raw = await res.text();
      const isHtml = !type.includes("json") && !type.includes("text/plain");
      const text = isHtml ? stripHtml(raw) : raw;
      const title = isHtml ? pageTitle(raw) : "";
      const out = text.slice(0, cap);
      return {
        content: `URL: ${url}\nHTTP ${res.status} ${type}${title ? `\nTitle: ${title}` : ""}\n\n${out}${text.length > cap ? "\n…(truncated)" : ""}`,
        isError: !res.ok,
        display: `HTTP ${res.status} · ${out.length} chars`,
      };
    } catch (e: any) {
      return { content: `Error fetching ${url}: ${e?.message ?? "failed"}`, isError: true };
    }
  },
};
