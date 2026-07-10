import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StdioMcpClient } from "../src/mcp/transport.ts";
import { connectMcpServers, shutdownMcp } from "../src/mcp/manager.ts";
import { loadEnabledServers } from "../src/mcp/config.ts";
import type { Tool } from "../src/tools/types.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "fake-mcp-server.ts");
const fakeServer = { command: process.execPath, args: ["run", FIXTURE] };

afterEach(() => shutdownMcp());

describe("StdioMcpClient transport", () => {
  test("handshake, tools/list, and tools/call over newline JSON-RPC", async () => {
    const client = new StdioMcpClient("fake", fakeServer);
    await client.initialize();
    const tools = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["echo", "shout"]);

    const echoed = await client.callTool("echo", { value: "hi" });
    expect(echoed.content?.[0]?.text).toBe(JSON.stringify({ value: "hi" }));

    const shouted = await client.callTool("shout", { text: "loud" });
    expect(shouted.content?.[0]?.text).toBe("LOUD");
    client.close();
  });

  test("rejects pending calls when the server exits", async () => {
    const client = new StdioMcpClient("dead", { command: process.execPath, args: ["-e", "process.exit(0)"] });
    await expect(client.initialize(2000)).rejects.toThrow();
  });
});

describe("manager tool adaptation", () => {
  test("adapts MCP tools into namespaced Sophie tools with risk + execute", async () => {
    const registered: Tool[] = [];
    await connectMcpServers({
      cwd: process.cwd(),
      servers: { fake: fakeServer },
      register: (tools) => registered.push(...tools),
    });

    const names = registered.map((t) => t.name).sort();
    expect(names).toEqual(["mcp__fake__echo", "mcp__fake__shout"]);

    const echo = registered.find((t) => t.name === "mcp__fake__echo")!;
    const shout = registered.find((t) => t.name === "mcp__fake__shout")!;
    // Approval policy: MCP tools run without prompting (only local delete/move asks).
    expect(echo.risk({})).toBe("safe");
    expect(shout.risk({})).toBe("safe");
    // description carries the server-origin prefix.
    expect(echo.description.startsWith("[mcp:fake]")).toBe(true);
    // inputSchema coerced, required preserved.
    expect(shout.parameters.required).toEqual(["text"]);

    const result = await shout.execute({ text: "ok" }, { cwd: process.cwd() });
    expect(result.isError).toBeFalsy();
    expect(result.content).toBe("OK");
  });

  test("tool budget caps the number of registered MCP tools", async () => {
    const prev = process.env.SOPHIE_MCP_MAX_TOOLS;
    process.env.SOPHIE_MCP_MAX_TOOLS = "1";
    try {
      const registered: Tool[] = [];
      const statuses: string[] = [];
      await connectMcpServers({
        cwd: process.cwd(),
        servers: { fake: fakeServer },
        register: (tools) => registered.push(...tools),
        onStatus: (s) => statuses.push(s),
      });
      expect(registered.length).toBe(1);
      expect(statuses.some((s) => s.includes("dropped"))).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.SOPHIE_MCP_MAX_TOOLS;
      else process.env.SOPHIE_MCP_MAX_TOOLS = prev;
    }
  });
});

describe("config precedence", () => {
  test("project config overrides and can disable lower layers", () => {
    const dir = mkdtempSync(join(tmpdir(), "sophie-mcp-"));
    try {
      mkdirSync(join(dir, ".sophie"), { recursive: true });
      // Global layer enables a server; project layer disables it and adds another.
      writeFileSync(
        join(dir, ".sophie", "mcp.json"),
        JSON.stringify({ mcpServers: { foo: { command: "echo", args: ["foo"] } } }),
      );
      writeFileSync(
        join(dir, ".mcp.json"),
        JSON.stringify({ mcpServers: { foo: { command: "echo", disabled: true }, bar: { command: "echo" } } }),
      );
      const servers = loadEnabledServers(dir);
      expect(servers.foo).toBeUndefined(); // disabled by project layer
      expect(servers.bar).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
