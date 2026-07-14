import { useKeyboard } from "@opentui/react";
import type { ScrollBoxRenderable } from "@opentui/core";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import pkg from "../../package.json";
import { listEpisodes, loadEpisode } from "../agent/episodes.ts";
import { Agent, type ToolCallEvent } from "../agent/agent.ts";
import { getMode, setMode as setModeStore, subscribeMode } from "../agent/mode.ts";
import {
  getCurrentJob,
  getObjective,
  getJournal,
  getTasks,
  restoreCurrentJob,
  restoreJournal,
  restoreTasks,
  setObjective,
  subscribeTasks,
  type Task,
} from "../agent/tasks.ts";
import {
  latestSession,
  listSessions,
  newSessionId,
  saveSession,
  setCurrentSessionId,
  titleFrom,
} from "../agent/session.ts";
import { type Mode } from "../config.ts";
import type { FileDiff } from "../tools/diff.ts";
import {
  DEFAULT_IDLE_MS,
  isAway,
  noteExchange,
  noteUserActivity,
  type Presence,
  getPresence,
  startPresenceMonitor,
  subscribePresence,
} from "../agent/presence.ts";
import {
  awaitTelegramReply,
  sendTelegram,
  startTelegramBridge,
  subscribeTelegram,
  telegramConfigured,
  telegramReady,
} from "../channels/telegram.ts";
import { completeAppleReminder } from "../channels/apple_reminders.ts";
import { notifyUser } from "../channels/notify.ts";
import { StreamingSpeech } from "../channels/streaming_speech.ts";
import { startScheduler, type ScheduleItem } from "../agent/scheduler.ts";
import { reconcileCalendarReminders } from "../calendar/store.ts";
import { calendarSyncStatus, syncUpcomingCalendarEvents } from "../calendar/sync.ts";
import { startWatchers } from "../agent/watcher.ts";
import {
  contextFraction,
  getTurnStats,
  subscribeTurnStats,
  tokensPerSecond,
  type TurnStats,
} from "../agent/stats.ts";
import { subscribeMcpStatus } from "../mcp/status.ts";
import { runDoctor } from "../system/doctor.ts";
import { undoLast } from "../system/undo.ts";
import { checkForUpdate } from "../system/update.ts";
import { readDaemonStatus } from "../daemon/service.ts";
import { listWork } from "../daemon/queue.ts";
import { memoryPath, type MemoryScope, readMemoryFile, writeMemoryFile } from "../memory/store.ts";
import { displayPath } from "../system/paths.ts";
import { isSetupComplete, scanAndRememberMachine } from "../system/onboarding.ts";
import { SetupWizard } from "./SetupWizard.tsx";
import {
  LOGO,
  PROMPT_BORDER,
  SPINNER,
  theme,
  WORKING_PHRASES,
} from "./theme.ts";
import { formatWorkingElapsed } from "./time.ts";

type Block =
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "assistant"; text: string }
  | { id: string; kind: "thinking"; text: string }
  | { id: string; kind: "system"; text: string }
  | { id: string; kind: "error"; text: string }
  | {
      id: string;
      kind: "tool";
      name: string;
      summary: string;
      risk: ToolCallEvent["risk"];
      status: "running" | "done" | "error" | "denied" | "awaiting" | "cancelled";
      result?: string;
      diff?: FileDiff;
    };

interface PendingApproval {
  call: ToolCallEvent;
  resolve: (d: "approve" | "deny") => void;
}

/** Where a turn came from — local terminal, a Telegram message, or a fired schedule.
 *  Remote/scheduled turns mirror Sophie's reply back over Telegram. */
type RunOpts = { source: "user" | "telegram" | "schedule" | "watcher"; mirror?: boolean };

interface SlashCommand {
  name: string;
  description: string;
}

const COMMANDS: SlashCommand[] = [
  { name: "audio", description: "Toggle Audio mode — Sophie speaks every reply aloud via Kokoro TTS" },
  { name: "plan", description: "Switch to Plan mode (thinking on, read-only)" },
  { name: "normal", description: "Switch to Normal mode (fast, can act)" },
  { name: "build", description: "Switch to Build mode (plan in phases, then build the MVP, auto-exits when done)" },
  { name: "continue", description: "Continue the current saved task list" },
  { name: "new", description: "Start a fresh conversation" },
  { name: "clear", description: "Start a fresh conversation (same as /new)" },
  { name: "resume", description: "Resume your most recent saved session" },
  { name: "jobs", description: "List saved Sophie jobs/episodes" },
  { name: "resume-job", description: "Resume a saved job by id" },
  { name: "sessions", description: "List saved sessions" },
  { name: "webapp", description: "Start Sophie's web app on 0.0.0.0:3737 (use '/webapp stop' to stop it)" },
  { name: "memory", description: "View & edit Sophie's memory (add 'project' for project memory)" },
  { name: "undo", description: "Revert the file edits from the last turn (Sophie's file tools only)" },
  { name: "doctor", description: "Health-check the model, speech, Telegram, MCP, browser, and stores" },
  { name: "setup", description: "Open the setup wizard (model, speech, Telegram, keys)" },
  { name: "commands", description: "Open the full command reference" },
  { name: "help", description: "Open the full command reference" },
  { name: "exit", description: "Quit Sophie" },
];

interface MemoryEdit {
  scope: MemoryScope;
  path: string;
  initial: string;
}

interface CommandReferenceEntry {
  command: string;
  summary: string;
  details: string;
}

const COMMAND_REFERENCE: CommandReferenceEntry[] = [
  {
    command: "/audio",
    summary: "Toggle Audio mode on/off.",
    details: "When on, Sophie streams every reply through the Kokoro TTS voice (bf_emma) as she types it. Toggle again to go silent. The speak tool always works regardless of this setting.",
  },
  {
    command: "/plan",
    summary: "Switch to Plan mode.",
    details: "Sophie thinks through the request and gathers read-only context, but does not edit files or run mutating commands.",
  },
  {
    command: "/normal",
    summary: "Switch to Normal mode.",
    details: "Sophie can answer, inspect, edit, and run tools as needed for ordinary work.",
  },
  {
    command: "/build",
    summary: "Switch to Build mode.",
    details: "For coding tasks: Sophie plans in phases, executes the MVP step by step, verifies it, then exits Build mode when done.",
  },
  {
    command: "/continue",
    summary: "Resume the current task list.",
    details: "Uses the live task ledger and journal to keep working from the next open item. Good after a long task pauses.",
  },
  {
    command: "/new",
    summary: "Start a fresh conversation.",
    details: "Clears the active model history and task list, creates a new session id, and leaves old saved sessions untouched.",
  },
  {
    command: "/clear",
    summary: "Same as /new.",
    details: "Kept as the older alias for starting fresh.",
  },
  {
    command: "/resume",
    summary: "Resume the newest saved session.",
    details: "Restores transcript, model history, mode, tasks, job state, and journal from the latest saved session.",
  },
  {
    command: "/sessions",
    summary: "List saved sessions.",
    details: "Shows recent saved conversations. /resume opens the newest one.",
  },
  {
    command: "/jobs",
    summary: "List saved jobs.",
    details: "Shows durable job snapshots with open task counts. Use /resume-job with an id to continue one.",
  },
  {
    command: "/resume-job <id>",
    summary: "Resume a saved job by id.",
    details: "Restores that job's objective, task list, and journal, then waits for /continue or your next instruction.",
  },
  {
    command: "/webapp",
    summary: "Start Sophie's phone-friendly web chat.",
    details: "Opens the local web app on 0.0.0.0 so another device can reach it over LAN or Tailscale.",
  },
  {
    command: "/webapp stop",
    summary: "Stop the web chat server.",
    details: "Stops the running Sophie web app when it was started from this process or an owned foreground process.",
  },
  {
    command: "/memory",
    summary: "Edit user memory.",
    details: "Opens Sophie's user-level SOPHIE.md memory file. Ctrl+S saves; Esc cancels.",
  },
  {
    command: "/memory project",
    summary: "Edit project memory.",
    details: "Opens the SOPHIE.md memory file for the current project directory.",
  },
  {
    command: "/undo",
    summary: "Undo the last Sophie file edit.",
    details: "Reverts edits made through Sophie's file tools using the local undo journal and backups.",
  },
  {
    command: "/doctor",
    summary: "Run health checks.",
    details: "Checks model connectivity, speech, Telegram, MCP, browser support, stores, and other setup details.",
  },
  {
    command: "/setup",
    summary: "Open the setup wizard.",
    details: "Review or change model, speech, Telegram, search, and advanced configuration values.",
  },
  {
    command: "/commands",
    summary: "Open this command reference.",
    details: "A full-screen reference page. Press Esc to close it and return to the conversation.",
  },
  {
    command: "/help",
    summary: "Alias for /commands.",
    details: "Opens this same reference page instead of adding a short help line to the transcript.",
  },
  {
    command: "/exit",
    summary: "Quit Sophie.",
    details: "Also available as /quit. Ctrl+C or Ctrl+D quit from most screens.",
  },
];

