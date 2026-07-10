import { notifyUser, summarizeDelivery, type NotifyChannel } from "../channels/notify.ts";
import { awaitTelegramReply, telegramReady } from "../channels/telegram.ts";
import type { Tool } from "./types.ts";

const CHANNELS: NotifyChannel[] = ["desktop", "telegram"];

/**
 * Proactively reach the user — a desktop notification or a Telegram message to
 * their phone. This is how Sophie tells the user something
 * or asks for a decision when they aren't watching the terminal. With
 * expect_reply she sends over Telegram and waits for the user's answer.
 */
export const notify: Tool = {
  name: "notify",
  description:
    "Reach the user directly — pop a desktop notification or message their phone " +
    "over Telegram. Use to tell the user something important, " +
    "report that a long task finished, or (with expect_reply) ask a question or " +
    "get approval when they're away from the terminal. Prefer this over sitting " +
    "silent when you need the user and they may not be watching. Set expect_reply " +
    "to wait for their Telegram answer and continue with it.",
  parameters: {
    type: "object",
    properties: {
      message: { type: "string", description: "What to tell the user. One or two clear sentences." },
      title: { type: "string", description: "Optional short title (default 'Sophie')." },
      channels: {
        type: "array",
        description: "Which channels to use: desktop, telegram. Default desktop+telegram. Use the speak tool for audible speech.",
        items: { type: "string", enum: CHANNELS },
      },
      urgent: { type: "boolean", description: "Mark as attention-worthy (sound)." },
      expect_reply: {
        type: "boolean",
        description: "Send over Telegram and wait for the user's reply, returning it. Use to ask/approve remotely.",
      },
      reply_timeout_minutes: { type: "number", description: "How long to wait for a reply (default 30, max 120)." },
    },
    required: ["message"],
  },
  summarize: (a) => (a.expect_reply ? `ask: ${String(a.message ?? "").slice(0, 40)}` : `tell: ${String(a.message ?? "").slice(0, 40)}`),
  risk: () => "safe",
  async execute(args, ctx) {
    const message = String(args.message ?? "").trim();
    if (!message) return { content: "notify needs a message.", isError: true };
    const channels = Array.isArray(args.channels)
      ? (args.channels.filter((c) => CHANNELS.includes(c)) as NotifyChannel[])
      : undefined;

    const wantsReply = args.expect_reply === true;
    // For a remote question, make sure Telegram is in the channel set.
    const sendChannels = wantsReply
      ? [...new Set([...(channels ?? ["desktop", "telegram"]), "telegram" as NotifyChannel])]
      : channels;

    const result = await notifyUser(message, {
      title: typeof args.title === "string" ? args.title : undefined,
      channels: sendChannels,
      voice: Array.isArray(channels) ? channels.includes("voice") : undefined,
      urgent: args.urgent === true,
    });

    if (!wantsReply) {
      return { content: `Notification ${summarizeDelivery(result)}.`, display: result.delivered.join("+") || "not sent" };
    }

    if (!telegramReady()) {
      return {
        content:
          `Sent a desktop notification, but can't wait for a reply: Telegram isn't configured ` +
          `(set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID). Ask the user in the terminal instead.`,
        isError: true,
      };
    }

    const minutes = Math.min(Math.max(Number(args.reply_timeout_minutes) || 30, 1), 120);
    const reply = await awaitTelegramReply({ timeoutMs: minutes * 60_000, signal: ctx.signal });
    if (!reply) {
      return {
        content: `No reply from the user within ${minutes} min (${summarizeDelivery(result)}). Proceed cautiously or try again later.`,
        display: "no reply",
      };
    }
    return { content: `User replied via Telegram: "${reply.text}"`, display: "got reply" };
  },
};
