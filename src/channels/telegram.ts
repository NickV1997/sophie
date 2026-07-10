/**
 * Telegram bot channel — Sophie's link to the user's phone.
 *
 * Zero-dependency client over the Telegram Bot HTTP API (fetch only). Two jobs:
 *  1. Outbound — `sendTelegram(text)` pushes a message to the user's chat.
 *  2. Inbound  — a single long-polling bridge reads replies and fans them out to
 *     subscribers (the TUI turns them into conversation; tools await one-off
 *     approvals). One bridge, many listeners, so the getUpdates offset is never
 *     fought over.
 *
 * Config (read from process.env, like the web tools):
 *   TELEGRAM_BOT_TOKEN — from @BotFather
 *   TELEGRAM_CHAT_ID   — the chat Sophie is allowed to talk to. If unset, the
 *                        bridge replies to the first message with its chat id so
 *                        the user can authorize it, but starts no conversations.
 */

const API = "https://api.telegram.org";

export function telegramToken(): string {
  return (process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
}

export function telegramChatId(): string {
  return (process.env.TELEGRAM_CHAT_ID ?? "").trim();
}

/** True when a bot token exists — enough to send/poll. Chat id may still be pending. */
export function telegramConfigured(): boolean {
  return telegramToken().length > 0;
}

/** True when Sophie is fully wired to a specific authorized chat. */
export function telegramReady(): boolean {
  return telegramConfigured() && telegramChatId().length > 0;
}

export interface SendResult {
  ok: boolean;
  detail: string;
}

/** Send a message to the user's chat (or an explicit chat id for setup replies). */
export async function sendTelegram(text: string, chatId?: string): Promise<SendResult> {
  const token = telegramToken();
  if (!token) return { ok: false, detail: "TELEGRAM_BOT_TOKEN not set" };
  const chat = (chatId ?? telegramChatId()).trim();
  if (!chat) return { ok: false, detail: "TELEGRAM_CHAT_ID not set" };
  const body = text.trim().slice(0, 4000) || "(empty)";
  try {
    const res = await fetch(`${API}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: body, disable_web_page_preview: true }),
    });
    const data = (await res.json()) as { ok?: boolean; description?: string };
    if (!res.ok || !data.ok) return { ok: false, detail: data.description ?? `HTTP ${res.status}` };
    return { ok: true, detail: `sent to ${chat}` };
  } catch (e: any) {
    return { ok: false, detail: e?.message ?? "network error" };
  }
}

// ── inbound bridge ───────────────────────────────────────────────────────────

export interface InboundMessage {
  chatId: string;
  text: string;
  from: string;
  at: number;
}

/** A listener may claim a message by returning true, stopping further dispatch. */
type Listener = (msg: InboundMessage) => boolean | void;

const listeners: Listener[] = [];
let bridgeRunning = false;
let bridgeStop: (() => void) | null = null;

/**
 * Subscribe to inbound Telegram messages. Listeners are dispatched most-recent
 * first, and any that returns true consumes the message (so a pending approval
 * waiter takes priority over the general conversation handler). Returns an
 * unsubscribe function.
 */
export function subscribeTelegram(listener: Listener): () => void {
  listeners.push(listener);
  return () => {
    const i = listeners.indexOf(listener);
    if (i >= 0) listeners.splice(i, 1);
  };
}

function dispatch(msg: InboundMessage): void {
  for (let i = listeners.length - 1; i >= 0; i--) {
    try {
      if (listeners[i](msg) === true) return;
    } catch {
      /* a listener throwing must not kill the poll loop */
    }
  }
}

/**
 * Start the single long-poll loop. Idempotent — calling twice is a no-op. Safe
 * to call whenever a token exists; if no chat id is configured yet it will reply
 * to the first inbound message with its chat id (setup helper) and drop it.
 */
export function startTelegramBridge(): void {
  if (bridgeRunning || !telegramConfigured()) return;
  bridgeRunning = true;
  const token = telegramToken();
  let offset = 0;
  let stopped = false;

  const loop = async () => {
    while (!stopped) {
      try {
        const res = await fetch(
          `${API}/bot${token}/getUpdates?timeout=25&offset=${offset}&allowed_updates=%5B%22message%22%5D`,
          { signal: AbortSignal.timeout(35_000) },
        );
        const data = (await res.json()) as {
          ok?: boolean;
          result?: Array<{ update_id: number; message?: any }>;
        };
        if (!data.ok || !Array.isArray(data.result)) {
          await sleep(3000);
          continue;
        }
        for (const update of data.result) {
          offset = Math.max(offset, update.update_id + 1);
          const message = update.message;
          const text: string = (message?.text ?? "").trim();
          const chatId = String(message?.chat?.id ?? "");
          if (!text || !chatId) continue;

          const allowed = telegramChatId();
          if (!allowed) {
            // Not yet authorized — help the user find their chat id, don't act.
            await sendTelegram(
              `👋 I'm Sophie. To let us talk, add this to my .env and restart:\nTELEGRAM_CHAT_ID=${chatId}`,
              chatId,
            );
            continue;
          }
          if (chatId !== allowed) continue; // ignore anyone but the owner

          dispatch({
            chatId,
            text,
            from: message?.from?.first_name ?? "user",
            at: Date.now(),
          });
        }
      } catch {
        await sleep(3000); // network blip / timeout — back off and retry
      }
    }
  };

  bridgeStop = () => {
    stopped = true;
    bridgeRunning = false;
  };
  void loop();
}

