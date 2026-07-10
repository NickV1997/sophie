import { afterEach, describe, expect, test } from "bun:test";
import { fetchWithTimeout } from "../src/system/net.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("fetchWithTimeout", () => {
  test("times out a hung request with a clear message", async () => {
    globalThis.fetch = ((_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
      })) as typeof fetch;

    await expect(fetchWithTimeout("https://example.invalid", { timeoutMs: 20 })).rejects.toThrow(/timed out/);
  });

  test("returns normally for a fast response", async () => {
    globalThis.fetch = (async () => new Response("ok")) as typeof fetch;

    const res = await fetchWithTimeout("https://example.invalid", { timeoutMs: 2000 });
    expect(await res.text()).toBe("ok");
  });

  test("an external abort surfaces as an AbortError, not a timeout", async () => {
    globalThis.fetch = ((_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
      })) as typeof fetch;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);

    const promise = fetchWithTimeout("https://example.invalid", { signal: controller.signal, timeoutMs: 10_000 });
    await expect(promise).rejects.toThrow();
    await promise.catch((e: any) => {
      expect(String(e?.message ?? e)).not.toMatch(/timed out/);
    });
  });
});
