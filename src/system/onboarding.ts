import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { upsertMemory } from "../memory/facts.ts";
import { profileComplete } from "../memory/profile.ts";
import { MEMORY_DIR } from "../memory/store.ts";
import { requiredSetupEnvComplete } from "./env.ts";
import { machineSummary, osLabel } from "./info.ts";

/**
 * Onboarding / first-run state. Sophie shows the setup wizard until the user has
 * completed it once, and on the very first run scans the machine + approximate
 * location and writes them into user memory so she always knows what computer
 * she's running on and roughly where. State lives next to the memory files in
 * ~/.sophie so it survives across working directories.
 */

const SETTINGS_PATH = join(MEMORY_DIR, "settings.json");

interface Settings {
  onboarded?: boolean;
  onboardedAt?: number;
  /** hostname+platform of the machine last onboarded on — lets us notice a move. */
  machineId?: string;
  /** guards the one-time machine/location scan. */
  machineScanned?: boolean;
  /** guards the separately opt-in public-IP location lookup. */
  locationScanned?: boolean;
}

function readSettings(): Settings {
  try {
    if (existsSync(SETTINGS_PATH)) return JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as Settings;
  } catch {
    /* corrupt/unreadable — treat as fresh */
  }
  return {};
}

function writeSettings(patch: Partial<Settings>): void {
  const next = { ...readSettings(), ...patch };
  if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true });
  writeFileSync(SETTINGS_PATH, `${JSON.stringify(next, null, 2)}\n`);
}

/** A stable-ish identifier for this machine (host + platform/arch). */
export function machineId(): string {
  return `${os.hostname()} · ${os.platform()}/${os.arch()}`;
}

export function isOnboarded(): boolean {
  return readSettings().onboarded === true;
}

/**
 * Setup counts as COMPLETE only when the wizard has been saved once, every
 * profile question has an answer, and every required .env field managed by the
 * wizard is filled. Telegram/search stay optional; Gmail setup is required for
 * the public-release assistant workflow. Startup re-opens the wizard until this
 * holds.
 */
export function isSetupComplete(): boolean {
  return isOnboarded() && profileComplete() && requiredSetupEnvComplete();
}

/** Mark setup complete. Called by the wizard when the user saves. */
export function markOnboarded(): void {
  writeSettings({ onboarded: true, onboardedAt: Date.now(), machineId: machineId() });
}

/**
 * One-time scan: record which machine Sophie is running on and (best-effort) the
 * user's approximate city from their public IP, both into user memory as stable,
 * self-updating lines. Idempotent — the guard flag stops it re-running, but the
 * memory lines themselves are upserted so they stay correct if it does.
 */
export async function scanAndRememberMachine(cwd: string): Promise<void> {
  const settings = readSettings();
  if (!settings.machineScanned) {
    writeSettings({ machineScanned: true });
    try {
      upsertMemory("machine", `Sophie is running on ${machineId()} — ${machineSummary()}.`, cwd, {
        scope: "user",
        salience: 0.5,
      });
    } catch {
      /* memory write is best-effort */
    }
  }

  const locationEnabled = /^(1|true|yes|on)$/i.test(process.env.SOPHIE_LOCATION_LOOKUP ?? "");
  if (!locationEnabled || settings.locationScanned) return;
  writeSettings({ locationScanned: true });

  try {
    const res = await fetch(
      "http://ip-api.com/json/?fields=status,country,regionName,city,timezone",
      { signal: AbortSignal.timeout(8000) },
    );
    const d = (await res.json()) as {
      status?: string;
      country?: string;
      regionName?: string;
      city?: string;
      timezone?: string;
    };
    if (d.status === "success") {
      const place = [d.city, d.regionName, d.country].filter(Boolean).join(", ");
      if (place) {
        upsertMemory(
          "location",
          `Location (approx): ${place}${d.timezone ? ` (${d.timezone})` : ""} — from public IP, city-level, may change with VPN.`,
          cwd,
          { scope: "user", salience: 0.5 },
        );
      }
    }
  } catch {
    /* offline or lookup blocked — machine line still saved */
  }
}

/** Short human summary used in the wizard's welcome step. */
export function machineWelcome(): string {
  return `${osLabel()} · ${os.hostname()}`;
}
