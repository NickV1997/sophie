import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import { displayPath } from "./paths.ts";

/**
 * Machine introspection. A compact summary is injected into Sophie's context
 * every session (so she always knows the OS/arch when downloading or installing),
 * and a fuller report is available on demand via the system_info tool.
 */

function gb(bytes: number): number {
  return Math.round((bytes / 1024 ** 3) * 10) / 10;
}

/** Friendly OS name, computed synchronously (no subprocess). */
export function osLabel(): string {
  const platform = os.platform();
  if (platform === "darwin") return "macOS";
  if (platform === "win32") return "Windows";
  if (platform === "linux") {
    try {
      if (existsSync("/etc/os-release")) {
        const m = readFileSync("/etc/os-release", "utf8").match(/^PRETTY_NAME="?(.*?)"?$/m);
        if (m) return m[1];
      }
    } catch {
      /* fall through */
    }
    return "Linux";
  }
  return platform;
}

/** One-liner for the system prompt: the download-relevant facts (OS + arch). */
export function machineSummary(): string {
  const cpus = os.cpus();
  const cpu = cpus[0]?.model?.replace(/\s+/g, " ").trim() ?? "unknown CPU";
  return `${osLabel()} (${os.platform()} ${os.release()}), ${os.arch()}, ${cpus.length}× ${cpu}, ${gb(
    os.totalmem(),
  )} GB RAM`;
}

/** Full report for the system_info tool (enriches the OS version where it can). */
export async function systemReport(): Promise<string> {
  const cpus = os.cpus();
  let osName = osLabel();
  if (os.platform() === "darwin") {
    try {
      const p = Bun.spawnSync(["sw_vers", "-productVersion"]);
      const v = new TextDecoder().decode(p.stdout).trim();
      if (v) osName = `macOS ${v}`;
    } catch {
      /* keep the synchronous label */
    }
  }
  return [
    `OS:       ${osName}`,
    `Kernel:   ${os.type()} ${os.release()}`,
    `Arch:     ${os.arch()}`,
    `CPU:      ${cpus[0]?.model?.replace(/\s+/g, " ").trim() ?? "?"} (${cpus.length} cores)`,
    `Memory:   ${gb(os.totalmem())} GB total, ${gb(os.freemem())} GB free`,
    "Hostname: (redacted)",
    "User:     (local account name redacted)",
    `Shell:    ${process.env.SHELL ?? "?"}`,
    `Home:     ${displayPath(os.homedir())}`,
    `Runtime:  ${typeof Bun !== "undefined" ? `Bun ${Bun.version}` : `Node ${process.version}`}`,
  ].join("\n");
}
