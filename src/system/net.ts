/**
 * fetch() that always has a timeout and also honours an optional external abort
 * signal (the agent's cancel).
 *
 * Every user-facing network tool needs this: without a timeout a hung
 * connection stalls the tool forever whenever no ctx.signal is present
 * (headless, scheduled, and Telegram turns often have none), and even with a
 * signal a bare fetch never times out on its own. The LLM client and channels
 * already use AbortSignal.timeout; this brings the tools up to the same bar.
 */
export interface FetchTimeoutInit extends RequestInit {
  /** External abort signal (e.g. a tool's ctx.signal). Combined with the timeout. */
  signal?: AbortSignal | null;
  /** Overall timeout in ms before the request is aborted (default 30_000). */
  timeoutMs?: number;
}

export async function fetchWithTimeout(url: string, init: FetchTimeoutInit = {}): Promise<Response> {
  const { timeoutMs = 30_000, signal, ...rest } = init;
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    return await fetch(url, { ...rest, signal: combined });
  } catch (e: any) {
    // Turn the raw AbortError into a clear "timed out" message, but only when it
    // was our timeout that fired — a user cancel should stay an AbortError so the
    // agent's cancellation handling still recognises it.
    if (timeout.aborted && !signal?.aborted) {
      throw new Error(`request timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw e;
  }
}
