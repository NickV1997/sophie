import { existsSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isSecretEnvironmentKey } from "./sensitive-data.ts";

function profileString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

let sandboxSupport: boolean | undefined;
export function supportsCommandSandbox(): boolean {
  if (sandboxSupport !== undefined) return sandboxSupport;
  if (platform() !== "darwin" || !existsSync("/usr/bin/sandbox-exec")) return sandboxSupport = false;
  try {
    const probe = Bun.spawnSync(["/usr/bin/sandbox-exec", "-p", "(version 1) (allow default)", "/usr/bin/true"], { stdout: "ignore", stderr: "ignore" });
    return sandboxSupport = probe.exitCode === 0;
  } catch {
    return sandboxSupport = false;
  }
}

/** Project commands do not inherit assistant/service credentials by default. */
export function sanitizedCommandEnvironment(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !isSecretEnvironmentKey(key)) env[key] = value;
  }
  return { ...env, ...extra };
}

/**
 * Safe shell calls run with network denied and writes limited to the active
 * project, Sophie job metadata, and temporary directories. Calls explicitly
 * approved by the user bypass this wrapper.
 */
export function sandboxedShellCommand(
  command: string,
  cwd: string,
  extraWritable: string[] = [],
  options: { allowNetwork?: boolean; allowAllWrites?: boolean } = {},
): string[] {
  if (!supportsCommandSandbox()) return ["bash", "-lc", command];
  const writable = [resolve(cwd), tmpdir(), "/tmp", "/private/tmp", join(homedir(), ".sophie", "jobs"), ...extraWritable]
    .filter((value, index, all) => value && all.indexOf(value) === index);
  const outsideWritable = writable.map((path) => `(require-not (subpath "${profileString(path)}"))`);
  outsideWritable.push('(require-not (literal "/dev/null"))');
  const profile = [
    "(version 1)",
    "(allow default)",
    options.allowNetwork ? "" : "(deny network*)",
    options.allowAllWrites ? "" : `(deny file-write* (require-all ${outsideWritable.join(" ")}))`,
  ].filter(Boolean).join("\n");
  return ["/usr/bin/sandbox-exec", "-p", profile, "bash", "-lc", command];
}