let counter = 0;
const nid = () => `b${counter++}`;
const TRANSCRIPT_WHEEL_LINES = 3;
const TRANSCRIPT_PAGE_FRACTION = 0.5;

function freshSessionId(): string {
  const id = newSessionId();
  setCurrentSessionId(id);
  return id;
}

export function App({ modelDetail }: { modelDetail: string }) {
  const agent = useMemo(() => new Agent(), []);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [mode, setModeState] = useState<Mode>(getMode());
  const [audioMode, setAudioMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingApproval | null>(null);
  const [inputKey, setInputKey] = useState(0);
  const [draft, setDraft] = useState("");
  const [menuSel, setMenuSel] = useState(0);
  const [tasks, setTasks] = useState<Task[]>(getTasks());
  const [memoryEdit, setMemoryEdit] = useState<MemoryEdit | null>(null);
  const [commandReferenceOpen, setCommandReferenceOpen] = useState(false);
  // Setup wizard: forced on startup until setup is COMPLETE (onboarded + every
  // profile question answered), or opened on demand via /setup. firstRun:true
  // also means "can't be escaped" — the wizard only closes by saving.
  const [setup, setSetup] = useState<{ firstRun: boolean } | null>(
    isSetupComplete() ? null : { firstRun: true },
  );
  const [reviewingHistory, setReviewingHistory] = useState(false);
  const [presence, setPresence] = useState<Presence>(getPresence());
  const [turnStats, setTurnStats] = useState<TurnStats>(getTurnStats());
  const transcriptRef = useRef<ScrollBoxRenderable | null>(null);
  const commandReferenceRef = useRef<ScrollBoxRenderable | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const cancelNotedRef = useRef(false);
  // Remote/scheduled turns can arrive while a turn is already running; queue them.
  const busyRef = useRef(false);
  const turnQueueRef = useRef<{ text: string; opts: RunOpts }[]>([]);
  const runTurnRef = useRef<(text: string, opts?: RunOpts) => void>(() => {});
  const memoryRef = useRef<{ plainText?: string } | null>(null);
  const cwd = useMemo(() => process.cwd(), []);
  const sessionId = useRef(freshSessionId());
  const blocksRef = useRef<Block[]>([]);
  blocksRef.current = blocks;

  // Persist the whole session (model history + tasks + mode + transcript) so a
  // long task survives closing the TUI. Called after every turn.
  const saveCurrentSession = useCallback(() => {
    const history = agent.getHistory();
    if (!history.length) return;
    saveSession({
      id: sessionId.current,
      title: titleFrom(history),
      cwd,
      updatedAt: Date.now(),
      mode: getMode(),
      history,
      tasks: getTasks(),
      job: getCurrentJob(),
      journal: getJournal(),
      objective: getObjective(),
      blocks: blocksRef.current,
    });
  }, [agent, cwd]);

  const openMemory = useCallback(
    (scope: MemoryScope) => {
      setMemoryEdit({ scope, path: memoryPath(scope, cwd), initial: readMemoryFile(scope, cwd) });
    },
    [cwd],
  );
  const closeMemory = useCallback(
    (save: boolean) => {
      setMemoryEdit((cur) => {
        if (!cur) return null;
        if (save) {
          writeMemoryFile(cur.scope, cwd, memoryRef.current?.plainText ?? cur.initial);
          add({ id: nid(), kind: "system", text: `Saved ${cur.scope} memory · ${cur.path}` });
        } else {
          add({ id: nid(), kind: "system", text: "Memory edit cancelled (no changes saved)." });
        }
        return null;
      });
    },
    [cwd],
  );

  // Live task list — Sophie's plan, rendered as a HUD that updates in place.
  useEffect(() => subscribeTasks(setTasks), []);
  // Mode is shared state: stay in sync when Sophie switches it herself (set_mode).
  useEffect(() => subscribeMode(setModeState), []);
  // Live context-fill / generation-speed readout for the status line.
  useEffect(() => subscribeTurnStats(setTurnStats), []);
  // On launch, restore the latest session for this working directory. Sophie
  // still does no work while closed; this only restores the conversation and
  // live objective so the user can continue naturally after restarting.
  useEffect(() => {
    const s = latestSession(cwd);
    if (!s) return;
    sessionId.current = s.id;
    setCurrentSessionId(s.id);
    agent.restoreHistory(s.history);
    restoreCurrentJob(s.job);
    restoreTasks(s.tasks);
    restoreJournal(s.journal);
    setObjective(s.objective ?? null);
    setModeStore(s.mode);
    const restored = (s.blocks as Block[]).map((b) => ({ ...b, id: nid() }));
    const open = s.tasks.filter((task) => task.status !== "completed").length;
    setBlocks([
      ...restored,
      {
        id: nid(),
        kind: "system",
        text: `Restored "${s.title}" after restart.${open ? ` ${open} task${open === 1 ? "" : "s"} remain open; use /continue when you want Sophie to proceed.` : ""}`,
      },
    ]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  // First run: scan the machine + approximate location once and remember them,
  // so Sophie always knows what computer she's on. Best-effort, in background.
  useEffect(() => {
    void scanAndRememberMachine(cwd);
  }, [cwd]);

  // ── transcript helpers ────────────────────────────────────────────────
  const add = useCallback((b: Block) => setBlocks((prev) => [...prev, b]), []);
  useEffect(() => {
    const daemon = readDaemonStatus();
    const online = daemon?.state === "online" && Date.now() - daemon.heartbeatAt < 45_000;
    const waiting = listWork().filter((item) => item.status === "awaiting_approval");
    add({ id: nid(), kind: "system", text: online
      ? `Background Sophie online (pid ${daemon!.pid}).${waiting.length ? ` ${waiting.length} task${waiting.length === 1 ? "" : "s"} waiting for approval; ask me to list background work.` : ""}`
      : "Background Sophie is offline. Use `sophie daemon install` then `sophie daemon start` to enable continuous reminders and queued work." });
  }, [add]);
  const closeSetup = useCallback(
    (summary: string) => {
      setSetup(null);
      add({ id: nid(), kind: "system", text: summary });
    },
    [add],
  );
  // MCP servers connect in the background; surface connect/fail notices.
  useEffect(() => subscribeMcpStatus((text) => add({ id: nid(), kind: "system", text })), [add]);

  // Presence: flip to "away" after inactivity so Sophie reaches out remotely.
  useEffect(() => {
    const mins = Number(process.env.SOPHIE_AWAY_MINUTES);
    const idleMs = Number.isFinite(mins) && mins > 0 ? mins * 60_000 : DEFAULT_IDLE_MS;
    const stop = startPresenceMonitor({ idleMs });
    const unsub = subscribePresence(setPresence);
    return () => {
      stop();
      unsub();
    };
  }, []);

  // Telegram: one inbound bridge. A message from the owner becomes a turn (unless
  // a higher-priority waiter — a pending approval or notify(expect_reply) — claims
  // it first). Sophie's reply is mirrored back to the phone by runTurn.
  useEffect(() => {
    if (!telegramConfigured()) return;
    startTelegramBridge();
    add({
      id: nid(),
      kind: "system",
      text: telegramReady()
        ? "Telegram bridge online — messages from your authorized chat will become Sophie turns."
        : "Telegram bot token found. Message the bot once to receive the TELEGRAM_CHAT_ID setup reply.",
    });
    if (telegramReady()) {
      void sendTelegram("Sophie is online. Send me a message here while the terminal app is running.");
    }
    const unsub = subscribeTelegram((msg) => {
      noteExchange();
      runTurnRef.current(msg.text, { source: "telegram", mirror: true });
      return true; // consume — it's now a conversation turn
    });
    return unsub;
  }, []);

  // Scheduler: fired reminders notify the user; fired "run" jobs wake Sophie.
  useEffect(() => {
    const repaired = reconcileCalendarReminders();
    if (repaired.repairedEvents) {
      add({
        id: nid(),
        kind: "system",
        text: `Restart recovery: repaired ${repaired.createdReminders} upcoming reminder${repaired.createdReminders === 1 ? "" : "s"} across ${repaired.repairedEvents} calendar event${repaired.repairedEvents === 1 ? "" : "s"}.`,
      });
    }
    const stop = startScheduler((item: ScheduleItem) => {
      if (item.action === "run" && item.prompt) {
        runTurnRef.current(item.prompt, { source: "schedule", mirror: isAway() });
      } else {
        const body = item.message ?? item.title;
        add({ id: nid(), kind: "system", text: `⏰ ${item.title}: ${body}` });
        void notifyUser(body, { title: item.title, urgent: true, voice: item.voice });
      }
      // Tick off the Apple Reminders copy so it doesn't linger as overdue.
      if (item.mirror?.appleId) void completeAppleReminder(item.mirror.appleId);
    });
    return stop;
  }, [add]);

  // Calendar sync is session-bound: nothing runs while the TUI is closed, but
  // when Sophie starts she reconciles her stored internal calendar to any
  // configured external calendars.
  useEffect(() => {
    void syncUpcomingCalendarEvents().then((results) => {
      if (!results.length) {
        add({ id: nid(), kind: "system", text: `Calendar sync: ${calendarSyncStatus()}.` });
        return;
      }
      const ok = results.filter((r) => r.ok).length;
      const failed = results.length - ok;
      add({
        id: nid(),
        kind: failed ? "error" : "system",
        text: `Calendar sync on startup: ${ok} ok${failed ? `, ${failed} failed` : ""}.`,
      });
    });
  }, [add]);

  // Watchers: event triggers — a watched file/folder changed. Same fan-out as
  // the scheduler: "run" wakes Sophie with the prompt, "notify" pings the user.
  useEffect(() => {
    const stop = startWatchers((item, files) => {
      const shown = files.slice(0, 10).map(displayPath).join(", ");
      const changed = files.length > 10 ? `${shown} (+${files.length - 10} more)` : shown || item.path;
      if (item.action === "run" && item.prompt) {
        runTurnRef.current(`${item.prompt}\n\nChanged path(s): ${changed}`, { source: "watcher", mirror: isAway() });
      } else {
        const body = `${item.message ?? item.title} — ${changed}`;
        add({ id: nid(), kind: "system", text: `⚡ ${item.title}: ${body}` });
        void notifyUser(body, { title: item.title });
      }
    });
    return stop;
  }, [add]);

  // Whisper once at startup if a newer Sophie exists (git or npm; best-effort).
  useEffect(() => {
    void checkForUpdate().then((notice) => {
      if (notice) add({ id: nid(), kind: "system", text: notice });
    });
  }, [add]);
  const appendText = useCallback((id: string, delta: string) => {
    setBlocks((prev) =>
      prev.map((b) =>
        b.id === id && (b.kind === "assistant" || b.kind === "thinking")
          ? { ...b, text: b.text + delta }
          : b,
      ),
    );
  }, []);
  const patchTool = useCallback((id: string, patch: Partial<Block>) => {
    setBlocks((prev) => prev.map((b) => (b.id === id ? ({ ...b, ...patch } as Block) : b)));
  }, []);

  // ── slash-command menu (filtered as you type) ─────────────────────────
  const menu = useMemo(() => {
    if (busy || !draft.startsWith("/") || draft.includes(" ")) return null;
    const q = draft.slice(1).toLowerCase();
    const items = COMMANDS.filter(
      (c) => c.name.includes(q) || c.description.toLowerCase().includes(q),
    );
    return items.length ? items : null;
  }, [draft, busy]);
  useEffect(() => setMenuSel(0), [draft]);

  // ── run one turn (from the terminal, Telegram, or a fired schedule) ─────
  const runTurn = useCallback(
    async (text: string, opts: RunOpts = { source: "user" }) => {
      // If a turn is already running, queue this one instead of clobbering it.
      if (busyRef.current) {
        turnQueueRef.current.push({ text, opts });
        if (opts.source === "telegram" && telegramReady()) {
          void sendTelegram("Sophie is working right now. I have your message and will be right with you after the current task is done.");
        }
        return;
      }
      const mirror = opts.mirror ?? opts.source !== "user";
      // A local turn means the user is here and talking; refresh presence.
      if (opts.source === "user") {
        noteUserActivity();
        noteExchange();
      }
      setReviewingHistory(false);
      add({
        id: nid(),
        kind: opts.source === "schedule" ? "system" : "user",
        text: opts.source === "telegram" ? `📱 ${text}` : opts.source === "schedule" ? `⏰ ${text}` : text,
      });
      setBusy(true);
      busyRef.current = true;
      cancelNotedRef.current = false;
      const controller = new AbortController();
      abortRef.current = controller;

      let assistantId: string | null = null;
      let thinkingId: string | null = null;
      let replyText = "";
      let spokeViaTool = false;
      const toolBlockIds = new Map<string, string>();
      const streamSpeech = new StreamingSpeech(audioMode);

      try {
        await agent.run(
          text,
          {
            onThinking: (d) => {
              if (!thinkingId) {
                thinkingId = nid();
                add({ id: thinkingId, kind: "thinking", text: "" });
              }
              appendText(thinkingId, d);
            },
            onContent: (d) => {
              if (!assistantId) {
                assistantId = nid();
                add({ id: assistantId, kind: "assistant", text: "" });
              }
              replyText += d;
              appendText(assistantId, d);
              streamSpeech.push(d);
            },
            onToolCall: (call) => {
              if (call.name === "speak") {
                spokeViaTool = true;
                streamSpeech.stop();
              }
              assistantId = null;
              thinkingId = null;
              const bid = nid();
              toolBlockIds.set(call.id, bid);
              add({
                id: bid,
                kind: "tool",
                name: call.name,
                summary: call.summary,
                risk: call.risk,
                status: "running",
              });
            },
            onToolResult: (callId, result) => {
              const bid = toolBlockIds.get(callId);
              if (bid)
                patchTool(bid, {
                  status: result.display === "cancelled" ? "cancelled" : result.isError ? "error" : "done",
                  result: result.display ?? clip(result.content),
                  diff: result.diff,
                });
            },
            requestApproval: (call) =>
              new Promise((resolve) => {
                const bid = toolBlockIds.get(call.id);
                if (bid) patchTool(bid, { status: "awaiting" });
                // If the user is away, route the approval to Telegram too, and
                // take whichever answer (terminal or phone) lands first.
                const remote = isAway() && telegramReady() ? new AbortController() : null;
                let settled = false;
                const finish = (d: "approve" | "deny") => {
                  if (settled) return;
                  settled = true;
                  remote?.abort();
                  setPending(null);
                  if (bid) {
                    patchTool(
                      bid,
                      d === "deny" ? { status: "denied" } : { status: "running", result: "approved; running..." },
                    );
                  }
                  resolve(d);
                };
                setPending({ call, resolve: finish });
                if (remote) {
                  void sendTelegram(
                    `🔐 Approve this action?\n${call.name} — ${call.summary}\n\n${(call.details ?? "").slice(0, 2500)}\n\nReply "yes" to approve or "no" to deny.`,
                  );
                  void awaitTelegramReply({ timeoutMs: 30 * 60_000, signal: remote.signal }).then((msg) => {
                    if (!msg || settled) return;
                    const yes = /^\s*(y|yes|yep|yeah|ok|okay|sure|approve|do it|go)\b/i.test(msg.text);
                    finish(yes ? "approve" : "deny");
                  });
                }
              }),
            onCheckpoint: saveCurrentSession,
            onError: (m) => {
              add({ id: nid(), kind: "error", text: m });
              if (mirror && telegramReady()) void sendTelegram(`⚠️ ${m}`);
            },
          },
          controller.signal,
          { source: opts.source },
        );
        // Mirror the final answer back to whoever pinged remotely.
        if (mirror && replyText.trim() && telegramReady()) {
          void sendTelegram(replyText.trim());
        }
        // Drain any remaining speech chunks (tail of the last sentence).
        if (!spokeViaTool) await streamSpeech.finish();
      } finally {
        streamSpeech.stop();
        setBusy(false);
        busyRef.current = false;
        setPending(null);
        abortRef.current = null;
        saveCurrentSession();
        // Drain any turns that arrived while this one was running.
        const next = turnQueueRef.current.shift();
        if (next) void runTurnRef.current(next.text, next.opts);
      }
    },
    [agent, add, appendText, patchTool, saveCurrentSession, audioMode],
  );
  // Keep a stable ref so background subscriptions always call the latest runTurn.
  useEffect(() => {
    runTurnRef.current = (text, opts) => void runTurn(text, opts);
  }, [runTurn]);

  const cancelTurn = useCallback(() => {
    const controller = abortRef.current;
    if (!controller || controller.signal.aborted) return;
    controller.abort();
    setPending((cur) => {
      cur?.resolve("deny");
      return null;
    });
    if (!cancelNotedRef.current) {
      cancelNotedRef.current = true;
      add({ id: nid(), kind: "system", text: "Interrupted current run." });
    }
  }, [add]);

  const steerActiveTurn = useCallback(
    (text: string) => {
      agent.steer(text);
      noteUserActivity();
      noteExchange();
      setReviewingHistory(false);
      add({ id: nid(), kind: "user", text: `↪ ${text}` });
      add({ id: nid(), kind: "system", text: "Steering note queued for Sophie's next safe checkpoint." });
    },
    [agent, add],
  );

  // Resume a saved session: restore model history, tasks, mode, and transcript.
  const resumeSession = useCallback(() => {
    const s = latestSession(cwd) ?? latestSession();
    if (!s) {
      add({ id: nid(), kind: "system", text: "No saved session to resume." });
      return;
    }
    sessionId.current = s.id;
    setCurrentSessionId(s.id);
    agent.restoreHistory(s.history);
    restoreCurrentJob(s.job);
    restoreTasks(s.tasks);
    restoreJournal(s.journal);
    setObjective(s.objective ?? null);
    setModeStore(s.mode);
    // Re-key restored blocks so their ids can't collide with new ones.
    setBlocks((s.blocks as Block[]).map((b) => ({ ...b, id: nid() })));
    const pendingCount = s.tasks.filter((t) => t.status !== "completed").length;
    add({
      id: nid(),
      kind: "system",
      text:
        `Resumed "${s.title}" (${s.history.filter((m) => m.role === "user").length} turns).` +
        (pendingCount ? ` ${pendingCount} task${pendingCount === 1 ? "" : "s"} still open; use /continue to keep working.` : ""),
    });
  }, [agent, cwd, add]);

  const resumeJob = useCallback(
    (id: string | undefined) => {
      const key = id?.trim();
      if (!key) {
        add({ id: nid(), kind: "system", text: "Usage: /resume-job <job-id>" });
        return;
      }
      const episode = loadEpisode(key);
      if (!episode) {
        add({ id: nid(), kind: "system", text: `No saved job found for ${key}. Use /jobs to list jobs.` });
        return;
      }
      agent.restoreHistory([]);
      sessionId.current = freshSessionId();
      setObjective(episode.objective);
      restoreCurrentJob(episode.job);
      restoreTasks(episode.tasks);
      restoreJournal(episode.journal);
      setBlocks([
        {
          id: nid(),
          kind: "system",
          text:
            `Resumed job ${episode.job.id}: ${episode.job.title}\n` +
            `${episode.tasks.filter((t) => t.status !== "completed").length} open task(s). Type /continue to work it.`,
        },
      ]);
    },
    [agent, add],
  );

  // ── submit / commands ─────────────────────────────────────────────────
  const submit = useCallback(
    (raw: string) => {
      // If the menu is open, a submit picks the highlighted command.
      let text = raw.trim();
      if (menu) text = `/${menu[Math.min(menuSel, menu.length - 1)].name}`;
      setInputKey((k) => k + 1);
      if (!text) return;
      if (busy) {
        steerActiveTurn(text);
        return;
      }

      if (text.startsWith("/")) {
        const [cmd, arg] = text.slice(1).split(/\s+/);
        switch (cmd) {
          case "exit":
          case "quit":
            process.exit(0);
            return;
          case "new":
          case "clear":
            agent.reset();
            sessionId.current = freshSessionId();
            setBlocks([{ id: nid(), kind: "system", text: "Started a fresh conversation." }]);
            return;
          case "resume":
            resumeSession();
            return;
          case "jobs": {
            const list = listEpisodes().slice(0, 15);
            add({
              id: nid(),
              kind: "system",
              text: list.length
                ? "Saved jobs (newest first; resume with /resume-job <id>):\n" +
                  list
                    .map((j) =>
                      `  · ${j.id} — ${j.status}, ${j.openTasks} open — ${j.title} — ${new Date(j.updatedAt).toLocaleString()}`,
                    )
                    .join("\n")
                : "No saved jobs yet.",
            });
            return;
          }
          case "resume-job":
            resumeJob(arg);
            return;
          case "continue": {
            const open = getTasks().filter((t) => t.status !== "completed");
            if (!open.length) {
              add({ id: nid(), kind: "system", text: "No open tasks to continue." });
              return;
            }
            void runTurn(
              "Continue the saved task list from exactly where it left off. First inspect the live task list, set the next pending item to in_progress if needed, then use tools to finish every open task. Do not summarize and stop while tasks remain unless genuinely blocked.",
            );
            return;
          }
          case "sessions": {
            const list = listSessions().slice(0, 10);
            add({
              id: nid(),
              kind: "system",
              text: list.length
                ? "Saved sessions (newest first; /resume opens the latest):\n" +
                  list.map((s) => `  · ${s.title} — ${s.turns} turns, ${new Date(s.updatedAt).toLocaleString()}`).join("\n")
                : "No saved sessions yet.",
            });
            return;
          }
          case "webapp":
            void (async () => {
              try {
                const { startWebAppServer, stopWebAppServer } = await import("../webapp/server.ts");
                if (arg === "stop" || arg === "kill") {
                  const result = await stopWebAppServer();
                  add({ id: nid(), kind: result.stopped ? "system" : "error", text: result.detail });
                  return;
                }
                add({ id: nid(), kind: "system", text: "Starting Sophie's web app..." });
                const result = await startWebAppServer({ cwd, open: true });
                let telegramNote = "";
                if (telegramReady()) {
                  const sent = await sendTelegram(
                    `Sophie web app ${result.reused ? "is already running" : "is live"}:\n${result.url}\n\nThis link includes the auth token.`,
                  );
                  telegramNote = sent.ok
                    ? "\nSent the web app link to Telegram."
                    : `\nTelegram send failed: ${sent.detail}`;
                } else if (telegramConfigured()) {
                  telegramNote = "\nTelegram is configured but TELEGRAM_CHAT_ID is not set, so I could not send the web app link.";
                }
                add({
                  id: nid(),
                  kind: telegramNote.includes("failed") ? "error" : "system",
                  text:
                    `${result.detail}\n` +
                    `Say "kill the web app" in Sophie or run /webapp stop to shut it down.` +
                    telegramNote,
                });
              } catch (e: any) {
                add({ id: nid(), kind: "error", text: `Web app failed to start: ${e?.message ?? e}` });
              }
            })();
            return;
          case "memory":
            openMemory(arg === "project" ? "project" : "user");
            return;
          case "undo": {
            const res = undoLast();
            add({ id: nid(), kind: "system", text: res.summary });
            return;
          }
          case "doctor":
            add({ id: nid(), kind: "system", text: "Running health checks…" });
            void runDoctor(cwd).then((report) => add({ id: nid(), kind: "system", text: report }));
            return;
          case "setup":
            setSetup({ firstRun: false });
            return;
          case "plan":
            setModeStore("plan");
            add({ id: nid(), kind: "system", text: "Plan mode — I'll think and propose, read-only." });
            return;
          case "normal":
            setModeStore("normal");
            add({ id: nid(), kind: "system", text: "Normal mode — I'll act on it." });
            return;
          case "build":
            setModeStore("build");
            add({ id: nid(), kind: "system", text: "Build mode — I'll plan it in phases (asking anything I need to know), then build and verify the MVP step by step, and exit build when it's done." });
            return;
          case "audio": {
            const next = !audioMode;
            setAudioMode(next);
            add({ id: nid(), kind: "system", text: next ? "Audio mode on — Sophie will speak every reply aloud." : "Audio mode off — Sophie speaks only when the speak tool is used." });
            return;
          }
          case "commands":
          case "help":
            setCommandReferenceOpen(true);
            return;
          default:
            add({ id: nid(), kind: "system", text: `Unknown command: /${cmd}` });
            return;
        }
      }
      void runTurn(text);
    },
    [menu, menuSel, busy, agent, add, runTurn, openMemory, resumeSession, resumeJob, steerActiveTurn, cwd],
  );

  // ── keyboard ──────────────────────────────────────────────────────────
  const scrollTranscript = useCallback((direction: "up" | "down" | "top" | "bottom", amount: "wheel" | "page" = "wheel") => {
    const transcript = transcriptRef.current;
    if (!transcript) return;

    if (direction === "top") {
      setReviewingHistory(true);
      transcript.stickyScroll = false;
      transcript.scrollTo(0);
      return;
    }
    if (direction === "bottom") {
      setReviewingHistory(false);
      transcript.stickyScroll = true;
      transcript.scrollTo(transcript.scrollHeight);
      return;
    }

    setReviewingHistory(true);
    transcript.stickyScroll = false;
    const delta =
      amount === "page"
        ? TRANSCRIPT_PAGE_FRACTION
        : Math.min(TRANSCRIPT_WHEEL_LINES, Math.max(1, Math.floor(transcript.height / 4)));
    transcript.scrollBy(direction === "up" ? -delta : delta, amount === "page" ? "viewport" : "absolute");
    const bottom = Math.max(0, transcript.scrollHeight - transcript.viewport.height);
    if (direction === "down" && transcript.scrollTop >= bottom) {
      setReviewingHistory(false);
      transcript.stickyScroll = true;
    }
  }, []);

  const scrollCommandReference = useCallback((direction: "up" | "down", amount: "wheel" | "page" = "wheel") => {
    const page = commandReferenceRef.current;
    if (!page) return;
    const delta =
      amount === "page"
        ? TRANSCRIPT_PAGE_FRACTION
        : Math.min(TRANSCRIPT_WHEEL_LINES, Math.max(1, Math.floor(page.height / 4)));
    page.scrollBy(direction === "up" ? -delta : delta, amount === "page" ? "viewport" : "absolute");
  }, []);

  useKeyboard((key) => {
    noteUserActivity(); // any keypress means the user is at the terminal
    // Setup wizard owns all keys while open (it has its own key handler).
    if (setup) return;
    // Memory editor owns all keys while open (the textarea handles typing).
    if (memoryEdit) {
      if (key.ctrl && (key.name === "c" || key.name === "d")) process.exit(0);
      else if (key.ctrl && key.name === "s") closeMemory(true);
      else if (key.name === "escape") closeMemory(false);
      return;
    }
    if (commandReferenceOpen) {
      if (key.ctrl && (key.name === "c" || key.name === "d")) process.exit(0);
      if (key.name === "escape") {
        setCommandReferenceOpen(false);
        return;
      }
      if (key.name === "pageup" || ((key.meta || key.option) && key.name === "up")) {
        key.preventDefault();
        scrollCommandReference("up", "page");
        return;
      }
      if (key.name === "pagedown" || ((key.meta || key.option) && key.name === "down")) {
        key.preventDefault();
        scrollCommandReference("down", "page");
        return;
      }
      if (key.name === "up") {
        key.preventDefault();
        scrollCommandReference("up");
        return;
      }
      if (key.name === "down") {
        key.preventDefault();
        scrollCommandReference("down");
      }
      return;
    }
    if (pending) {
      if (key.name === "y") pending.resolve("approve");
      else if (key.name === "return") pending.resolve("deny");
      else if (key.name === "n") pending.resolve("deny");
      else if (key.name === "escape") cancelTurn();
      return;
    }
    if (key.ctrl && (key.name === "c" || key.name === "d")) process.exit(0);
    if (key.name === "pageup" || ((key.meta || key.option) && key.name === "up")) {
      key.preventDefault();
      scrollTranscript("up", "page");
      return;
    }
    if (key.name === "pagedown" || ((key.meta || key.option) && key.name === "down")) {
      key.preventDefault();
      scrollTranscript("down", "page");
      return;
    }
    if (key.name === "home") {
      key.preventDefault();
      scrollTranscript("top");
      return;
    }
    if (key.name === "end") {
      key.preventDefault();
      scrollTranscript("bottom");
      return;
    }
    if (menu) {
      if (key.name === "up") setMenuSel((s) => Math.max(0, s - 1));
      else if (key.name === "down" || key.name === "tab") setMenuSel((s) => Math.min(menu.length - 1, s + 1));
      return;
    }
    if (((key.name === "tab" && key.shift) || key.name === "backtab") && !busy) {
      if (audioMode) {
        // audio → normal (cycle wraps back)
        setAudioMode(false);
        setModeStore("normal");
      } else if (mode === "build") {
        // build → audio
        setAudioMode(true);
        setModeStore("normal");
      } else {
        // normal → plan → build
        setModeStore(nextMode(mode));
      }
      return;
    }
    if (key.name === "escape" && busy) cancelTurn();
  });

  // ── render ────────────────────────────────────────────────────────────
  // The setup wizard is a full-screen takeover (first run or /setup).
  if (setup) {
    return <SetupWizard firstRun={setup.firstRun} onDone={closeSetup} />;
  }

  const modeColor = mode === "plan" ? theme.pink : mode === "build" ? theme.warn : theme.green;
  const barColor = busy ? theme.faint : theme.pink;
  const showTaskPanel = tasks.length > 0 && (busy || tasks.some((t) => t.status !== "completed"));

  return (
    <box style={{ flexDirection: "column", height: "100%", backgroundColor: theme.bg }}>
              <Header modelDetail={modelDetail} mode={mode} modeColor={modeColor} presence={presence} audioMode={audioMode} />

      {memoryEdit ? (
        <MemoryEditor edit={memoryEdit} editorRef={memoryRef} />
      ) : commandReferenceOpen ? (
        <CommandReference pageRef={commandReferenceRef} />
      ) : (
        <>
      {/* Transcript */}
      <scrollbox
        ref={transcriptRef}
        stickyScroll={!reviewingHistory}
        stickyStart={blocks.length === 0 ? "top" : "bottom"}
        scrollY
        onMouseScroll={(event) => {
          const direction = event.scroll?.direction;
          if (direction !== "up" && direction !== "down") return;
          event.preventDefault();
          event.stopPropagation();
          scrollTranscript(direction);
        }}
        style={{ flexGrow: 1, paddingLeft: 2, paddingRight: 2, backgroundColor: theme.bg }}
        contentOptions={{ flexDirection: "column", backgroundColor: theme.bg }}
        verticalScrollbarOptions={{
          showArrows: false,
          trackOptions: { foregroundColor: theme.faint, backgroundColor: theme.bg },
        }}
      >
        {blocks.length === 0 ? <Welcome modelDetail={modelDetail} /> : blocks.map((b) => <BlockView key={b.id} block={b} />)}
        {busy && !pending && <Working />}
      </scrollbox>

      {/* Live task list (Sophie's plan) */}
      {showTaskPanel && <TaskPanel tasks={tasks} />}

      {/* Approval */}
      {pending && <ApprovalBar call={pending.call} />}

      {/* Slash menu (floats just above the prompt) */}
      {menu && !pending && (
        <box
          style={{
            flexDirection: "column",
            flexShrink: 0,
            marginLeft: 2,
            marginRight: 2,
            paddingLeft: 1,
            paddingRight: 1,
            border: true,
            borderColor: theme.faint,
            backgroundColor: theme.panel,
          }}
        >
          <text wrapMode="none">
            {menu.map((c, i) => {
              const sel = i === menuSel;
              return (
                <span key={c.name}>
                  <span fg={sel ? theme.green : theme.faint}>{sel ? "❯ " : "  "}</span>
                  <span fg={sel ? theme.green : theme.dim}>{`/${c.name}`.padEnd(9)}</span>
                  <span fg={sel ? theme.soft : theme.dim}>{`  ${c.description}`}</span>
                  {i < menu.length - 1 ? <br /> : null}
                </span>
              );
            })}
          </text>
        </box>
      )}

      {/* Prompt box — left heavy bar, agent0 style */}
      <box
        style={{
          marginLeft: 2,
          marginRight: 2,
          marginTop: 1,
          height: 3,
          flexShrink: 0,
          paddingLeft: 2,
          backgroundColor: theme.prompt,
          border: ["left"],
          borderColor: barColor,
          customBorderChars: PROMPT_BORDER,
        }}
      >
        <input
          key={inputKey}
          focused={!pending}
          placeholder={busy ? "Steer Sophie while she works…" : placeholderForMode(mode)}
          backgroundColor={theme.prompt}
          textColor={theme.text}
          placeholderColor={theme.dim}
          focusedBackgroundColor={theme.prompt}
          focusedTextColor={theme.text}
          onInput={(v: string | unknown) => {
            noteUserActivity();
            setDraft(typeof v === "string" ? v : "");
          }}
          onSubmit={(v: string | unknown) => {
            if (typeof v === "string") submit(v);
          }}
        />
      </box>

      {/* Status line — hints left, live context/speed gauges right */}
      <box
        style={{
          flexDirection: "row",
          justifyContent: "space-between",
          paddingLeft: 2,
          paddingRight: 2,
          height: 1,
          flexShrink: 0,
        }}
      >
        <text fg={theme.dim}>{statusHint(mode, audioMode, busy, reviewingHistory)}</text>
        <StatusGauges stats={turnStats} />
      </box>
        </>
      )}
    </box>
  );
}

/** Full-screen editor for a SOPHIE.md memory file (user or project). */
function MemoryEditor({
  edit,
  editorRef,
}: {
  edit: MemoryEdit;
  editorRef: React.RefObject<{ plainText?: string } | null>;
}) {
  return (
    <box style={{ flexDirection: "column", flexGrow: 1, paddingLeft: 2, paddingRight: 2 }}>
      <box style={{ flexDirection: "row", paddingTop: 1, paddingBottom: 1, flexShrink: 0 }}>
        <text fg={theme.pinkSoft}>
          <b>{`✎ ${edit.scope} memory`}</b>
        </text>
        <text fg={theme.dim}>{`  ${edit.path}`}</text>
      </box>
      <box
        style={{
          flexGrow: 1,
          border: true,
          borderColor: theme.border,
          backgroundColor: theme.panel,
          paddingLeft: 1,
          paddingRight: 1,
        }}
      >
        <textarea
          ref={editorRef as any}
          focused
          initialValue={edit.initial}
          style={{ flexGrow: 1 }}
          backgroundColor={theme.panel}
          textColor={theme.text}
          focusedBackgroundColor={theme.panel}
          focusedTextColor={theme.text}
        />
      </box>
      <box style={{ paddingTop: 1, flexShrink: 0 }}>
        <text fg={theme.dim}>
          {"  "}
          <span fg={theme.green}>Ctrl+S</span> save{"   "}
          <span fg={theme.error}>Esc</span> cancel{"   "}
          <span fg={theme.faint}>— edit freely: add, change, or delete any line</span>
        </text>
      </box>
    </box>
  );
}

function CommandReference({ pageRef }: { pageRef: React.RefObject<ScrollBoxRenderable | null> }) {
  return (
    <box style={{ flexDirection: "column", flexGrow: 1, paddingLeft: 2, paddingRight: 2 }}>
      <box style={{ flexDirection: "row", paddingTop: 1, paddingBottom: 1, flexShrink: 0 }}>
        <text fg={theme.pinkSoft}>
          <b>{"⌘ Command reference"}</b>
        </text>
        <text fg={theme.dim}>{"  Esc closes this page and returns to your conversation"}</text>
      </box>
      <scrollbox
        ref={pageRef}
        scrollY
        onMouseScroll={(event) => {
          const direction = event.scroll?.direction;
          if (direction !== "up" && direction !== "down") return;
          event.preventDefault();
          event.stopPropagation();
          const page = pageRef.current;
          if (!page) return;
          page.scrollBy(direction === "up" ? -TRANSCRIPT_WHEEL_LINES : TRANSCRIPT_WHEEL_LINES, "absolute");
        }}
        style={{
          flexGrow: 1,
          border: true,
          borderColor: theme.border,
          backgroundColor: theme.panel,
          paddingLeft: 2,
          paddingRight: 2,
          paddingTop: 1,
          paddingBottom: 1,
        }}
        contentOptions={{ flexDirection: "column", backgroundColor: theme.panel }}
        verticalScrollbarOptions={{
          showArrows: false,
          trackOptions: { foregroundColor: theme.faint, backgroundColor: theme.panel },
        }}
      >
        <box style={{ flexDirection: "column", paddingBottom: 1 }}>
          <text fg={theme.text} wrapMode="word">
            Slash commands run locally in the TUI. They do not get sent to the model unless the command itself starts or resumes a Sophie turn.
          </text>
          <box style={{ paddingTop: 1 }}>
            <text fg={theme.dim} wrapMode="word">
              Use <span fg={theme.green}>/</span> to open the command picker, ↑/↓ to choose, Enter to run.
            </text>
          </box>
        </box>

        {COMMAND_REFERENCE.map((entry) => (
          <box key={entry.command} style={{ flexDirection: "column", paddingTop: 1 }}>
            <text wrapMode="word">
              <span fg={theme.green}>{entry.command.padEnd(18)}</span>
              <span fg={theme.text}>{entry.summary}</span>
            </text>
            <box style={{ paddingLeft: 2 }}>
              <text fg={theme.dim} wrapMode="word">{entry.details}</text>
            </box>
          </box>
        ))}

        <box style={{ flexDirection: "column", paddingTop: 2 }}>
          <text fg={theme.pinkSoft}><b>{"Keyboard"}</b></text>
          <text fg={theme.dim} wrapMode="word">Shift+Tab cycles Normal → Plan → Build → Audio → Normal.</text>
          <text fg={theme.dim} wrapMode="word">Esc interrupts a running Sophie turn; on this page it closes the reference.</text>
          <text fg={theme.dim} wrapMode="word">Mouse wheel, PgUp/PgDn, Option+↑/↓, or ↑/↓ scroll long pages and transcript history.</text>
          <text fg={theme.dim} wrapMode="word">Ctrl+C or Ctrl+D quits.</text>
        </box>
      </scrollbox>
      <box style={{ paddingTop: 1, flexShrink: 0 }}>
        <text fg={theme.dim}>
          {"  "}
          <span fg={theme.error}>Esc</span> close{"   "}
          <span fg={theme.green}>PgUp/PgDn</span> scroll{"   "}
          <span fg={theme.faint}>conversation stays exactly where you left it</span>
        </text>
      </box>
    </box>
  );
}

function Header({
  modelDetail,
  mode,
  modeColor,
  presence,
  audioMode,
}: {
  modelDetail: string;
  mode: Mode;
  modeColor: string;
  presence: Presence;
  audioMode: boolean;
}) {
  const model = modelDetail.split("/").pop() ?? modelDetail;
  return (
    <box
      style={{
        flexDirection: "row",
        justifyContent: "space-between",
        paddingLeft: 2,
        paddingRight: 2,
        height: 1,
      }}
    >
      <text>
        <span fg={theme.pink}>{"▚▚ "}</span>
        <span fg={theme.text}>SOPHIE</span>
        <span fg={theme.faint}>{" // "}</span>
        <span fg={theme.dim}>{model}</span>
      </text>
      <text>
        {presence === "away" ? <span fg={theme.warn}>{"[ AWAY ]  "}</span> : null}
        <span fg={audioMode ? theme.green : modeColor}>{audioMode ? "[ AUDIO ]" : modeLabel(mode)}</span>
      </text>
    </box>
  );
}

function Welcome({ modelDetail }: { modelDetail: string }) {
  const model = clip(modelDetail.split("/").pop() ?? modelDetail, 40);
  const cwd = clip(displayPath(process.cwd()), 40);
  return (
    <box
      style={{
        flexDirection: "column",
        marginTop: 1,
        marginBottom: 1,
        border: true,
        borderColor: theme.border,
        backgroundColor: theme.panel,
        paddingLeft: 2,
        paddingRight: 2,
        paddingTop: 1,
        paddingBottom: 1,
      }}
    >
      <text fg={theme.pink} wrapMode="none">
        {LOGO.map((line, i) => (
          <span key={i}>
            {line}
            {i < LOGO.length - 1 ? <br /> : null}
          </span>
        ))}
      </text>
      <box style={{ paddingTop: 1 }}>
        <text wrapMode="none">
          <span fg={theme.green}>{`v${pkg.version}`}</span>
          <span fg={theme.faint}>{" · "}</span>
          <span fg={theme.dim}>local-first terminal agent</span>
        </text>
      </box>
      <box style={{ paddingTop: 1, flexDirection: "column" }}>
        <text wrapMode="none">
          <span fg={theme.faint}>{"MODEL  "}</span>
          <span fg={theme.soft}>{model}</span>
        </text>
        <text wrapMode="none">
          <span fg={theme.faint}>{"CWD    "}</span>
          <span fg={theme.soft}>{cwd}</span>
        </text>
      </box>
    </box>
  );
}

/** Live task list HUD — Sophie's externalized plan, updates in place. */
function TaskPanel({ tasks }: { tasks: Task[] }) {
  const done = tasks.filter((t) => t.status === "completed").length;
  return (
    <box
      title={` TASKS ${done}/${tasks.length} `}
      titleColor={theme.pinkSoft}
      style={{
        flexDirection: "column",
        flexShrink: 0,
        marginLeft: 2,
        marginRight: 2,
        paddingLeft: 1,
        paddingRight: 1,
        border: true,
        borderColor: theme.border,
        backgroundColor: theme.panel,
      }}
    >
      <text wrapMode="none">
        {tasks.map((t, i) => {
          const icon = t.status === "completed" ? "✓" : t.status === "in_progress" ? "◐" : "▢";
          const iconColor =
            t.status === "completed" ? theme.green :
            t.status === "in_progress" ? theme.pinkSoft : theme.faint;
          const textColor =
            t.status === "completed" ? theme.dim :
            t.status === "in_progress" ? theme.text : theme.soft;
          return (
            <span key={i}>
              <span fg={iconColor}>{`${icon} `}</span>
              <span fg={textColor}>{t.content}</span>
              {t.attempts && t.attempts > 1 ? (
                <span fg={theme.faint}>{` · attempt ${t.attempts}`}</span>
              ) : null}
              {t.note ? (
                <span fg={theme.faint}>
                  <br />
                  {`    ↳ ${t.note}`}
                </span>
              ) : null}
              {i < tasks.length - 1 ? <br /> : null}
            </span>
          );
        })}
      </text>
    </box>
  );
}

/**
 * The live "Sophie is working" indicator — a braille spinner with a phrase
 * that cycles every ~1.6s and an elapsed timer. Mounts only while busy, so it
 * sits directly under the latest streamed content (Claude Code style).
 */
function Working() {
  const [tick, setTick] = useState(0);
  const start = useRef(Date.now());
  const base = useRef(Math.floor(Math.random() * WORKING_PHRASES.length));
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 100);
    return () => clearInterval(t);
  }, []);
  const frame = SPINNER[tick % SPINNER.length];
  const phrase = WORKING_PHRASES[(base.current + Math.floor(tick / 16)) % WORKING_PHRASES.length];
  const elapsed = Math.floor((Date.now() - start.current) / 1000);
  const elapsedLabel = formatWorkingElapsed(elapsed);
  return (
    <box style={{ flexDirection: "row", paddingTop: 1 }}>
      <text fg={theme.green}>{`${frame} `}</text>
      <text fg={theme.pinkSoft}>{`${phrase}… `}</text>
      <text fg={theme.dim}>{elapsedLabel ? `(${elapsedLabel} · esc to interrupt)` : "(esc to interrupt)"}</text>
    </box>
  );
}

/**
 * A bulleted row with a fixed-width gutter and a hanging-indented body —
 * the Claude Code transcript primitive. `gutter` is the 2-char marker column.
 */
function Row({
  gutter,
  gutterColor,
  children,
  pad = true,
}: {
  gutter: string;
  gutterColor: string;
  children: ReactNode;
  pad?: boolean;
}) {
  return (
    <box style={{ flexDirection: "row", paddingTop: pad ? 1 : 0 }}>
      <text fg={gutterColor}>{gutter}</text>
      <box style={{ flexGrow: 1, flexDirection: "column" }}>{children}</box>
    </box>
  );
}

function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case "user":
      return (
        <Row gutter="> " gutterColor={theme.pink}>
          <text fg={theme.soft} wrapMode="word">
            {block.text}
          </text>
        </Row>
      );
    case "assistant":
      return (
        <Row gutter="● " gutterColor={theme.green}>
          <text fg={theme.text} wrapMode="word">
            {block.text}
          </text>
        </Row>
      );
    case "thinking":
      return (
        <Row gutter="✻ " gutterColor={theme.dim}>
          <text fg={theme.dim} wrapMode="word">
            <em>{block.text}</em>
          </text>
        </Row>
      );
    case "system":
      return (
        <Row gutter="  " gutterColor={theme.dim}>
          <text fg={theme.dim} wrapMode="word">
            {block.text}
          </text>
        </Row>
      );
    case "error":
      return (
        <Row gutter="✗ " gutterColor={theme.error}>
          <text fg={theme.error} wrapMode="word">
            {block.text}
          </text>
        </Row>
      );
    case "tool":
      return <ToolView block={block} />;
  }
}

