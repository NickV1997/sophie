import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { config } from "../config.ts";

interface ProtectedProcess {
  pid: string;
  command: string;
  args: string;
}

interface LlmProcessInfo {
  port: string;
  modelName: string;
  processes: ProtectedProcess[];
}

function configuredLlmPort(): string | null {
  try {
    const url = new URL(config.baseUrl);
    if (!/^https?:$/.test(url.protocol)) return null;
    return url.port || (url.protocol === "https:" ? "443" : "80");
  } catch {
    return null;
  }
}

function runText(command: string, args: string[]): string {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 800 }).trim();
  } catch {
    return "";
  }
}

function listeningPids(port: string): string[] {
  const out = runText("lsof", ["-nP", "-tiTCP:" + port, "-sTCP:LISTEN"]);
  return out.split(/\s+/).filter((p) => /^\d+$/.test(p));
}

function processRows(pids: string[]): ProtectedProcess[] {
  if (!pids.length) return [];
  const out = runText("ps", ["-p", pids.join(","), "-o", "pid=", "-o", "command="]);
  return out
    .split("\n")
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+([\s\S]*)$/);
      if (!match) return null;
      const args = match[2];
      const command = args.trim().split(/\s+/)[0] || args;
      return { pid: match[1], command, args };
    })
    .filter((row): row is ProtectedProcess => Boolean(row));
}

function llmProcessInfo(): LlmProcessInfo | null {
  const port = configuredLlmPort();
  if (!port) return null;
  const processes = processRows(listeningPids(port));
  if (!processes.length) return null;
  return {
    port,
    modelName: basename(config.model || "").toLowerCase(),
    processes,
  };
}

function processNames(info: LlmProcessInfo): string[] {
  const names = new Set<string>();
  for (const proc of info.processes) {
    names.add(basename(proc.command).toLowerCase());
    const firstArg = proc.args.trim().split(/\s+/)[0];
    if (firstArg) names.add(basename(firstArg).toLowerCase());
  }
  if (info.modelName) names.add(info.modelName);
  return [...names].filter(Boolean);
}

function pidIsTargeted(command: string, info: LlmProcessInfo): boolean {
  if (!/\bkill\b/i.test(command)) return false;
  return info.processes.some((proc) => new RegExp(`(^|[^\\d])${proc.pid}([^\\d]|$)`).test(command));
}

function portKillPipeline(command: string, info: LlmProcessInfo): boolean {
  const mentionsPort =
    new RegExp(`\\b${info.port}\\b`).test(command) &&
    (/\blsof\b|\bfuser\b|\bnetstat\b|\bss\b/i.test(command) || /TCP:|:/i.test(command));
  if (!mentionsPort) return false;
  return /\b(kill|pkill|killall)\b/i.test(command) || /\bfuser\b[\s\S]*\s-k\b/i.test(command);
}

function processNameIsTargeted(command: string, info: LlmProcessInfo): boolean {
  if (!/\b(pkill|killall|launchctl\s+(?:stop|kill|remove|bootout)|brew\s+services\s+(?:stop|restart)|ollama\s+(?:stop|serve))\b/i.test(command)) {
    return false;
  }
  const lower = command.toLowerCase();
  return processNames(info).some((name) => name.length >= 3 && lower.includes(name));
}

export function protectedProcessBlockReason(command: string): string | null {
  const info = llmProcessInfo();
  if (!info) return null;
  if (!pidIsTargeted(command, info) && !portKillPipeline(command, info) && !processNameIsTargeted(command, info)) {
    return null;
  }
  const proc = info.processes.map((p) => `${p.command} pid ${p.pid}`).join(", ");
  return `RESTRICTED: this command targets the protected LLM server process (${proc}) listening on SOPHIE_BASE_URL port ${info.port}. Sophie may never kill, stop, restart, or signal the process that is running her LLM.`;
}
