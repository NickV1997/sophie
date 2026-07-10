import { describe, expect, test } from "bun:test";
import { authorized, resolveBindHosts } from "../src/webapp/server.ts";

const TOKEN = "a".repeat(32);

function req(headers: Record<string, string> = {}): Request {
  return new Request("http://127.0.0.1:3737/api/state", { headers });
}

describe("webapp API token", () => {
  test("accepts the token via X-Sophie-Token header", () => {
    const r = req({ "X-Sophie-Token": TOKEN });
    expect(authorized(r, new URL(r.url), TOKEN)).toBe(true);
  });

  test("accepts the token via Authorization: Bearer", () => {
    const r = req({ Authorization: `Bearer ${TOKEN}` });
    expect(authorized(r, new URL(r.url), TOKEN)).toBe(true);
  });

  test("accepts the token via ?token= query parameter", () => {
    const r = new Request(`http://127.0.0.1:3737/api/state?token=${TOKEN}`);
    expect(authorized(r, new URL(r.url), TOKEN)).toBe(true);
  });

  test("rejects a missing token", () => {
    const r = req();
    expect(authorized(r, new URL(r.url), TOKEN)).toBe(false);
  });

  test("rejects a wrong token of the same length", () => {
    const r = req({ "X-Sophie-Token": "b".repeat(32) });
    expect(authorized(r, new URL(r.url), TOKEN)).toBe(false);
  });

  test("rejects a truncated token", () => {
    const r = req({ "X-Sophie-Token": TOKEN.slice(0, 16) });
    expect(authorized(r, new URL(r.url), TOKEN)).toBe(false);
  });

  test("rejects an empty configured token match", () => {
    const r = req({ "X-Sophie-Token": "" });
    expect(authorized(r, new URL(r.url), TOKEN)).toBe(false);
  });
});

describe("webapp bind hosts", () => {
  test("an explicit override wins verbatim", () => {
    expect(resolveBindHosts("0.0.0.0")).toEqual({ hosts: ["0.0.0.0"], note: "" });
    expect(resolveBindHosts("192.168.1.5").hosts).toEqual(["192.168.1.5"]);
  });

  test("default binding always includes loopback and never 0.0.0.0", () => {
    const { hosts } = resolveBindHosts(undefined);
    expect(hosts[0]).toBe("127.0.0.1");
    expect(hosts).not.toContain("0.0.0.0");
  });

  test("default binding only adds Tailscale CGNAT addresses beyond loopback", () => {
    const { hosts } = resolveBindHosts(undefined);
    for (const host of hosts.slice(1)) {
      expect(host).toMatch(/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./);
    }
  });

  test("explains itself when no Tailscale interface exists", () => {
    const { hosts, note } = resolveBindHosts(undefined);
    if (hosts.length === 1) expect(note).toContain("Tailscale");
    else expect(note).toBe("");
  });
});
