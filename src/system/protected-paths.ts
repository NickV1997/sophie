import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";

/**
 * Sophie's catastrophe firewall.
 *
 * This is a DETERMINISTIC runtime guard, deliberately independent of the model
 * and of the approval prompt. An uncensored local model will do whatever it is
 * told; a prompt rule is a suggestion it can ignore. So the rule that "you may
 * never destroy the machine, the OS, or the user's credentials" lives here, in
 * code, as a hard wall: `protectedPathBlockReason` returns a non-null reason for
 * any shell command that would delete/move/format something it must never touch,
 * and the bash / run_background tools refuse to spawn it — before approval, and
 * with a "RESTRICTED" message that tells the model to stop, not retry.
 *
 * Two tiers plus a catastrophic-verb list:
 *
 *   NO_TOUCH  — system and credential locations. Blocked if the target is the
 *               path, an ancestor of it, OR anything inside it. Nothing under
 *               /System, ~/Library/Keychains, ~/.ssh, … is ever a legitimate
 *               deletion target.
 *   WHOLESALE — the home directory, the standard home folders, the project root,
 *               and the backup SSD. Blocked if the target IS one of these or an
 *               ancestor (deleting it would take the whole folder). Deleting an
 *               individual file *inside* them stays allowed — that's normal work.
 *   CATASTROPHIC — path-independent, irreversible operations (format a disk,
 *               overwrite a device, delete a keychain, fork bomb, disable SIP …).
 *
 * Real incident this hardens against: a run wiped the entire Desktop and the
 * login keychain. `~/Library/Keychains` was unprotected and `security
 * delete-keychain` was classified "safe" (no `rm`), so it ran with no prompt.
 */

const HOME = homedir();

/** Standard macOS home folders whose wholesale deletion is catastrophic, but
 *  whose individual files Sophie may still manage. */
const DEFAULT_HOME_FOLDERS = [
  "Desktop",
  "Documents",
  "Downloads",
  "Pictures",
  "Movies",
  "Music",
  "Library",
  "Applications",
  ".ssh",
  ".gnupg",
  ".config",
  ".sophie",
  ".codex",
];

const DESKTOP_IMPORTANT = [
  "sophie",
  "local_models_agent",
  "local_models",
  "devtop",
  "launch-sophie",
];

const SSD_ROOT = "/Volumes/OSCOO MD200";
const SSD_IMPORTANT = [
  "sophie",
  "local_models_agent",
  "local_models",
  "devtop",
  "launch-sophie",
];

/** System directories that must never be deleted, moved, or modified — at, above,
 *  or below (the NO_TOUCH tier). Pure OS internals: nothing inside them is ever a
 *  legitimate target. `/`, `/Users`, `/Volumes`, and `/Applications` are handled
 *  by the WHOLESALE tier instead (block the directory itself, allow a specific
 *  child) — `/` here would match every absolute path, and users do legitimately
 *  remove a single app or a file on an external drive. */
const SYSTEM_NO_TOUCH = [
  "/System",
  "/usr",
  "/bin",
  "/sbin",
  "/etc",
  "/Library",
  "/opt",
  "/cores",
  "/Network",
];

/** Credential / secret stores under the home directory. Nothing inside these is
 *  ever a legitimate deletion target, so they are NO_TOUCH (block at/above/below).
 *  This is the tier that would have stopped the keychain wipe. */
const HOME_NO_TOUCH = [
  "Library/Keychains",
  "Library/Application Support/com.apple.TCC",
  ".ssh",
  ".gnupg",
  ".aws",
  ".password-store",
  ".config/gcloud",
  ".docker",
  ".kube",
];

/**
 * Path-independent catastrophic operations. Matched against the whole command,
 * so no target resolution is required. These are blocked even if the model (or
 * the user) would approve them.
 */
