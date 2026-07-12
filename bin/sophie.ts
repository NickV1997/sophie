#!/usr/bin/env bun

const args = process.argv.slice(2);

function printHelp(): void {
  process.stdout.write(`Sophie - local-first terminal AI assistant

Usage:
  sophie              Start the Sophie TUI
  sophie webapp       Start the Sophie web app (phone-friendly, Tailscale-ready)
  sophie webapp stop  Stop the Sophie web app
  sophie doctor       Check install, .env, and model server reachability
  sophie daemon install|start|stop|status
  sophie secrets migrate   Copy configured secrets into macOS Keychain
  sophie --help       Show this help
  sophie --version    Show the installed version

Setup:
  1. ./install.sh
  2. Edit .env and set SOPHIE_BASE_URL / SOPHIE_MODEL
  3. sophie
`);
}

async function printVersion(): Promise<void> {
  const pkg = await Bun.file(new URL("../package.json", import.meta.url)).json();
  process.stdout.write(`${pkg.version}\n`);
}

async function doctor(): Promise<void> {
  const { existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { config, REPO_ROOT } = await import("../src/config.ts");
  const { ping } = await import("../src/llm/client.ts");
  const { telegramConfigured, telegramReady } = await import("../src/channels/telegram.ts");
  const { ttsStatus } = await import("../src/tts/service.ts");

  const envPath = join(REPO_ROOT, ".env");
  let ok = true;

  process.stdout.write("Sophie doctor\n\n");
  process.stdout.write(`bun: ${Bun.version}\n`);

  if (existsSync(envPath)) {
    process.stdout.write(`.env: ${envPath}\n`);
  } else {
    ok = false;
    process.stdout.write(`.env: missing at ${envPath}\n`);
  }

  process.stdout.write(`base URL: ${config.baseUrl}\n`);
  process.stdout.write(`model: ${config.model}\n`);
  const tts = ttsStatus();
  process.stdout.write(`tts: ${tts.detail}\n`);
  if (tts.enabled) {
    if (!existsSync(tts.python)) {
      ok = false;
      process.stdout.write(`tts python: missing at ${tts.python}\n`);
    } else {
      process.stdout.write(`tts python: ${tts.python}\n`);
    }
    if (!existsSync(tts.model)) {
      ok = false;
      process.stdout.write(`tts model: missing at ${tts.model}\n`);
    } else {
      process.stdout.write(`tts model: ${tts.model}\n`);
    }
    if (!existsSync(tts.voices)) {
      ok = false;
      process.stdout.write(`tts voices: missing at ${tts.voices}\n`);
    } else {
      process.stdout.write(`tts voices: ${tts.voices}\n`);
    }
  }
  process.stdout.write(
    `telegram: ${
      telegramReady()
        ? "ready"
        : telegramConfigured()
          ? "bot token set, TELEGRAM_CHAT_ID missing"
          : "not configured"
    }\n`,
  );

  const status = await ping();
  if (status.ok) {
    process.stdout.write(`model server: ${status.detail}\n`);
  } else {
    ok = false;
    process.stdout.write(`model server: ${status.detail}\n`);
  }

  process.exit(ok ? 0 : 1);
}

if (args.includes("--help") || args.includes("-h")) {
  printHelp();
  process.exit(0);
}

if (args.includes("--version") || args.includes("-v")) {
  await printVersion();
  process.exit(0);
}

if (args[0] === "doctor") {
  await doctor();
}

if (args[0] === "daemon") {
  const action = args[1] ?? "status";
  const { runDaemon, readDaemonStatus } = await import("../src/daemon/service.ts");
  const { DAEMON_LABEL, PLIST_PATH, installLaunchAgent } = await import("../src/daemon/launchd.ts");
  if (action === "run") await runDaemon();
  if (action === "install") { const path = installLaunchAgent(); process.stdout.write(`Installed ${path}\nRun: sophie daemon start\n`); process.exit(0); }
  if (action === "start") { const p = Bun.spawnSync(["launchctl", "bootstrap", `gui/${process.getuid?.() ?? 0}`, PLIST_PATH]); process.stdout.write(p.stderr.toString() || "Sophie daemon started.\n"); process.exit(p.exitCode); }
  if (action === "stop") { const p = Bun.spawnSync(["launchctl", "bootout", `gui/${process.getuid?.() ?? 0}/${DAEMON_LABEL}`]); process.stdout.write(p.stderr.toString() || "Sophie daemon stopped.\n"); process.exit(p.exitCode); }
  const s = readDaemonStatus(); process.stdout.write(s ? `Sophie daemon: ${s.state}, pid ${s.pid}, heartbeat ${new Date(s.heartbeatAt).toLocaleString()}\n` : "Sophie daemon: offline\n"); process.exit(s?.state === "online" && Date.now() - s.heartbeatAt < 45_000 ? 0 : 1);
}

if (args[0] === "secrets" && args[1] === "migrate") {
  const { migrateEnvSecretsToKeychain } = await import("../src/system/secrets.ts");
  const keys = migrateEnvSecretsToKeychain(false);
  process.stdout.write(keys.length ? `Stored in macOS Keychain: ${keys.join(", ")}\nYou may now blank those values in .env.\n` : "No configured secrets were migrated.\n");
  process.exit(keys.length ? 0 : 1);
}

if (args[0] === "webapp") {
  const { startWebAppServer, stopWebAppServer } = await import("../src/webapp/server.ts");
  const { startTtsSidecar, stopTtsSidecar } = await import("../src/tts/service.ts");
  if (args[1] === "stop" || args[1] === "kill") {
    const result = await stopWebAppServer();
    process.stdout.write(`${result.detail}\n`);
    process.exit(result.stopped ? 0 : 1);
  }

  const tts = await startTtsSidecar();
  if (!tts.ok) process.stderr.write(`Sophie TTS did not start: ${tts.detail}\n`);

  const noOpen = args.includes("--no-open");
  const portArg = valueArg(args, "--port");
  const hostArg = valueArg(args, "--host");
  const result = await startWebAppServer({
    cwd: process.cwd(),
    open: !noOpen,
    foreground: true,
    ...(hostArg ? { host: hostArg } : {}),
    ...(portArg ? { port: Number(portArg) } : {}),
  });
  process.stdout.write(`${result.detail}\nPress Ctrl+C to stop it.\n`);

  const stopAndExit = async (code: number) => {
    stopTtsSidecar();
    await stopWebAppServer();
    process.exit(code);
  };
  process.once("SIGINT", () => void stopAndExit(130));
  process.once("SIGTERM", () => void stopAndExit(143));
  await new Promise(() => {});
}

const { start } = await import("../src/index.tsx");

start().catch((err) => {
  // Restore terminal state on a hard failure before printing.
  process.stderr.write(`\n\x1b[31mSophie crashed:\x1b[0m ${err?.stack ?? err}\n`);
  process.exit(1);
});

function valueArg(args: string[], name: string): string | null {
  const eq = args.find((arg) => arg.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const index = args.indexOf(name);
  if (index !== -1 && args[index + 1]) return args[index + 1];
  return null;
}
