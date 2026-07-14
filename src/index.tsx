import { createCliRenderer, type CliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { config, getContextWindow, setContextWindow } from "./config.ts";
import { detectContextWindow, detectLoadedModel, ping } from "./llm/client.ts";
import { connectMcpServers, shutdownMcp } from "./mcp/manager.ts";
import { startNightlyDreamSchedule } from "./memory/dream.ts";
import { stopTelegramBridge } from "./channels/telegram.ts";
import { publishMcpStatus } from "./mcp/status.ts";
import { registerMcpTools } from "./tools/registry.ts";
import { startTtsSidecar, stopTtsSidecar } from "./tts/service.ts";
import { App } from "./tui/App.tsx";

let activeRenderer: CliRenderer | null = null;
let handlersInstalled = false;
let cleanedUp = false;
let stopNightlyDream: (() => void) | null = null;

function cleanupRenderer(): void {
  if (cleanedUp) return;
  cleanedUp = true;
  stopNightlyDream?.();
  stopNightlyDream = null;
  stopTelegramBridge();
  stopTtsSidecar();
  shutdownMcp();
  activeRenderer?.destroy();
  activeRenderer = null;
}

function installExitHandlers(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;

  const exitAfterCleanup = (code: number) => {
    cleanupRenderer();
    process.exit(code);
  };

  process.once("SIGINT", () => exitAfterCleanup(130));
  process.once("SIGTERM", () => exitAfterCleanup(143));
  process.once("SIGHUP", () => exitAfterCleanup(129));
  process.once("exit", cleanupRenderer);
  process.once("uncaughtException", (error) => {
    cleanupRenderer();
    console.error(error);
    process.exit(1);
  });
  process.once("unhandledRejection", (reason) => {
    cleanupRenderer();
    console.error(reason);
    process.exit(1);
  });
}

export async function start(): Promise<void> {
  // Probe the model server before taking over the screen, so connection
  // problems print as plain text instead of inside the TUI.
  const status = await ping();
  if (!status.ok) {
    process.stderr.write(
      `\x1b[31m✗ Sophie can't reach your model.\x1b[0m\n` +
        `  ${status.detail}\n\n` +
        `  • Start your local model server (Ollama / llama.cpp / LM Studio).\n` +
        `  • Check SOPHIE_BASE_URL and SOPHIE_MODEL in your .env.\n` +
        `    base: ${config.baseUrl}\n    model: ${config.model}\n`,
    );
    process.exit(1);
  }

  // Match budgeting to the server's real context size before any turn runs, so
  // we never build a request larger than the server will accept.
  const { nCtx, detail } = await detectContextWindow();
  if (nCtx) setContextWindow(nCtx);
  const loadedModel = await detectLoadedModel();
  const tts = await startTtsSidecar();
  if (!tts.ok) {
    process.stderr.write(
      `\x1b[33m! Sophie TTS did not start.\x1b[0m\n` +
        `  ${tts.detail}\n` +
        `  Voice output will fall back or fail until TTS is repaired.\n\n`,
    );
  }

  const renderer = await createCliRenderer({ useMouse: true });
  activeRenderer = renderer;
  cleanedUp = false;
  installExitHandlers();
  createRoot(renderer).render(<App modelDetail={loadedModel.id} />);

  // While the TUI is open, consolidate memory every night at 3 AM local time.
  stopNightlyDream = startNightlyDreamSchedule(process.cwd());

  if (nCtx && nCtx < config.contextWindow) {
    publishMcpStatus(
      `Context window: ${getContextWindow()} tokens (capped to server n_ctx=${nCtx}; configured ${config.contextWindow}). Compaction adjusted.`,
    );
  } else if (nCtx) {
    publishMcpStatus(`Context window: ${getContextWindow()} tokens (${detail}).`);
  }
  publishMcpStatus(tts.detail);

  // Connect MCP servers in the background so a first-run `npx` download never
  // delays the TUI. Adapted tools register as each server reports them, and
  // appear in the next agent round; status surfaces through the notice channel.
  void connectMcpServers({
    cwd: process.cwd(),
    register: registerMcpTools,
    onStatus: publishMcpStatus,
  });
}