function ToolView({ block }: { block: Extract<Block, { kind: "tool" }> }) {
  const color =
    block.status === "error" || block.status === "denied" || block.status === "cancelled" ? theme.error :
    block.status === "awaiting" ? theme.warn :
    block.status === "running" ? theme.pinkSoft : theme.green;
  const resultText =
    block.status === "denied" ? "denied" :
    block.status === "cancelled" ? "cancelled" :
    block.status === "awaiting" ? "waiting for approval…" :
    block.result;
  return (
    <Row gutter="● " gutterColor={color}>
      <text wrapMode="word">
        <span fg={theme.text}>{block.name}</span>
        <span fg={theme.dim}>{`(${block.summary})`}</span>
      </text>
      {resultText ? (
        <box style={{ flexDirection: "row" }}>
          <text fg={theme.faint}>{"⎿ "}</text>
          <text fg={theme.dim} wrapMode="word">
            {resultText}
          </text>
        </box>
      ) : null}
      {block.diff && block.diff.hunks.length > 0 ? <DiffView diff={block.diff} /> : null}
    </Row>
  );
}

/** Cap on diff rows rendered in the transcript before we collapse the rest. */
const MAX_DIFF_ROWS = 160;

/**
 * Claude-Code-style file diff: a line-number gutter and full-width tinted rows —
 * green `+` additions, red `-` removals, dim context. Long diffs are truncated.
 */
