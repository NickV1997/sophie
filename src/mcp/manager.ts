import { loadEnabledServers, type McpServerConfig } from "./config.ts";
import { StdioMcpClient, type McpContentPart, type McpToolDef } from "./transport.ts";
import type { JSONSchema, RiskLevel, Tool, ToolResult } from "../tools/types.ts";

/**
 * Connects to configured MCP servers, adapts their tools into Sophie `Tool`s,
 * and registers them so Qwen can call them. General-purpose: any stdio MCP
 * server works (shadcn, Playwright, …) with no per-server code.
 *
 * Bloat control: a hard cap on the number of MCP tools surfaced to the model
 * (SOPHIE_MCP_MAX_TOOLS). Tools beyond the cap are dropped with a warning.
 */

const DESCRIPTION_LIMIT = 300;
const CONNECT_TIMEOUT_MS = 60_000; // first-run `npx` may download the server

function maxTools(): number {
  const raw = Number(process.env.SOPHIE_MCP_MAX_TOOLS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 40;
}

const clients = new Map<string, StdioMcpClient>();

export interface ConnectOptions {
  cwd: string;
  /** Receives adapted tools as each server reports them. */
  register: (tools: Tool[]) => void;
  /** Optional one-line status sink (TUI/stderr). */
  onStatus?: (line: string) => void;
  /** Explicit server map; defaults to the merged on-disk config (tests inject). */
  servers?: Record<string, McpServerConfig>;
}

let registeredCount = 0;

/** Connect to all enabled servers in the background. Never throws. */
export async function connectMcpServers(opts: ConnectOptions): Promise<void> {
  const servers = opts.servers ?? loadEnabledServers(opts.cwd);
  const names = Object.keys(servers);
  if (names.length === 0) return;
  await Promise.all(names.map((name) => connectOne(name, servers[name]!, opts)));
}

async function connectOne(name: string, cfg: McpServerConfig, opts: ConnectOptions): Promise<void> {
  const status = opts.onStatus ?? (() => {});
  const client = new StdioMcpClient(name, { command: cfg.command, args: cfg.args, env: cfg.env, cwd: opts.cwd });
  try {
    await client.initialize(CONNECT_TIMEOUT_MS);
    const defs = await client.listTools(CONNECT_TIMEOUT_MS);
    clients.set(name, client);

    const budget = maxTools() - registeredCount;
    if (budget <= 0) {
      status(`MCP: ${name} connected but tool budget (${maxTools()}) is full — skipping its ${defs.length} tools`);
      client.close();
      clients.delete(name);
      return;
    }
    const kept = defs.slice(0, budget);
    const dropped = defs.length - kept.length;
    const tools = kept.map((def) => adaptTool(name, def));
    registeredCount += tools.length;
    opts.register(tools);

    const extra = dropped > 0 ? ` (${dropped} dropped — raise SOPHIE_MCP_MAX_TOOLS)` : "";
    status(`MCP: ${name} connected — ${tools.length} tool${tools.length === 1 ? "" : "s"}${extra}`);
  } catch (err) {
    const detail = client.diagnostics();
    status(`MCP: ${name} failed — ${(err as Error).message}${detail ? `\n  ${detail}` : ""}`);
    client.close();
  }
}

/** Adapt one MCP tool definition into a Sophie Tool. */
function adaptTool(server: string, def: McpToolDef): Tool {
  const toolName = `mcp__${server}__${def.name}`;
  const rawDesc = (def.description ?? def.annotations?.title ?? def.name).trim();
  const desc =
    `[mcp:${server}] ` +
    (rawDesc.length > DESCRIPTION_LIMIT ? `${rawDesc.slice(0, DESCRIPTION_LIMIT - 1)}…` : rawDesc);

  return {
    name: toolName,
    description: desc,
    parameters: coerceSchema(def.inputSchema),
    summarize: () => `${server}: ${def.name}`,
    // Approval policy: only local file delete/move prompts (see bash classifier).
    // MCP tools (user-enabled servers) run without prompting.
    risk: (): RiskLevel => "safe",
    async execute(args): Promise<ToolResult> {
      const client = clients.get(server);
      if (!client) {
        return { content: `MCP server "${server}" is not connected.`, isError: true };
      }
      try {
        const result = await client.callTool(def.name, args ?? {});
        const text = flattenContent(result.content);
        return { content: text || "(no output)", isError: Boolean(result.isError) };
      } catch (err) {
        return { content: `MCP call failed: ${(err as Error).message}`, isError: true };
      }
    },
  };
}

function coerceSchema(schema: McpToolDef["inputSchema"]): JSONSchema {
  if (!schema || typeof schema !== "object") {
    return { type: "object", properties: {} };
  }
  return {
    type: "object",
    properties: schema.properties ?? {},
    ...(Array.isArray(schema.required) ? { required: schema.required } : {}),
  };
}

function flattenContent(content: McpContentPart[] | undefined): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
    else parts.push(`[${part.type} content]`);
  }
  return parts.join("\n");
}

/** Close every MCP child process. Call from exit handlers. */
export function shutdownMcp(): void {
  for (const client of clients.values()) client.close();
  clients.clear();
  registeredCount = 0;
}
