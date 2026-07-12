import { platform } from "node:os";

const SERVICE = "com.sophie.agent";
const SECRET_KEYS = new Set(["SOPHIE_API_KEY", "SOPHIE_EMAIL_APP_PASSWORD", "TELEGRAM_BOT_TOKEN", "TAVILY_API_KEY", "BRAVE_API_KEY"]);

export function getSecret(key: string): string {
  const env = (process.env[key] ?? "").trim();
  if (env) return env;
  if (platform() !== "darwin" || !SECRET_KEYS.has(key)) return "";
  const p = Bun.spawnSync(["security", "find-generic-password", "-s", SERVICE, "-a", key, "-w"], { stdout: "pipe", stderr: "ignore" });
  return p.exitCode === 0 ? p.stdout.toString().trim() : "";
}

export function setSecret(key: string, value: string): boolean {
  if (platform() !== "darwin" || !SECRET_KEYS.has(key)) return false;
  const args = value
    ? ["security", "add-generic-password", "-U", "-s", SERVICE, "-a", key, "-w", value]
    : ["security", "delete-generic-password", "-s", SERVICE, "-a", key];
  return Bun.spawnSync(args, { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
}

export function migrateEnvSecretsToKeychain(clearEnv = false): string[] {
  if (platform() !== "darwin") return [];
  const migrated: string[] = [];
  for (const key of SECRET_KEYS) {
    const value = (process.env[key] ?? "").trim();
    if (value && setSecret(key, value)) { migrated.push(key); if (clearEnv) process.env[key] = ""; }
  }
  return migrated;
}