const CATASTROPHIC: { re: RegExp; what: string }[] = [
  { re: /\bmkfs(\.\w+)?\b/i, what: "formatting a filesystem (mkfs)" },
  { re: /\bnewfs(_\w+)?\b/i, what: "formatting a filesystem (newfs)" },
  { re: /\bdd\b[^\n|]*\bof=\/dev\//i, what: "writing directly to a disk device (dd of=/dev/…)" },
  {
    re: /\bdiskutil\s+(erase\w*|reformat|partitiondisk|zerodisk|secureerase)/i,
    what: "erasing or repartitioning a disk (diskutil)",
  },
  { re: />\s*\/dev\/(r?disk\d|sd[a-z])/i, what: "overwriting a raw disk device" },
  { re: /--no-preserve-root/i, what: "removing the root filesystem (--no-preserve-root)" },
  { re: /:\s*\(\s*\)\s*\{[^}]*:\s*[|&][^}]*\}\s*;\s*:/, what: "a fork bomb" },
  { re: /\bsecurity\s+delete-keychain\b/i, what: "deleting a macOS keychain (security delete-keychain)" },
  {
    re: /\bsecurity\s+delete-(generic|internet)-password\b/i,
    what: "deleting stored credentials (security delete-…-password)",
  },
  { re: /\bcsrutil\s+disable\b/i, what: "disabling System Integrity Protection (csrutil)" },
  { re: /\bspctl\s+--master-disable\b/i, what: "disabling Gatekeeper (spctl)" },
  { re: /\bnvram\s+-c\b/i, what: "clearing firmware NVRAM" },
  { re: /\bfdesetup\s+(disable|remove)\b/i, what: "changing FileVault disk encryption (fdesetup)" },
];

function uniq(paths: string[]): string[] {
  return [...new Set(paths.map((p) => normalize(p)))];
}

function addIfExists(out: string[], path: string): void {
  if (existsSync(path)) out.push(path);
}

/**
 * The WHOLESALE tier: folders whose deletion (as a whole) is catastrophic but
 * whose individual contents Sophie may still manage. Exported because the bash
 * safety test and the block message enumerate it. Sorted shallow-first so the
 * broadest match is reported.
 */
export function protectedRuntimePaths(cwd: string): string[] {
  const out: string[] = [HOME, "/", "/Users", "/Volumes", "/Applications", resolve(cwd)];
  for (const name of DEFAULT_HOME_FOLDERS) addIfExists(out, join(HOME, name));
  for (const name of DESKTOP_IMPORTANT) addIfExists(out, join(HOME, "Desktop", name));

  if (existsSync(SSD_ROOT)) {
    out.push(SSD_ROOT);
    for (const name of SSD_IMPORTANT) addIfExists(out, join(SSD_ROOT, name));
  }

  return uniq(out).sort((a, b) => a.length - b.length);
}

/** The NO_TOUCH tier: system + credential locations (block at/above/below). */
function noTouchPaths(): string[] {
  const out = [...SYSTEM_NO_TOUCH];
  for (const rel of HOME_NO_TOUCH) out.push(join(HOME, rel));
  return uniq(out).sort((a, b) => a.length - b.length);
}

/** `a` is a strict ancestor directory of `b`. */
function isAncestor(a: string, b: string): boolean {
  const base = a.endsWith("/") ? a : `${a}/`;
  return b.startsWith(base);
}

/** target === p, or removing target would also remove p (target is above p). */
function equalOrAncestor(target: string, p: string): boolean {
  return target === p || isAncestor(target, p);
}

/** target and p are the same, or one contains the other (any overlap). */
function overlaps(target: string, p: string): boolean {
  return target === p || isAncestor(target, p) || isAncestor(p, target);
}

function homeLabel(p: string): string {
  return p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p;
}

/**
 * Classify a single resolved target against both tiers. Returns a block reason
 * (null if the target is safe to delete/move). The WHOLESALE message keeps the
 * legacy "protected runtime path" phrase that callers and tests match on.
 */
