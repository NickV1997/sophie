/**
 * Presence — is the user at the keyboard, or away?
 *
 * The rule the user asked for: if there has been no user input for a while AND
 * no message has passed either way for that same while, Sophie is "away". While
 * away she stops assuming someone is watching the terminal and instead reaches
 * out over a remote channel (Telegram) to tell things or ask for approval.
 *
 * This is a tiny observable store plus a monitor loop. The TUI feeds it activity
 * (keystrokes, submits) and message events; everything else just reads presence.
 */

export type Presence = "active" | "away";

/** How long with no input AND no conversation before Sophie considers herself away. */
export const DEFAULT_IDLE_MS = 5 * 60 * 1000;

let presence: Presence = "active";
let lastUserInputAt = Date.now();
let lastMessageAt = Date.now();
let idleMs = DEFAULT_IDLE_MS;

type Sub = (p: Presence) => void;
const subs = new Set<Sub>();

function emit(): void {
  for (const s of subs) {
    try {
      s(presence);
    } catch {
      /* a subscriber throwing must not break presence */
    }
  }
}

function set(next: Presence): void {
  if (next === presence) return;
  presence = next;
  emit();
}

export function getPresence(): Presence {
  return presence;
}

export function isAway(): boolean {
  return presence === "away";
}

export function subscribePresence(sub: Sub): () => void {
  subs.add(sub);
  return () => subs.delete(sub);
}

/** The user typed / interacted. Counts as both input and (usually) a message. */
export function noteUserActivity(): void {
  lastUserInputAt = Date.now();
  set("active");
}

/** A message passed either direction (user turn, Sophie reply, remote message). */
export function noteExchange(): void {
  lastMessageAt = Date.now();
}

/** Force presence (e.g. an explicit "I'm away" / "I'm back", or a Telegram ping). */
export function setPresence(next: Presence): void {
  if (next === "active") {
    lastUserInputAt = Date.now();
    lastMessageAt = Date.now();
  }
  set(next);
}

export function setIdleThreshold(ms: number): void {
  if (Number.isFinite(ms) && ms > 0) idleMs = ms;
}

/**
 * Start the monitor. Every `checkMs` it flips to away when BOTH the last input
 * and the last message are older than the idle threshold, and back to active as
 * soon as either is recent. Returns a stop function.
 */
export function startPresenceMonitor(opts: { checkMs?: number; idleMs?: number } = {}): () => void {
  if (opts.idleMs) setIdleThreshold(opts.idleMs);
  const checkMs = opts.checkMs ?? 30_000;
  const timer = setInterval(() => {
    const now = Date.now();
    const quiet = now - lastUserInputAt >= idleMs && now - lastMessageAt >= idleMs;
    set(quiet ? "away" : "active");
  }, checkMs);
  (timer as any).unref?.();
  return () => clearInterval(timer);
}
