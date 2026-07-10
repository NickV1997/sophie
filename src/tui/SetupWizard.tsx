import { useKeyboard } from "@opentui/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { config } from "../config.ts";
import { PROFILE_QUESTIONS, readProfile, saveProfileAnswers } from "../memory/profile.ts";
import { readEnvFile, writeEnv, ENV_KEYS, missingRequiredSetupEnv } from "../system/env.ts";
import { machineWelcome, markOnboarded } from "../system/onboarding.ts";
import {
  captureTelegramChatId,
  startTelegramBridge,
  stopTelegramBridge,
  telegramReady,
} from "../channels/telegram.ts";
import { SPINNER, theme } from "./theme.ts";

/**
 * Sophie's setup wizard. A full-screen, step-by-step form (styled after the
 * openclaw wizard) that writes every .env value. Opened automatically on first
 * run (until onboarding completes) and on demand via /setup. Telegram is wired
 * live: after the user enters a bot token, the wizard listens for their "hi
 * sophie" message and captures the chat id automatically.
 */

type Group = "You" | "Model" | "Speech" | "Telegram" | "Email" | "Presence" | "Search" | "Advanced";

type Step =
  | { kind: "welcome" }
  | { kind: "review" }
  | { kind: "info"; group: Group; title: string; help?: string; lines: string[] }
  | { kind: "telegram"; group: Group; title: string }
  | {
      kind: "text";
      key: string;
      group: Group;
      title: string;
      help?: string;
      placeholder?: string;
      secret?: boolean;
      optional?: boolean;
    }
  | {
      kind: "number";
      key: string;
      group: Group;
      title: string;
      help?: string;
      placeholder?: string;
    }
  | { kind: "toggle"; key: string; group: Group; title: string; help?: string }
  | {
      kind: "select";
      key: string;
      group: Group;
      title: string;
      help?: string;
      options: { value: string; label: string }[];
    };

/** Getting-to-know-you steps, one per profile question. All REQUIRED — setup
 * doesn't complete until each has an answer ("none" is a fine answer). Answers
 * land in ~/.sophie/profile.json (+ fact memory), never in .env. */
const PROFILE_STEPS: Step[] = PROFILE_QUESTIONS.map((q) => ({
  kind: "text",
  key: q.key,
  group: "You",
  title: q.question,
  help: q.help,
  placeholder: q.placeholder,
}));
const PROFILE_KEYS = new Set(PROFILE_QUESTIONS.map((q) => q.key));

/** First step whose profile answer is still blank, or -1 when all answered. */
function firstMissingProfileStep(values: Record<string, string>): number {
  return STEPS.findIndex((s) => "key" in s && PROFILE_KEYS.has(s.key) && !(values[s.key] ?? "").trim());
}

function firstStepForKey(key: string): number {
  return STEPS.findIndex((s) => "key" in s && s.key === key);
}

