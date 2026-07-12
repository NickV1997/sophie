import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config, REPO_ROOT } from "../config.ts";

let ttsProc: ReturnType<typeof Bun.spawn> | null = null;

function falsey(value: string | undefined): boolean {
  return /^(0|false|off|no)$/i.test(String(value ?? ""));
}

function ttsPort(): number {
  try {
    return Number(new URL(config.ttsBaseUrl).port || 8090);
  } catch {
    return 8090;
  }
}

function ttsHost(): string {
  try {
    const host = new URL(config.ttsBaseUrl).hostname;
    return host || "127.0.0.1";
  } catch {
    return "127.0.0.1";
  }
}

function modelDir(): string {
  return process.env.SOPHIE_MODEL_DIR || join(homedir(), ".local/share/sophie/models");
}

function pythonPath(): string {
  return process.env.SOPHIE_TTS_PYTHON || join(REPO_ROOT, ".tts-venv/bin/python");
}

function serverPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "server.py");
}

async function ttsAlreadyHealthy(): Promise<boolean> {
  try {
    const response = await fetch(`${config.ttsBaseUrl}/health`, { signal: AbortSignal.timeout(500) });
    return response.ok;
  } catch {
    return false;
  }
}

export function ttsStatus(): {
  enabled: boolean;
  running: boolean;
  detail: string;
  python: string;
  model: string;
  voices: string;
} {
  const dir = modelDir();
  const python = pythonPath();
  const model = process.env.SOPHIE_TTS_MODEL || join(dir, "tts/kokoro-v1.0.onnx");
  const voices = process.env.SOPHIE_TTS_VOICES || join(dir, "tts/voices-v1.0.bin");
  const enabled = config.ttsBackend === "sidecar" && config.ttsAutostart;
  return {
    enabled,
    running: !!ttsProc && !ttsProc.killed,
    detail: enabled ? `${config.ttsBaseUrl} (${process.env.SOPHIE_TTS_SPEAKER || config.speakVoice || "bf_emma"})` : "disabled",
    python,
    model,
    voices,
  };
}

export async function startTtsSidecar(): Promise<{ ok: boolean; detail: string }> {
  if (config.ttsBackend !== "sidecar") return { ok: true, detail: "TTS sidecar disabled by SOPHIE_TTS_BACKEND" };
  if (!config.ttsAutostart || falsey(process.env.SOPHIE_TTS_AUTOSTART)) return { ok: true, detail: "TTS autostart disabled by SOPHIE_TTS_AUTOSTART" };
  if (ttsProc && !ttsProc.killed) return { ok: true, detail: `TTS already started at ${config.ttsBaseUrl}` };
  if (await ttsAlreadyHealthy()) return { ok: true, detail: `TTS already listening at ${config.ttsBaseUrl}` };

  const status = ttsStatus();
  if (!existsSync(serverPath())) return { ok: false, detail: `missing Sophie TTS server: ${serverPath()}` };
  if (!existsSync(status.python)) return { ok: false, detail: `missing Sophie TTS Python: ${status.python}. Run ./install.sh from the Sophie repo.` };
  if (!existsSync(status.model)) return { ok: false, detail: `missing Kokoro model: ${status.model}` };
  if (!existsSync(status.voices)) return { ok: false, detail: `missing Kokoro voices: ${status.voices}` };

  ttsProc = Bun.spawn([status.python, serverPath()], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      SOPHIE_MODEL_DIR: modelDir(),
      SOPHIE_TTS_HOST: process.env.SOPHIE_TTS_HOST || ttsHost(),
      SOPHIE_TTS_PORT: process.env.SOPHIE_TTS_PORT || String(ttsPort()),
      SOPHIE_TTS_MODEL: status.model,
      SOPHIE_TTS_VOICES: status.voices,
      SOPHIE_TTS_SPEAKER: process.env.SOPHIE_TTS_SPEAKER || config.speakVoice || "bf_emma",
    },
  });

  void ttsProc.exited.then((code) => {
    if (code !== 0 && ttsProc) {
      console.error(`Sophie TTS sidecar exited with code ${code}`);
    }
    ttsProc = null;
  });

  return { ok: true, detail: `started Sophie TTS sidecar at ${config.ttsBaseUrl}` };
}

export function stopTtsSidecar(): void {
  if (ttsProc && !ttsProc.killed) ttsProc.kill("SIGTERM");
  ttsProc = null;
}
