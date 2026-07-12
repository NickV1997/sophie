import { existsSync, mkdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "../config.ts";
import { writePrivateFileAtomic } from "../system/atomic-file.ts";

export const DAEMON_LABEL = "com.sophie.agent";
export const PLIST_PATH = join(homedir(), "Library", "LaunchAgents", `${DAEMON_LABEL}.plist`);

function xml(s: string): string { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

export function installLaunchAgent(): string {
  if (platform() !== "darwin") throw new Error("The supervised background service currently uses macOS launchd.");
  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  const bun = process.execPath;
  const cli = join(REPO_ROOT, "bin", "sophie.ts");
  const log = join(homedir(), ".sophie", "daemon", "daemon.log");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${DAEMON_LABEL}</string>\n<key>ProgramArguments</key><array><string>${xml(bun)}</string><string>${xml(cli)}</string><string>daemon</string><string>run</string></array>\n<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>\n<key>StandardOutPath</key><string>${xml(log)}</string><key>StandardErrorPath</key><string>${xml(log)}</string>\n</dict></plist>\n`;
  writePrivateFileAtomic(PLIST_PATH, plist);
  return PLIST_PATH;
}

export function launchAgentInstalled(): boolean { return existsSync(PLIST_PATH); }
