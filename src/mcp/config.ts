import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "../config.ts";
import { trustedProjectMcpConfigPaths } from "./trust.ts";

/**
 * MCP server config. Claude Code-compatible shape so users can paste an
 * existing `.mcp.json`. Merged from (later wins):
 *   1. <repo>/mcp.json       — built-in defaults (empty by default)
 *   2. ~/.sophie/mcp.json    — user global
 *   3. <cwd>/.sophie/mcp.json or <cwd>/.mcp.json — per project
 * A `disabled: true` entry removes that server from the merged result.
 */
export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  disabled?: boolean;
  /** Default is no network and writes limited to cwd/temp on supported macOS. */
  permissions?: { network?: boolean; filesystem?: "cwd" | "all" };
}

export interface McpConfigFile {
  mcpServers?: Record<string, McpServerConfig>;
}

function readConfig(path: string): McpConfigFile | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object") return parsed as McpConfigFile;
  } catch (err) {
    process.stderr.write(`[mcp] ignoring invalid ${path}: ${(err as Error).message}\n`);
  }
  return null;
}

/** Config files in precedence order (lowest → highest). */
function configPaths(cwd: string): string[] {
  return [
    join(REPO_ROOT, "mcp.json"),
    join(homedir(), ".sophie", "mcp.json"),
    ...trustedProjectMcpConfigPaths(cwd),
  ];
}

/** Merge all config layers and drop disabled servers. Returns enabled servers. */
export function loadEnabledServers(cwd: string): Record<string, McpServerConfig> {
  const merged: Record<string, McpServerConfig> = {};
  for (const path of configPaths(cwd)) {
    const file = readConfig(path);
    for (const [name, server] of Object.entries(file?.mcpServers ?? {})) {
      merged[name] = { ...merged[name], ...server };
    }
  }
  const enabled: Record<string, McpServerConfig> = {};
  for (const [name, server] of Object.entries(merged)) {
    if (server.disabled) continue;
    if (!server.command) continue;
    enabled[name] = server;
  }
  return enabled;
}