export function stopTelegramBridge(): void {
  bridgeStop?.();
  bridgeStop = null;
}

/**
 * Setup helper: wait for the user to message their bot (e.g. "hi sophie") and
 * return the chat id of the first message that arrives, so the wizard can wire
 * TELEGRAM_CHAT_ID automatically. Stops the main bridge first (they share the
 * getUpdates offset) and drains any backlog so we only capture a *fresh* hello.
 * Sends a friendly confirmation to that chat. Returns null on timeout/abort.
 */
export async function captureTelegramChatId(
  token: string,
  opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<{ chatId: string; from: string } | null> {
  const tok = token.trim();
  if (!tok) return null;
  stopTelegramBridge();

  const deadline = Date.now() + Math.max(5000, opts.timeoutMs);
  let offset = 0;
  let primed = false; // skip whatever was already queued before the user starts

  while (!opts.signal?.aborted && Date.now() < deadline) {
    try {
      const res = await fetch(
        `${API}/bot${tok}/getUpdates?timeout=20&offset=${offset}&allowed_updates=%5B%22message%22%5D`,
        { signal: AbortSignal.timeout(30_000) },
      );
      const data = (await res.json()) as {
        ok?: boolean;
        result?: Array<{ update_id: number; message?: any }>;
      };
      if (!data.ok || !Array.isArray(data.result)) {
        await sleep(2000);
        continue;
      }
      for (const update of data.result) {
        offset = Math.max(offset, update.update_id + 1);
        if (!primed) continue; // this pass only advances past the backlog
        const message = update.message;
        const text: string = (message?.text ?? "").trim();
        const chatId = String(message?.chat?.id ?? "");
        if (!text || !chatId) continue;
        const from = message?.from?.first_name ?? "there";
        await sendTelegram(
          `✅ Got it, ${from}! Sophie is now linked to this chat. Talk to me here anytime.`,
          chatId,
        );
        return { chatId, from };
      }
      primed = true; // backlog drained; next messages are real hellos
    } catch {
      primed = true;
      await sleep(2000);
    }
  }
  return null;
}

/**
 * Wait for the next inbound message (e.g. a remote approval or answer), with a
 * timeout. Registers a one-shot high-priority listener that consumes the message
 * so it isn't also treated as a new conversation turn. Requires the bridge to be
 * running (starts it if a token exists).
 */
export function awaitTelegramReply(opts: {
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<InboundMessage | null> {
  startTelegramBridge();
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: InboundMessage | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsub();
      opts.signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const unsub = subscribeTelegram((msg) => {
      finish(msg);
      return true; // consume — this reply belongs to the waiter
    });
    const onAbort = () => finish(null);
    const timer = setTimeout(() => finish(null), Math.max(1000, opts.timeoutMs));
    opts.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