function DiffView({ diff }: { diff: FileDiff }) {
  let maxNo = 1;
  for (const h of diff.hunks)
    for (const l of h.lines) maxNo = Math.max(maxNo, l.newNo ?? 0, l.oldNo ?? 0);
  const noWidth = String(maxNo).length;

  let rows = 0;
  let truncated = false;
  return (
    <box style={{ flexDirection: "column", marginLeft: 2, marginTop: 1 }}>
      {diff.hunks.map((h, hi) => (
        <box key={hi} style={{ flexDirection: "column" }}>
          {hi > 0 && !truncated ? <text fg={theme.diffGutter}>{"⋮"}</text> : null}
          {h.lines.map((l, li) => {
            if (rows >= MAX_DIFF_ROWS) {
              truncated = true;
              return null;
            }
            rows++;
            const isAdd = l.type === "add";
            const isDel = l.type === "del";
            const bg = isAdd ? theme.diffAddBg : isDel ? theme.diffDelBg : theme.bg;
            const sign = isAdd ? "+" : isDel ? "-" : " ";
            const signFg = isAdd ? theme.diffAddSign : isDel ? theme.diffDelSign : theme.diffGutter;
            const textFg = isAdd ? theme.diffAddText : isDel ? theme.diffDelText : theme.diffCtx;
            const no = isAdd ? l.newNo : l.oldNo;
            return (
              <box key={li} style={{ flexDirection: "row", backgroundColor: bg }}>
                <text fg={theme.diffGutter} bg={bg}>{`${String(no ?? "").padStart(noWidth)} `}</text>
                <text fg={signFg} bg={bg}>{`${sign} `}</text>
                <text fg={textFg} bg={bg} wrapMode="none">
                  {l.text.length ? l.text : " "}
                </text>
              </box>
            );
          })}
        </box>
      ))}
      {truncated ? (
        <text fg={theme.diffGutter}>{`⋮  (+${diff.added} -${diff.removed} total; diff truncated)`}</text>
      ) : null}
    </box>
  );
}

