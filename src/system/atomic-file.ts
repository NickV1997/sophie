import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export type AtomicWriteStage = "after_fsync_temp" | "after_backup" | "after_rename";
let faultInjector: ((stage: AtomicWriteStage, path: string) => void) | undefined;
/** Test-only crash injection point. Production has no injector installed. */
export function setAtomicWriteFaultInjector(injector?: (stage: AtomicWriteStage, path: string) => void): void { faultInjector = injector; }

/** Write private Sophie state without exposing a partially-written JSON file. */
export function writePrivateFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    const fd = openSync(tmp, "wx", 0o600);
    try { writeSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
    faultInjector?.("after_fsync_temp", path);
    if (existsSync(path)) copyFileSync(path, `${path}.bak`);
    faultInjector?.("after_backup", path);
    renameSync(tmp, path);
    faultInjector?.("after_rename", path);
    chmodSync(path, 0o600);
    const dirFd = openSync(dirname(path), "r");
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } catch (error) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best effort */ }
    throw error;
  }
}

/** Parse JSON, restoring the last atomic backup when possible and quarantining
 * corrupt state instead of silently pretending the user's data was empty. */
export function readJsonWithRecovery<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch {
    const backup = `${path}.bak`;
    if (existsSync(backup)) {
      try {
        const recovered = JSON.parse(readFileSync(backup, "utf8")) as T;
        renameSync(path, `${path}.corrupt-${Date.now()}`);
        copyFileSync(backup, path);
        chmodSync(path, 0o600);
        return recovered;
      } catch { /* quarantine below */ }
    }
    try { renameSync(path, `${path}.corrupt-${Date.now()}`); } catch { /* best effort */ }
    return null;
  }
}