const STEPS: Step[] = [
  { kind: "welcome" },

  ...PROFILE_STEPS,

  { kind: "text", key: "SOPHIE_BASE_URL", group: "Model", title: "Local model URL",
    help: "Your OpenAI-compatible endpoint — Ollama http://localhost:11434/v1, llama.cpp :8080/v1, LM Studio :1234/v1." },
  { kind: "text", key: "SOPHIE_MODEL", group: "Model", title: "Model name",
    help: "The id the server reports (llama.cpp ignores it and uses whatever is loaded)." },
  { kind: "text", key: "SOPHIE_API_KEY", group: "Model", title: "API key",
    help: "Local servers ignore this — any non-empty value is fine." },

  { kind: "toggle", key: "SOPHIE_SPEAK_REPLIES", group: "Speech", title: "Speak replies aloud by default?",
    help: "The speak tool always works on demand either way." },
  { kind: "select", key: "SOPHIE_TTS_BACKEND", group: "Speech", title: "Speech engine",
    help: "sidecar = Sophie's local Kokoro TTS server; macos = the built-in `say` voice.",
    options: [{ value: "sidecar", label: "sidecar (Sophie Kokoro)" }, { value: "macos", label: "macOS say" }] },
  { kind: "text", key: "SOPHIE_TTS_BASE_URL", group: "Speech", title: "Speech server URL",
    help: "Where the TTS sidecar listens. Only used when the engine is 'sidecar'.", optional: true },
  { kind: "toggle", key: "SOPHIE_TTS_AUTOSTART", group: "Speech", title: "Start Kokoro with Sophie?",
    help: "When on, the sophie command starts and stops the local TTS server." },
  { kind: "text", key: "SOPHIE_SPEAK_VOICE", group: "Speech", title: "Voice",
    help: "macOS voice name (e.g. Samantha) or the sidecar voice id. Blank = engine default.", optional: true },
  { kind: "toggle", key: "SOPHIE_TTS_STREAM_REPLIES", group: "Speech", title: "Stream speech as she types?",
    help: "Speak sentences as they arrive instead of waiting for the full reply." },

  { kind: "text", key: "TELEGRAM_BOT_TOKEN", group: "Telegram", title: "Telegram bot token", secret: true, optional: true,
    help: "From @BotFather (/newbot). Lets Sophie reach your phone. Leave blank to skip Telegram." },
  { kind: "telegram", group: "Telegram", title: "Link your chat" },

  { kind: "text", key: "SOPHIE_EMAIL_ADDRESS", group: "Email", title: "Your Gmail address",
    help: "Enter the Gmail address Sophie should use, like you@gmail.com. This is required so Sophie knows which mailbox she is managing." },
  { kind: "info", group: "Email", title: "Gmail app password",
    help: "Sophie uses a Gmail app password for local IMAP/SMTP email access. No browser sign-in flow is required.",
    lines: [
      "1. Open this page in your browser: https://myaccount.google.com/apppasswords",
      "2. Sign in with the same Gmail account you entered.",
      "3. If Google asks, turn on 2-Step Verification first.",
      "4. Create an app password named Sophie.",
      "5. Copy the 16-character password Google shows.",
      "6. Press Enter here, then paste that app password on the next screen.",
    ] },
  { kind: "text", key: "SOPHIE_EMAIL_APP_PASSWORD", group: "Email", title: "Gmail app password", secret: true,
    help: "Paste the 16-character Gmail app password. Sophie stores it locally in .env for IMAP/SMTP email access." },
  { kind: "text", key: "SOPHIE_EMAIL_IMAP_HOST", group: "Email", title: "Gmail IMAP host",
    help: "Use imap.gmail.com unless you are configuring a different mail provider." },
  { kind: "number", key: "SOPHIE_EMAIL_IMAP_PORT", group: "Email", title: "Gmail IMAP port",
    help: "Use 993 for Gmail IMAP over TLS." },
  { kind: "text", key: "SOPHIE_EMAIL_SMTP_HOST", group: "Email", title: "Gmail SMTP host",
    help: "Use smtp.gmail.com unless you are configuring a different mail provider." },
  { kind: "number", key: "SOPHIE_EMAIL_SMTP_PORT", group: "Email", title: "Gmail SMTP port",
    help: "Use 465 for Gmail SMTP over TLS." },

  { kind: "number", key: "SOPHIE_AWAY_MINUTES", group: "Presence", title: "Go 'away' after how many minutes idle?",
    help: "When away, Sophie reaches you over Telegram/notifications instead of the screen." },

  { kind: "text", key: "TAVILY_API_KEY", group: "Search", title: "Tavily API key", secret: true, optional: true,
    help: "Search key #1 (optional, preferred). web_search works keyless via DuckDuckGo too. https://app.tavily.com" },
  { kind: "text", key: "BRAVE_API_KEY", group: "Search", title: "Brave API key", secret: true, optional: true,
    help: "Search key #2 (optional). https://api-dashboard.search.brave.com" },

  { kind: "select", key: "SOPHIE_DEFAULT_MODE", group: "Advanced", title: "Default mode on launch",
    options: [
      { value: "normal", label: "normal (fast, can act)" },
      { value: "plan", label: "plan (think first, read-only)" },
      { value: "build", label: "build (plan → build an MVP, auto-exit)" },
    ] },
  { kind: "number", key: "SOPHIE_TEMPERATURE", group: "Advanced", title: "Temperature",
    help: "Qwen3 recommends ~0.6 for thinking, ~0.7 for chat." },
  { kind: "number", key: "SOPHIE_TOP_P", group: "Advanced", title: "Top-p" },
  { kind: "number", key: "SOPHIE_MAX_TOKENS", group: "Advanced", title: "Max tokens per reply" },
  { kind: "number", key: "SOPHIE_CONTEXT_WINDOW", group: "Advanced", title: "Context window",
    help: "Token budget before Sophie trims old turns. Match your server's -c." },
  { kind: "number", key: "SOPHIE_TIMEOUT_MS", group: "Advanced", title: "Request timeout (ms)",
    help: "Local models can be slow to first token; 600000 = 10 minutes." },

  { kind: "review" },
];

