#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

interface Finding {
  file: string;
  line?: number;
  rule: string;
}

const git = (args: string[]) => spawnSync("git", args, { encoding: "utf8" });
const listed = git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
if (listed.status !== 0) {
  console.error("audit:public must run inside a Git working tree");
  process.exit(2);
}

const files = listed.stdout.split("\0").filter(Boolean);
const findings: Finding[] = [];

const forbiddenPaths: Array<[RegExp, string]> = [
  [/(^|\/)\.env(?:\.|$)/, "environment file (only .env.example is publishable)"],
  [/(^|\/)\.sophie(?:\/|$)/, "Sophie memory/runtime state"],
  [/^SOPHIE\.md$/, "repository-root Sophie project memory"],
  [/(^|\/)\.claude\/settings\.local\.json$/, "local agent settings"],
  [/(^|\/)(?:node_modules|\.tts-venv|bench-results)(?:\/|$)/, "generated local artifact"],
  [/\.(?:pem|key|p12|pfx)$/i, "private key or certificate bundle"],
  [/(^|\/)(?:credentials|secrets)[^/]*\.json$/i, "credential file"],
];

const contentRules: Array<[RegExp, string]> = [
  [/-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/, "private key material"],
  [/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/, "GitHub token"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/, "GitHub fine-grained token"],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/, "OpenAI-style API key"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, "Slack token"],
  [/\bAKIA[0-9A-Z]{16}\b|\bASIA[0-9A-Z]{16}\b/, "AWS access key"],
  [/\btvly-[A-Za-z0-9_-]{16,}\b/, "Tavily API key"],
  [/\b[0-9]{8,10}:[A-Za-z0-9_-]{30,}\b/, "Telegram bot token"],
  [/https?:\/\/[^/\s:@]+:[^/@\s]+@/i, "credential embedded in URL"],
  [/\/(?:Users|home)\/[^/\s"'`]+/i, "machine-specific home path"],
];

for (const file of files) {
  if (file === ".env.example") {
    // The blank public template is the sole allowed dotenv file.
  } else {
    for (const [pattern, rule] of forbiddenPaths) {
      if (pattern.test(file)) findings.push({ file, rule });
    }
  }

  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch {
    findings.push({ file, rule: "unreadable publication candidate" });
    continue;
  }
  if (bytes.includes(0)) continue;
  const lines = bytes.toString("utf8").split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    for (const [pattern, rule] of contentRules) {
      if (pattern.test(line)) findings.push({ file, line: index + 1, rule });
    }

    const assignment = line.match(
      /^\s*([A-Z][A-Z0-9_]*(?:API_KEY|ACCESS_KEY|SECRET_KEY|TOKEN|PASSWORD|PASSWD|SECRET|CREDENTIAL))\s*=\s*([^#\s].*)$/,
    );
    if (assignment) {
      const value = assignment[2]!.trim().replace(/^(["'])(.*)\1$/, "$2");
      const safeExample = value === "local" || /^(?:test|example|placeholder|change[-_]?me)(?:[-_].*)?$/i.test(value);
      if (value && !safeExample) findings.push({ file, line: index + 1, rule: "non-empty secret-like assignment" });
    }
  }
}

const identities = git(["log", "--all", "--format=%ae%n%ce"]);
if (identities.status === 0) {
  for (const email of identities.stdout.split(/\r?\n/).filter(Boolean)) {
    if (/@(?:localhost|[^@]*\.local)$/i.test(email)) {
      findings.push({ file: ".git history", rule: "machine-local author or committer email" });
      break;
    }
  }
}

if (findings.length) {
  console.error(`Public-release audit failed with ${findings.length} finding(s):`);
  for (const finding of findings) {
    const at = finding.line ? `${finding.file}:${finding.line}` : finding.file;
    console.error(`- ${at}: ${finding.rule}`);
  }
  console.error("No matching secret values are printed. Remove or replace each finding before publishing.");
  process.exit(1);
}

console.log(`Public-release audit passed (${files.length} tracked/unignored files).`);
