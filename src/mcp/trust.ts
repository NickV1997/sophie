import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { memoryHomeDir } from "../memory/facts.ts";
import { readJsonWithRecovery, writePrivateFileAtomic } from "../system/atomic-file.ts";

export interface ProjectMcpConfigStatus {
  path: string;
  contentHash: string;
  trusted: boolean;
  trustedAt?: number;
}

interface TrustRecord {
  path: string;
  contentHash: string;
  trustedAt: number;
}

interface TrustStore {
  schemaVersion: 1;
  records: TrustRecord[];
}

const PROJECT_CONFIGS = [join(".sophie", "mcp.json"), ".mcp.json"];

function storePath(): string {
  return process.env.SOPHIE_MCP_TRUST_PATH || join(memoryHomeDir(), "mcp-project-trust.json");
}

function canonical(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function load(): TrustStore {
  const parsed = readJsonWithRecovery<TrustStore>(storePath());
  return parsed?.schemaVersion === 1 && Array.isArray(parsed.records)
    ? parsed
    : { schemaVersion: 1, records: [] };
}

function save(store: TrustStore): void {
  writePrivateFileAtomic(storePath(), `${JSON.stringify(store, null, 2)}\n`);
}

export function projectMcpConfigStatuses(cwd: string): ProjectMcpConfigStatus[] {
  const records = load().records;
  return PROJECT_CONFIGS
    .map((relative) => join(cwd, relative))
    .filter(existsSync)
    .map((path) => {
      const resolved = canonical(path);
      const contentHash = hashFile(resolved);
      const record = records.find((item) => item.path === resolved && item.contentHash === contentHash);
      return { path: resolved, contentHash, trusted: Boolean(record), trustedAt: record?.trustedAt };
    });
}

/** Trust is content-bound: changing a project MCP file automatically revokes it. */
export function trustProjectMcpConfigs(cwd: string): ProjectMcpConfigStatus[] {
  const statuses = projectMcpConfigStatuses(cwd);
  if (!statuses.length) return [];
  const store = load();
  const paths = new Set(statuses.map((item) => item.path));
  store.records = store.records.filter((item) => !paths.has(item.path));
  const trustedAt = Date.now();
  store.records.push(...statuses.map((item) => ({ path: item.path, contentHash: item.contentHash, trustedAt })));
  save(store);
  return projectMcpConfigStatuses(cwd);
}

export function revokeProjectMcpTrust(cwd: string): number {
  const paths = new Set(PROJECT_CONFIGS.map((relative) => canonical(join(cwd, relative))));
  const store = load();
  const before = store.records.length;
  store.records = store.records.filter((item) => !paths.has(item.path));
  if (store.records.length !== before) save(store);
  return before - store.records.length;
}

export function trustedProjectMcpConfigPaths(cwd: string): string[] {
  return projectMcpConfigStatuses(cwd).filter((item) => item.trusted).map((item) => item.path);
}