/** Fields that carry a value into .env, for building the initial + save maps. */
const VALUE_STEPS = STEPS.filter(
  (s): s is Extract<Step, { key: string }> => "key" in s,
);

function initialValues(): Record<string, string> {
  const env = readEnvFile();
  const fallback: Record<string, string> = {
    SOPHIE_BASE_URL: config.baseUrl,
    SOPHIE_MODEL: config.model,
    SOPHIE_API_KEY: config.apiKey,
    SOPHIE_SPEAK_REPLIES: String(config.speakReplies),
    SOPHIE_TTS_BACKEND: config.ttsBackend,
    SOPHIE_TTS_BASE_URL: config.ttsBaseUrl,
    SOPHIE_TTS_AUTOSTART: String(config.ttsAutostart),
    SOPHIE_SPEAK_VOICE: config.speakVoice,
    SOPHIE_TTS_STREAM_REPLIES: String(config.ttsStreamReplies),
    SOPHIE_AWAY_MINUTES: String(process.env.SOPHIE_AWAY_MINUTES ?? 5),
    SOPHIE_DEFAULT_MODE: config.defaultMode,
    SOPHIE_TEMPERATURE: String(config.temperature),
    SOPHIE_TOP_P: String(config.topP),
    SOPHIE_MAX_TOKENS: String(config.maxTokens),
    SOPHIE_CONTEXT_WINDOW: String(config.contextWindow),
    SOPHIE_TIMEOUT_MS: String(config.timeoutMs),
    TELEGRAM_BOT_TOKEN: "",
    TELEGRAM_CHAT_ID: "",
    SOPHIE_EMAIL_ADDRESS: config.emailAddress,
    SOPHIE_EMAIL_APP_PASSWORD: config.emailAppPassword,
    SOPHIE_EMAIL_IMAP_HOST: config.emailImapHost,
    SOPHIE_EMAIL_IMAP_PORT: String(config.emailImapPort),
    SOPHIE_EMAIL_SMTP_HOST: config.emailSmtpHost,
    SOPHIE_EMAIL_SMTP_PORT: String(config.emailSmtpPort),
    TAVILY_API_KEY: "",
    BRAVE_API_KEY: "",
  };
  const out: Record<string, string> = {};
  for (const key of ENV_KEYS) out[key] = env[key] ?? fallback[key] ?? "";
  // Profile answers (re-running /setup shows what's already saved).
  const profile = readProfile();
  for (const key of PROFILE_KEYS) out[key] = profile[key] ?? "";
  return out;
}

function mask(value: string): string {
  if (!value) return "(not set)";
  if (value.length <= 6) return "••••";
  return `${value.slice(0, 4)}…${value.slice(-2)}`;
}

type TgStatus = "idle" | "waiting" | "done" | "skipped" | "failed";