function ApprovalBar({ call }: { call: ToolCallEvent }) {
  const dangerous = call.risk === "dangerous";
  const color = dangerous ? theme.error : theme.warn;
  return (
    <box
      style={{
        flexDirection: "column",
        flexShrink: 0,
        border: true,
        borderColor: color,
        marginLeft: 2,
        marginRight: 2,
        paddingLeft: 1,
        paddingRight: 1,
        backgroundColor: theme.panel,
      }}
    >
      <text fg={color}>
        <b>{`${dangerous ? "⚠ DANGEROUS ACTION" : "Approve action"} — ${call.name}`}</b>
      </text>
      <text fg={theme.text} wrapMode="word">{call.summary}</text>
      {call.details && <text fg={theme.dim} wrapMode="word">{call.details}</text>}
      <text fg={theme.dim}>
        {"  "}
        <span fg={theme.green}>[y]</span> approve{"   "}
        <span fg={theme.error}>[n/enter]</span> deny
      </text>
    </box>
  );
}

/**
 * Right side of the status line: context fill (green → white → pink as the
 * window fills toward compaction) and effective generation speed. Appears
 * after the first turn; the Hermes-dashboard corner of the UI.
 */
function StatusGauges({ stats }: { stats: TurnStats }) {
  if (!stats.promptTokens) return <text> </text>;
  const frac = contextFraction(stats);
  const pct = Math.round(frac * 100);
  const ctxColor = frac < 0.6 ? theme.green : frac < 0.85 ? theme.soft : theme.pink;
  const tps = tokensPerSecond(stats);
  return (
    <text wrapMode="none">
      {tps > 0 ? <span fg={theme.faint}>{`~${tps.toFixed(0)} tok/s  `}</span> : null}
      {stats.firstTokenMs !== undefined ? <span fg={theme.faint}>{`first ${(stats.firstTokenMs / 1000).toFixed(1)}s  `}</span> : null}
      <span fg={theme.faint}>{"ctx "}</span>
      <span fg={ctxColor}>{`${pct}%`}</span>
    </text>
  );
}

