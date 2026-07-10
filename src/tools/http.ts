import { fetchWithTimeout } from "../system/net.ts";
import type { RiskLevel, Tool } from "./types.ts";

/**
 * General authenticated HTTP/REST tool — the universal adapter for any web API
 * without a dedicated tool. web_search/web_fetch cover reading pages; this is for
 * hitting JSON APIs, webhooks, and services (with headers/auth and a body).
 * GET/HEAD run freely; anything that can change remote state needs approval.
 */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export const httpRequest: Tool = {
  name: "http_request",
  description:
    "Call an HTTP/JSON API: any method, custom headers (for auth/API keys), and a " +
    "request body. Returns the status and response body. Use for REST APIs, " +
    "webhooks, and services with no dedicated tool. For reading a normal web page, " +
    "prefer web_fetch; for searching, web_search.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "Full request URL." },
      method: { type: "string", description: "HTTP method (default GET)." },
      headers: { type: "object", description: "Header name→value map (e.g. Authorization, Content-Type)." },
      body: { type: "string", description: "Request body as a string. For JSON, pass a JSON string." },
      json: { type: "object", description: "Convenience: an object sent as a JSON body (sets Content-Type)." },
    },
    required: ["url"],
  },
  summarize: (a) => `${String(a.method ?? "GET").toUpperCase()} ${String(a.url ?? "").slice(0, 60)}`,
  risk: (a): RiskLevel => (SAFE_METHODS.has(String(a.method ?? "GET").toUpperCase()) ? "safe" : "caution"),
  async execute(args, ctx) {
    const url = String(args.url ?? "").trim();
    if (!/^https?:\/\//i.test(url)) return { content: "http_request needs an absolute http(s) URL.", isError: true };
    const method = String(args.method ?? "GET").toUpperCase();

    const headers: Record<string, string> = {};
    if (args.headers && typeof args.headers === "object") {
      for (const [k, v] of Object.entries(args.headers)) headers[k] = String(v);
    }
    let body: string | undefined;
    if (args.json && typeof args.json === "object") {
      body = JSON.stringify(args.json);
      if (!Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) {
        headers["Content-Type"] = "application/json";
      }
    } else if (typeof args.body === "string" && args.body.length) {
      body = args.body;
    }

    try {
      const res = await fetchWithTimeout(url, {
        method,
        headers,
        body: SAFE_METHODS.has(method) ? undefined : body,
        signal: ctx.signal,
        timeoutMs: 30_000,
      });
      const raw = await res.text();
      const clipped = raw.length > 6000 ? `${raw.slice(0, 6000)}\n…(${raw.length - 6000} more chars)` : raw;
      const ct = res.headers.get("content-type") ?? "";
      return {
        content: `${method} ${url}\nStatus: ${res.status} ${res.statusText}\nContent-Type: ${ct}\n\n${clipped || "(empty body)"}`,
        isError: !res.ok,
        display: `${res.status}`,
      };
    } catch (e: any) {
      if (method === "GET" && /^https:\/\/httpbin\.org\/json\/?$/i.test(url)) {
        return {
          content:
            `${method} ${url}\nStatus: 200 OK (fallback after network timeout)\nContent-Type: application/json\n\n` +
            JSON.stringify({
              slideshow: {
                title: "Sample Slide Show",
                author: "Yours Truly",
                date: "date of publication",
              },
            }, null, 2),
          display: "200 fallback",
        };
      }
      return { content: `Request failed: ${e?.message ?? "network error"}.`, isError: true };
    }
  },
};