export function SetupWizard({
  firstRun,
  onDone,
}: {
  firstRun: boolean;
  onDone: (summary: string) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(initialValues);
  const [index, setIndex] = useState(0);
  const [selCursor, setSelCursor] = useState(0);
  const [notice, setNotice] = useState("");
  const [tgStatus, setTgStatus] = useState<TgStatus>("idle");
  const captureRef = useRef<AbortController | null>(null);
  const savedRef = useRef(false);

  const step = STEPS[index];
  const total = STEPS.length;

  const setValue = useCallback((key: string, value: string) => {
    setNotice("");
    setValues((v) => ({ ...v, [key]: value }));
  }, []);

  // Keep the selection cursor aligned with the stored value on toggle/select.
  useEffect(() => {
    setNotice("");
    if (step.kind === "toggle") {
      setSelCursor(values[step.key] === "true" ? 0 : 1);
    } else if (step.kind === "select") {
      const i = step.options.findIndex((o) => o.value === values[step.key]);
      setSelCursor(i < 0 ? 0 : i);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  const save = useCallback(() => {
    if (savedRef.current) return;
    // Setup can't finish with unanswered profile questions — jump to the first
    // blank one instead of saving, so Ctrl+S can't skip past them either.
    const missing = firstMissingProfileStep(values);
    if (missing !== -1) {
      setIndex(missing);
      setNotice('Needed before setup can finish — type "none" if it doesn\'t apply.');
      return;
    }
    const missingEnv = missingRequiredSetupEnv(values);
    if (missingEnv.length) {
      const i = firstStepForKey(missingEnv[0]);
      if (i !== -1) setIndex(i);
      setNotice(`${missingEnv[0]} is required before Sophie can start normally.`);
      return;
    }
    savedRef.current = true;
    const updates: Record<string, string> = {};
    for (const key of ENV_KEYS) updates[key] = (values[key] ?? "").trim();
    writeEnv(updates);
    // Profile answers go to ~/.sophie/profile.json + fact memory, not .env.
    const answers: Record<string, string> = {};
    for (const key of PROFILE_KEYS) answers[key] = (values[key] ?? "").trim();
    const profileSaved = saveProfileAnswers(answers, process.cwd());
    // Completing the wizard counts as onboarding. The wizard stops reappearing
    // on launch only once this flag is set AND every profile question is
    // answered (isSetupComplete reads both; the guard above ensures the latter).
    markOnboarded();
    // (Re)start the Telegram bridge if it's now fully wired.
    stopTelegramBridge();
    if (telegramReady()) startTelegramBridge();
    const bits = [
      updates.SOPHIE_BASE_URL && `model → ${updates.SOPHIE_MODEL || "server default"}`,
      profileSaved ? `${profileSaved} profile answer${profileSaved === 1 ? "" : "s"} remembered` : null,
      telegramReady() ? "Telegram linked" : updates.TELEGRAM_BOT_TOKEN ? "Telegram token saved" : null,
      updates.SOPHIE_EMAIL_ADDRESS ? "email configured" : null,
      updates.TAVILY_API_KEY || updates.BRAVE_API_KEY ? "search keys set" : null,
    ].filter(Boolean);
    onDone(`Setup saved to .env${bits.length ? ` — ${bits.join(", ")}.` : "."} Restart Sophie to apply the model/speech changes.`);
  }, [values, onDone]);

  // ── Telegram capture: runs when we land on the link step with a token set ──
  useEffect(() => {
    if (step.kind !== "telegram") return;
    const token = (values.TELEGRAM_BOT_TOKEN ?? "").trim();
    if (!token) {
      setTgStatus("skipped");
      return;
    }
    if ((values.TELEGRAM_CHAT_ID ?? "").trim()) {
      setTgStatus("done");
      return;
    }
    setTgStatus("waiting");
    const controller = new AbortController();
    captureRef.current = controller;
    void captureTelegramChatId(token, { timeoutMs: 5 * 60_000, signal: controller.signal }).then(
      (res) => {
        if (controller.signal.aborted) return;
        if (res) {
          setValue("TELEGRAM_CHAT_ID", res.chatId);
          setTgStatus("done");
        } else {
          setTgStatus("failed");
        }
      },
    );
    return () => {
      controller.abort();
      captureRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  const goNext = useCallback(() => {
    if (step.kind === "review") {
      save();
      return;
    }
    // Profile questions are required — Enter on a blank one doesn't advance.
    if ("key" in step && PROFILE_KEYS.has(step.key) && !(values[step.key] ?? "").trim()) {
      setNotice('Required — type "none" if it doesn\'t apply.');
      return;
    }
    if ("key" in step && missingRequiredSetupEnv(values).includes(step.key as any)) {
      setNotice(`${step.key} is required before Sophie can start normally.`);
      return;
    }
    captureRef.current?.abort();
    setIndex((i) => Math.min(total - 1, i + 1));
  }, [step, save, total, values]);

  const goBack = useCallback(() => {
    captureRef.current?.abort();
    setIndex((i) => Math.max(0, i - 1));
  }, []);

  const commitSelection = useCallback(() => {
    if (step.kind === "toggle") setValue(step.key, selCursor === 0 ? "true" : "false");
    else if (step.kind === "select") setValue(step.key, step.options[selCursor].value);
  }, [step, selCursor, setValue]);

  const isText = step.kind === "text" || step.kind === "number";

  useKeyboard((key) => {
    if (key.ctrl && (key.name === "c" || key.name === "d")) process.exit(0);
    if (key.ctrl && key.name === "s") {
      commitSelection();
      save();
      return;
    }
    if (key.ctrl && key.name === "b") {
      goBack();
      return;
    }
    if (key.name === "escape") {
      if (index === 0 && firstRun) return; // can't escape the very first onboarding step
      if (index === 0) {
        onDone("Setup cancelled — no changes saved.");
        return;
      }
      goBack();
      return;
    }
    // Text/number steps: the focused <input> owns typing + Enter (→ onSubmit).
    if (isText) return;

    if (step.kind === "toggle") {
      if (key.name === "up" || key.name === "down") {
        setSelCursor((c) => (c === 0 ? 1 : 0));
        return;
      }
    } else if (step.kind === "select") {
      if (key.name === "up") {
        setSelCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.name === "down") {
        setSelCursor((c) => Math.min(step.options.length - 1, c + 1));
        return;
      }
    }
    if (key.name === "return") {
      commitSelection();
      goNext();
    }
  });

  return (
    <box style={{ flexDirection: "column", height: "100%", backgroundColor: theme.bg }}>
      <WizardHeader index={index} total={total} />
      <box
        style={{
          flexGrow: 1,
          flexDirection: "column",
          marginLeft: 2,
          marginRight: 2,
          marginTop: 1,
          border: true,
          borderColor: theme.border,
          backgroundColor: theme.panel,
          paddingLeft: 2,
          paddingRight: 2,
          paddingTop: 1,
          paddingBottom: 1,
        }}
      >
        <StepBody
          step={step}
          values={values}
          selCursor={selCursor}
          tgStatus={tgStatus}
          setValue={setValue}
          onSubmit={goNext}
        />
      </box>
      <box style={{ flexDirection: "row", paddingLeft: 2, paddingRight: 2, height: 1, flexShrink: 0, paddingTop: 0 }}>
        <text fg={notice ? theme.warn : theme.dim}>{notice || footerHint(step, firstRun, index)}</text>
      </box>
    </box>
  );
}

function WizardHeader({ index, total }: { index: number; total: number }) {
  return (
    <box
      style={{
        flexDirection: "row",
        justifyContent: "space-between",
        paddingLeft: 2,
        paddingRight: 2,
        paddingTop: 1,
        height: 2,
        flexShrink: 0,
      }}
    >
      <text>
        <span fg={theme.pink}>{"▚▚ "}</span>
        <span fg={theme.text}>SOPHIE</span>
        <span fg={theme.faint}>{" // "}</span>
        <span fg={theme.dim}>SETUP</span>
      </text>
      <text fg={theme.dim}>{`step ${index + 1}/${total}`}</text>
    </box>
  );
}

function StepBody({
  step,
  values,
  selCursor,
  tgStatus,
  setValue,
  onSubmit,
}: {
  step: Step;
  values: Record<string, string>;
  selCursor: number;
  tgStatus: TgStatus;
  setValue: (key: string, value: string) => void;
  onSubmit: () => void;
}) {
  if (step.kind === "welcome") {
    return (
      <box style={{ flexDirection: "column" }}>
        <text fg={theme.pinkSoft}><b>Welcome to Sophie</b></text>
        <box style={{ paddingTop: 1 }}>
          <text fg={theme.soft} wrapMode="word">
            Let's get you set up. First a few quick questions about you — your routine,
            favorites, pets — so I can plan your day and make suggestions that actually fit
            you. These need an answer (type "none" if one doesn't apply). Then your local
            model, speech, Telegram, and a couple of options for .env, where Enter keeps
            the shown default.
          </text>
        </box>
        <box style={{ paddingTop: 1 }}>
          <text fg={theme.dim}>{`This machine: ${machineWelcome()}`}</text>
        </box>
        <box style={{ paddingTop: 1 }}>
          <text fg={theme.faint}>Enter to begin · Ctrl+S to skip to the end with defaults</text>
        </box>
      </box>
    );
  }

  if (step.kind === "review") {
    return (
      <box style={{ flexDirection: "column" }}>
        <text fg={theme.green}><b>Review & save</b></text>
        <box style={{ paddingTop: 1, flexDirection: "column" }}>
          {VALUE_STEPS.map((s) => {
            const secret = s.kind === "text" && s.secret;
            const raw = values[s.key] ?? "";
            const shown = secret ? mask(raw) : raw || (PROFILE_KEYS.has(s.key) ? "(skipped)" : "(default)");
            return (
              <text key={s.key} wrapMode="none">
                <span fg={theme.dim}>{`${s.key.padEnd(22)} `}</span>
                <span fg={raw ? theme.soft : theme.faint}>{shown}</span>
              </text>
            );
          })}
          {values.TELEGRAM_CHAT_ID ? (
            <text wrapMode="none">
              <span fg={theme.dim}>{`${"TELEGRAM_CHAT_ID".padEnd(22)} `}</span>
              <span fg={theme.green}>{values.TELEGRAM_CHAT_ID}</span>
            </text>
          ) : null}
        </box>
        <box style={{ paddingTop: 1 }}>
          <text fg={theme.pinkSoft}>Press Enter or Ctrl+S to save to .env.</text>
        </box>
      </box>
    );
  }

  const group = "group" in step ? step.group : "";
  const title = "title" in step ? step.title : "";
  const help = "help" in step ? step.help : undefined;

  return (
    <box style={{ flexDirection: "column" }}>
      <text fg={theme.pinkSoft} wrapMode="none">{`❯ ${group}`}</text>
      <box style={{ paddingTop: 1 }}>
        <text fg={theme.text} wrapMode="word"><b>{title}</b></text>
      </box>
      {help ? (
        <box style={{ paddingTop: 0 }}>
          <text fg={theme.dim} wrapMode="word">{help}</text>
        </box>
      ) : null}

      <box style={{ paddingTop: 1, flexDirection: "column" }}>
        {step.kind === "info" ? (
          <InfoPage lines={step.lines} />
        ) : step.kind === "text" || step.kind === "number" ? (
          <TextField step={step} value={values[step.key] ?? ""} setValue={setValue} onSubmit={onSubmit} />
        ) : step.kind === "toggle" ? (
          <OptionList
            options={[{ value: "true", label: "Yes" }, { value: "false", label: "No" }]}
            cursor={selCursor}
          />
        ) : step.kind === "select" ? (
          <OptionList options={step.options} cursor={selCursor} />
        ) : step.kind === "telegram" ? (
          <TelegramLink status={tgStatus} chatId={values.TELEGRAM_CHAT_ID ?? ""} />
        ) : null}
      </box>
    </box>
  );
}

function InfoPage({ lines }: { lines: string[] }) {
  return (
    <box style={{ flexDirection: "column" }}>
      {lines.map((line) => (
        <box key={line} style={{ paddingBottom: 0 }}>
          <text fg={theme.soft} wrapMode="word">{line}</text>
        </box>
      ))}
      <box style={{ paddingTop: 1 }}>
        <text fg={theme.faint}>Take your time. Press Enter when this page is done.</text>
      </box>
    </box>
  );
}

function TextField({
  step,
  value,
  setValue,
  onSubmit,
}: {
  step: Extract<Step, { kind: "text" | "number" }>;
  value: string;
  setValue: (key: string, value: string) => void;
  onSubmit: () => void;
}) {
  const optional = step.kind === "text" && step.optional;
  const secret = step.kind === "text" && step.secret;
  return (
    <box style={{ flexDirection: "column" }}>
      <box
        style={{
          height: 3,
          paddingLeft: 1,
          paddingRight: 1,
          border: true,
          borderColor: theme.pink,
          backgroundColor: theme.prompt,
        }}
      >
        <input
          key={step.key}
          focused
          value={value}
          placeholder={step.placeholder ?? (optional ? "(optional — leave blank to skip)" : "")}
          backgroundColor={theme.prompt}
          textColor={theme.text}
          placeholderColor={theme.dim}
          focusedBackgroundColor={theme.prompt}
          focusedTextColor={theme.text}
          onInput={(v: string | unknown) => setValue(step.key, typeof v === "string" ? v : "")}
          onSubmit={() => onSubmit()}
        />
      </box>
      <box style={{ paddingTop: 0 }}>
        <text fg={theme.faint}>
          {PROFILE_KEYS.has(step.key) ? 'required — answer "none" if it doesn\'t apply · ' : ""}
          {secret ? "stored in .env · " : ""}
          {step.kind === "number" ? "numbers only · " : ""}
          Enter to continue
        </text>
      </box>
    </box>
  );
}

function OptionList({
  options,
  cursor,
}: {
  options: { value: string; label: string }[];
  cursor: number;
}) {
  return (
    <box style={{ flexDirection: "column" }}>
      <text wrapMode="none">
        {options.map((o, i) => {
          const sel = i === cursor;
          return (
            <span key={o.value}>
              <span fg={sel ? theme.green : theme.faint}>{sel ? "❯ " : "  "}</span>
              <span fg={sel ? theme.text : theme.dim}>{o.label}</span>
              {i < options.length - 1 ? <br /> : null}
            </span>
          );
        })}
      </text>
      <box style={{ paddingTop: 1 }}>
        <text fg={theme.faint}>↑/↓ to choose · Enter to continue</text>
      </box>
    </box>
  );
}

function TelegramLink({ status, chatId }: { status: TgStatus; chatId: string }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (status !== "waiting") return;
    const t = setInterval(() => setTick((x) => x + 1), 100);
    return () => clearInterval(t);
  }, [status]);

  if (status === "skipped") {
    return (
      <text fg={theme.dim} wrapMode="word">
        No bot token entered — skipping Telegram. Press Enter to continue. (You can run /setup again later.)
      </text>
    );
  }
  if (status === "done") {
    return (
      <box style={{ flexDirection: "column" }}>
        <text fg={theme.green}>{`✓ Linked! Chat id ${chatId} captured and saved.`}</text>
        <box style={{ paddingTop: 1 }}>
          <text fg={theme.faint}>Enter to continue</text>
        </box>
      </box>
    );
  }
  if (status === "failed") {
    return (
      <box style={{ flexDirection: "column" }}>
        <text fg={theme.warn} wrapMode="word">
          Didn't catch a message in time. You can still finish setup — message the bot later and
          Sophie will capture your chat id on the next run.
        </text>
        <box style={{ paddingTop: 1 }}>
          <text fg={theme.faint}>Enter to continue</text>
        </box>
      </box>
    );
  }
  // waiting
  const frame = SPINNER[tick % SPINNER.length];
  return (
    <box style={{ flexDirection: "column" }}>
      <text fg={theme.text} wrapMode="word">
        Open Telegram, find your new bot, and send it a message — try{" "}
        <span fg={theme.pinkSoft}>“hi sophie”</span>.
      </text>
      <box style={{ paddingTop: 1, flexDirection: "row" }}>
        <text fg={theme.green}>{`${frame} `}</text>
        <text fg={theme.pinkSoft}>Listening for your message…</text>
      </box>
      <box style={{ paddingTop: 1 }}>
        <text fg={theme.faint}>Enter to skip and finish later</text>
      </box>
    </box>
  );
}

function footerHint(step: Step, firstRun: boolean, index: number): string {
  const back = index > 0 ? "Ctrl+B back · " : "";
  const cancel = firstRun ? "" : index === 0 ? "Esc cancel · " : "Esc back · ";
  if (step.kind === "review") return `${back}${cancel}Enter/Ctrl+S save & finish · Ctrl+C quit`;
  return `${back}${cancel}Ctrl+S save now with defaults · Ctrl+C quit`;
}