function nextMode(mode: Mode): Mode {
  if (mode === "normal") return "plan";
  if (mode === "plan") return "build";
  return "normal";
}

function modeLabel(mode: Mode): string {
  if (mode === "plan") return "[ PLAN ]";
  if (mode === "build") return "[ BUILD ]";
  return "[ NORMAL ]";
}

function placeholderForMode(mode: Mode): string {
  if (mode === "plan") return "Describe what you want to plan…";
  if (mode === "build") return "Describe the local coding task…";
  return "Ask Sophie anything…";
}

function hint(mode: Mode, audioMode: boolean): string {
  if (audioMode) return "audio mode · Sophie speaks every reply · Shift+Tab to normal";
  if (mode === "plan") return "plan mode · read-only · Shift+Tab to build";
  if (mode === "build") return "build mode · local coding · thinking on · Shift+Tab to audio";
  return "normal mode · Shift+Tab to plan";
}

function statusHint(mode: Mode, audioMode: boolean, busy: boolean, reviewingHistory: boolean): string {
  if (busy) return "type a steering note to redirect next step · esc to interrupt · mouse or PgUp/PgDn scroll transcript";
  if (reviewingHistory) return "reviewing history · scroll down or PgDn returns toward latest";
  return `${hint(mode, audioMode)} · mouse or PgUp/PgDn scroll history`;
}

function clip(s: string, n = 120): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > n ? oneLine.slice(0, n) + "…" : oneLine;
}
