/**
 * Self-update check — a quiet startup whisper when a newer Sophie exists.
 * Prefers the git remote when the install is a clone; falls back to the npm
 * registry. Fully best-effort: offline, unpublished, or non-git installs all
 * resolve to null and nothing is shown.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import pkg from "../../package.json";
import { REPO_ROOT } from "../config.ts";
import { fetchWithTimeout } from "./net.ts";

function parseVersion(v: string): number[] | null {
  const m = v.trim().replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** True when b is strictly newer than a. */
export function isNewerVersion(a: string, b: string): boolean {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) return false;
  for (let i = 0; i < 3; i++) {
    if (vb[i]! !== va[i]!) return vb[i]! > va[i]!;
  }
  return false;
}

async function gitUpdate(): Promise<string | null> {
  if (!existsSync(join(REPO_ROOT, ".git"))) return null;
  try {
    const fetch = Bun.spawn(["git", "-C", REPO_ROOT, "fetch", "--quiet"], { stdout: "ignore", stderr: "ignore" });
    const timer = setTimeout(() => fetch.kill(), 15_000);
    await fetch.exited;
    clearTimeout(timer);
    const count = Bun.spawn(["git", "-C", REPO_ROOT, "rev-list", "--count", "HEAD..@{upstream}"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = (await new Response(count.stdout).text()).trim();
    if ((await count.exited) !== 0) return null;
    const behind = Number(out);
    if (Number.isInteger(behind) && behind > 0) {
      return `Update available: ${behind} new commit${behind === 1 ? "" : "s"} upstream — git pull in ${REPO_ROOT} to update.`;
    }
    return null;
  } catch {
    return null;
  }
}

async function npmUpdate(): Promise<string | null> {
  try {
    const res = await fetchWithTimeout(`https://registry.npmjs.org/${pkg.name}/latest`, { timeoutMs: 6000 });
    if (!res.ok) return null;
    const json: any = await res.json();
    const latest = typeof json?.version === "string" ? json.version : "";
    if (latest && isNewerVersion(pkg.version, latest)) {
      return `Update available: v${pkg.version} → v${latest} (npm i -g ${pkg.name}).`;
    }
    return null;
  } catch {
    return null;
  }
}

/** One-line update notice, or null when current/unknown. Never throws. */
export async function checkForUpdate(): Promise<string | null> {
  return (await gitUpdate()) ?? (await npmUpdate());
}