function targetBlockReason(target: string, noTouch: string[], wholesale: string[]): string | null {
  // Wholesale first: if the target IS a protected root (or an ancestor of one),
  // report that. Otherwise fall through to the credential/system tier, which
  // also catches files *inside* a no-touch location.
  for (const p of wholesale) {
    if (equalOrAncestor(target, p)) {
      return `"${homeLabel(target)}" would delete or move the protected runtime path "${homeLabel(p)}".`;
    }
  }
  for (const p of noTouch) {
    if (overlaps(target, p)) {
      return `"${homeLabel(target)}" is inside the protected system/credential location "${homeLabel(p)}", which Sophie's safety runtime will never delete, move, or modify.`;
    }
  }
  return null;
}

function expandToken(token: string, cwd: string): string | null {
  let t = token.trim();
  if (!t || t === "--") return null;
  if (/^[|;&(){}<>]+$/.test(t)) return null;
  if (t.startsWith("-")) return null;

  t = t.replace(/^\$HOME(?=\/|$)/, HOME).replace(/^\$\{HOME\}(?=\/|$)/, HOME);
  if (t === "~") t = HOME;
  else if (t.startsWith("~/")) t = join(HOME, t.slice(2));

  if (/[*?[\]{}]/.test(t)) {
    const base = dirname(t);
    const name = basename(t);
    // A whole-directory wildcard (dir/*, dir/.*, dir/{*,.*}) targets the dir.
    if (name === "*" || name === ".*" || name === "{*,.*}") {
      return isAbsolute(base) ? normalize(base) : resolve(cwd, base);
    }
  }

  return isAbsolute(t) ? normalize(t) : resolve(cwd, t);
}

