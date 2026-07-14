import { sanitizedCommandEnvironment, sandboxedShellCommand } from "../system/command-sandbox.ts";

/**
 * Minimal MCP stdio client. Speaks newline-delimited JSON-RPC 2.0 to a child
 * process (the MCP server). This is the ONLY protocol code; everything else in
 * src/mcp builds on this. Hand-rolled to keep Sophie dependency-free — the
 * official SDK pulls a full HTTP/server stack a stdio client never uses.
 *
 * MCP stdio framing is one JSON message per line (NOT LSP Content-Length).
 */

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: { type?: string; properties?: Record<string, unknown>; required?: string[] };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean; title?: string };
}

export interface McpContentPart {
  type: string;
  text?: string;
  [k: string]: unknown;
}

export interface McpCallResult {
  content?: McpContentPart[];
  isError?: boolean;
}

interface Pending {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const STDERR_RING = 20;

export interface StdioServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  permissions?: { network?: boolean; filesystem?: "cwd" | "all" };
}

const INHERITED_ENV = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE"];

/** MCP children get only process-launch essentials. Credentials must be opted in
 * explicitly in that server's trusted config instead of leaking wholesale. */
export function mcpChildEnvironment(explicit: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of INHERITED_ENV) if (process.env[key] !== undefined) env[key] = process.env[key]!;
  return { ...env, ...explicit };
}

/** Recursively SIGTERM a process and all its descendants (POSIX: pgrep -P). */
function killProcessTree(pid: number): void {
  try {
    const out = Bun.spawnSync(["pgrep", "-P", String(pid)]).stdout?.toString().trim();
    for (const child of (out ? out.split("\n") : []).map(Number).filter(Boolean)) {
      killProcessTree(child);
    }
  } catch {
    /* pgrep unavailable (non-POSIX) — best effort */
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* already gone */
  }
}

export class StdioMcpClient {
  readonly serverName: string;
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private stdoutBuf = "";
  private readonly stderrLines: string[] = [];
  private closed = false;
  private exitReason: string | null = null;

  constructor(serverName: string, private readonly cfg: StdioServerConfig) {
    this.serverName = serverName;
  }

  /** Spawn the child and run the MCP initialize handshake. */
  async initialize(timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<void> {
    const command = [this.cfg.command, ...(this.cfg.args ?? [])];
    const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
    const argv = sandboxedShellCommand(
      command.map(shellQuote).join(" "),
      this.cfg.cwd ?? process.cwd(),
      [],
      {
        allowNetwork: this.cfg.permissions?.network === true,
        allowAllWrites: this.cfg.permissions?.filesystem === "all",
      },
    );
    this.proc = Bun.spawn(argv, {
      cwd: this.cfg.cwd,
      env: { ...sanitizedCommandEnvironment(), ...mcpChildEnvironment(this.cfg.env) },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    void this.readStdout();
    void this.readStderr();
    void this.proc.exited.then((code) => {
      this.exitReason = `server "${this.serverName}" exited (code ${code})`;
      this.failAll(new Error(this.exitReason));
      this.closed = true;
    });

    await this.request(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "sophie", version: "0.1.0" },
      },
      timeoutMs,
    );
    // MCP requires this notification after a successful initialize.
    this.notify("notifications/initialized", {});
  }

  async listTools(timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<McpToolDef[]> {
    const result = await this.request("tools/list", {}, timeoutMs);
    const tools = (result?.tools ?? []) as McpToolDef[];
    return Array.isArray(tools) ? tools : [];
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<McpCallResult> {
    return (await this.request("tools/call", { name, arguments: args ?? {} }, timeoutMs)) as McpCallResult;
  }

  /** Recent stderr lines, for diagnostics when a server misbehaves. */
  diagnostics(): string {
    return this.stderrLines.join("\n") || this.exitReason || "";
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new Error(`client for "${this.serverName}" closed`));
    const pid = this.proc?.pid;
    try {
      this.proc?.kill();
    } catch {
      /* already gone */
    }
    // Launchers like `npx`/`npm exec` spawn the real server as a grandchild
    // that outlives the wrapper, so kill the whole descendant tree too.
    if (typeof pid === "number") killProcessTree(pid);
  }

  // --- internals -----------------------------------------------------------

  private request(method: string, params: unknown, timeoutMs: number): Promise<any> {
    if (this.closed || !this.proc) {
      return Promise.reject(new Error(this.exitReason ?? `client for "${this.serverName}" is not running`));
    }
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms (server "${this.serverName}")`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write(payload);
    });
  }

  private notify(method: string, params: unknown): void {
    if (this.closed || !this.proc) return;
    this.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  private write(data: string): void {
    const stdin = this.proc?.stdin;
    if (stdin && typeof (stdin as any).write === "function") {
      (stdin as any).write(data);
      if (typeof (stdin as any).flush === "function") (stdin as any).flush();
    }
  }

  private async readStdout(): Promise<void> {
    const stream = this.proc?.stdout;
    if (!stream || typeof (stream as any).getReader !== "function") return;
    const reader = (stream as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        this.stdoutBuf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = this.stdoutBuf.indexOf("\n")) !== -1) {
          const line = this.stdoutBuf.slice(0, nl).trim();
          this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
          if (line) this.handleMessage(line);
        }
      }
    } catch {
      /* stream ended */
    }
  }

  private async readStderr(): Promise<void> {
    const stream = this.proc?.stderr;
    if (!stream || typeof (stream as any).getReader !== "function") return;
    const reader = (stream as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const line of decoder.decode(value, { stream: true }).split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          this.stderrLines.push(trimmed);
          if (this.stderrLines.length > STDERR_RING) this.stderrLines.shift();
        }
      }
    } catch {
      /* stream ended */
    }
  }

  private handleMessage(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // ignore non-JSON noise on stdout
    }
    // Server-initiated requests/notifications: we expose no capabilities, so
    // we only need to answer requests (those carry an id) to avoid hanging the
    // peer. Notifications (no id) are ignored.
    if (msg.id !== undefined && msg.method) {
      this.respondUnsupported(msg.id, msg.method);
      return;
    }
    if (msg.id === undefined) return; // notification from server — ignore

    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.error) {
      pending.reject(new Error(msg.error?.message ?? `RPC error from "${this.serverName}"`));
    } else {
      pending.resolve(msg.result);
    }
  }

  private respondUnsupported(id: number | string, method: string): void {
    if (this.closed || !this.proc) return;
    this.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `method not supported by client: ${method}` },
      }) + "\n",
    );
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}