function tokenizeShell(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if ((ch === "'" || ch === '"') && quote === null) {
      quote = ch;
      continue;
    }
    if (ch === quote) {
      quote = null;
      continue;
    }
    if (!quote && /\s/.test(ch)) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    if (!quote && "|;&()".includes(ch)) {
      if (current) tokens.push(current);
      tokens.push(ch);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

function commandName(token: string): string {
  return basename(token);
}

const OPERATORS = new Set(["|", ";", "&", "&&", "||", "(", ")"]);

/** Positional (non-flag) arguments to a command starting at `start`, stopping at
 *  the next shell operator. Honors `--`. */
function targetTokens(tokens: string[], start: number): string[] {
  const out: string[] = [];
  let afterDoubleDash = false;
  for (let i = start + 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (OPERATORS.has(t)) break;
    if (t === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (!afterDoubleDash && t.startsWith("-")) continue;
    out.push(t);
  }
  return out;
}

/** find's search roots: the path args before its first expression flag. */
function findPathTargets(tokens: string[], start: number): string[] {
  const out: string[] = [];
  for (let i = start + 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (OPERATORS.has(t)) break;
    if (t.startsWith("-") || t === "(" || t === "!") break;
    out.push(t);
  }
  return out;
}

/** find clause deletes files or shells out to a mutating command. */
function findIsDestructive(tokens: string[], start: number): boolean {
  for (let i = start + 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (OPERATORS.has(t)) break;
    if (/^-(delete|exec|execdir|ok|okdir)$/i.test(t)) return true;
  }
  return false;
}

/** Any path-like token anywhere in the command — used when a destructive
 *  consumer reads from a pipe (`… | xargs rm`, `… | rm`), where the real targets
 *  come from the producer, not the deleter's own arguments. */
function allPathTargets(tokens: string[]): string[] {
  return tokens.filter((t) => !OPERATORS.has(t));
}

const DELETE_VERBS = new Set(["rm", "rmdir", "unlink", "shred", "srm", "trash", "truncate"]);
const CHMOD_VERBS = new Set(["chmod", "chown", "chgrp", "chflags"]);

/**
 * The single entry point. Returns a "RESTRICTED …" reason string if `command`
 * would destroy a protected path or perform a catastrophic operation, else null.
 * bash and run_background call this before spawning and refuse on non-null.
 */
export function protectedPathBlockReason(command: string, cwd: string): string | null {
  const noTouch = noTouchPaths();
  const wholesale = protectedRuntimePaths(cwd);
  const tokens = tokenizeShell(command);

  // 1. Path-independent catastrophes.
  for (const { re, what } of CATASTROPHIC) {
    if (re.test(command)) {
      return restricted(`This command performs ${what}, an irreversible operation Sophie's safety runtime never allows.`);
    }
  }

  // 2. Does a destructive consumer read from a pipe? Then the deleter's own
  //    arguments are empty/`{}` and the real targets are whatever the producer
  //    enumerates — so scan every path token in the pipeline.
  let pipelineDelete = false;
  for (let i = 0; i < tokens.length; i++) {
    const name = commandName(tokens[i]);
    const prevOp = i > 0 && OPERATORS.has(tokens[i - 1]);
    if (name === "xargs") {
      for (let j = i + 1; j < tokens.length && !OPERATORS.has(tokens[j]); j++) {
        if (DELETE_VERBS.has(commandName(tokens[j]))) pipelineDelete = true;
      }
    }
    // `find … | rm-ish` or `… | rm` with no explicit path arg.
    if (prevOp && DELETE_VERBS.has(name) && targetTokens(tokens, i).length === 0) {
      pipelineDelete = true;
    }
  }
  if (pipelineDelete) {
    const reason = checkTargets(allPathTargets(tokens), cwd, noTouch, wholesale, "piped delete");
    if (reason) return reason;
  }

  // 3. Per-command target scanning.
  for (let i = 0; i < tokens.length; i++) {
    const name = commandName(tokens[i]);

    if (DELETE_VERBS.has(name) || CHMOD_VERBS.has(name)) {
      const reason = checkTargets(targetTokens(tokens, i), cwd, noTouch, wholesale, name);
      if (reason) return reason;
    }

    if (name === "mv") {
      // Sources may leave a protected path; the destination (moving INTO a folder)
      // is fine, so check all but the last positional.
      const targets = targetTokens(tokens, i);
      const sources = targets.length > 1 ? targets.slice(0, -1) : targets;
      const reason = checkTargets(sources, cwd, noTouch, wholesale, "mv source");
      if (reason) return reason;
    }

    if (name === "find" && findIsDestructive(tokens, i)) {
      const reason = checkTargets(findPathTargets(tokens, i), cwd, noTouch, wholesale, "find -delete/-exec");
      if (reason) return reason;
    }

    if (name === "git" && (tokens[i + 1] === "rm" || tokens[i + 1] === "mv")) {
      const targets = targetTokens(tokens, i + 1);
      const sources = tokens[i + 1] === "mv" && targets.length > 1 ? targets.slice(0, -1) : targets;
      const reason = checkTargets(sources, cwd, noTouch, wholesale, `git ${tokens[i + 1]}`);
      if (reason) return reason;
    }
  }

  return null;
}

/**
 * Guard for Sophie's file-writing tools (write_file / edit_file / replace_lines).
 * Returns a block reason if `absPath` is inside the NO_TOUCH tier — OS internals
 * or credential stores — which Sophie may never create, overwrite, or modify
 * (writing garbage into the keychain or an SSH key is as destructive as deleting
 * it). Writing anywhere else — the project, Desktop, Documents — is normal work.
 */
export function protectedWriteBlockReason(absPath: string): string | null {
  const target = normalize(absPath);
  for (const p of noTouchPaths()) {
    if (overlaps(target, p)) {
      return restricted(
        `writing "${homeLabel(target)}" is inside the protected system/credential location "${homeLabel(p)}", which Sophie may never create, overwrite, or modify.`,
      );
    }
  }
  return null;
}

function checkTargets(
  rawTargets: string[],
  cwd: string,
  noTouch: string[],
  wholesale: string[],
  kind: string,
): string | null {
  for (const raw of rawTargets) {
    const target = expandToken(raw, cwd);
    if (!target) continue;
    const reason = targetBlockReason(target, noTouch, wholesale);
    if (reason) return restricted(`${kind}: ${reason}`);
  }
  return null;
}

function restricted(detail: string): string {
  return `RESTRICTED ACTION — ${detail}`;
}
