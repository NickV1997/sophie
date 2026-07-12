import { existsSync } from "node:fs";
import {
  addWatcher,
  cancelWatcher,
  listWatchers,
  setWatcherEnabled,
  type WatchAction,
  type WatchItem,
} from "../agent/watcher.ts";
import { expandHome } from "../system/paths.ts";
import type { Tool } from "./types.ts";

function renderItem(i: WatchItem): string {
  const what = i.action === "run" ? `run: ${i.prompt}` : `notify: ${i.message}`;
  const filter = i.glob ? ` · glob ${i.glob}` : "";
  const state = i.enabled ? "" : " [disabled]";
  const last = i.lastFiredAt ? ` · last fired ${new Date(i.lastFiredAt).toLocaleString()}` : "";
  return `- ${i.id} · ${i.title} · watches ${i.path}${filter} · ${what}${state}${last}`;
}

/**
 * Event triggers — the scheduler's sibling. Where schedule fires at a TIME,
 * watch_path fires on a CHANGE (something lands in ~/Downloads, a log grows,
 * a shared folder updates) while Sophie's terminal app is running.
 */
export const watchPath: Tool = {
  name: "watch_path",
  description:
    "Watch a file or folder and react when it changes — the event-driven sibling of schedule. " +
    "action 'add' creates a watcher on 'path' (optional 'glob' filter like '*.pdf'); when something " +
    "changes it either notifies the user (do='notify' with message) or wakes you to act (do='run' " +
    "with a prompt — the changed file paths are appended to it). Also 'list', 'cancel' (id), " +
    "'enable'/'disable' (id). Watchers persist and are live whenever Sophie is running.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["add", "list", "cancel", "enable", "disable"], description: "Operation." },
      path: { type: "string", description: "add: file or directory to watch, e.g. ~/Downloads." },
      title: { type: "string", description: "add: short label for the watcher." },
      do: {
        type: "string",
        enum: ["notify", "run"],
        description: "On change: 'notify' the user with a message, or 'run' a task described by prompt. Default notify.",
      },
      message: { type: "string", description: "Message to send when do='notify' (changed paths are appended)." },
      prompt: { type: "string", description: "Instruction for Sophie when do='run' (changed paths are appended)." },
      glob: { type: "string", description: "Only fire for matching file names, e.g. '*.pdf' (optional)." },
      debounce_seconds: { type: "number", description: "Quiet period after the last change before firing (default 2)." },
      id: { type: "string", description: "Target id for cancel/enable/disable." },
    },
    required: ["action"],
  },
  summarize: (a) => {
    const action = String(a.action ?? "list");
    if (action === "add") return `watch ${a.path}${a.glob ? ` (${a.glob})` : ""}`;
    return a.id ? `${action} ${a.id}` : action;
  },
  risk: (a) => {
    const action = String(a.action ?? "list");
    if (["cancel", "enable", "disable"].includes(action)) return "caution";
    return action === "add" && a.do === "run" ? "caution" : "safe";
  },
  async execute(args) {
    const action = String(args.action ?? "list");

    if (action === "list") {
      const list = listWatchers();
      return {
        content: list.length ? `Watchers:\n${list.map(renderItem).join("\n")}` : "No watchers set.",
        display: `${list.filter((i) => i.enabled).length} active`,
      };
    }

    if (action === "cancel") {
      const id = String(args.id ?? "").trim();
      if (!id) return { content: "cancel needs an id.", isError: true };
      return cancelWatcher(id)
        ? { content: `Cancelled watcher ${id}.`, display: `cancelled ${id}` }
        : { content: `No watcher with id ${id}.`, isError: true };
    }

    if (action === "enable" || action === "disable") {
      const id = String(args.id ?? "").trim();
      if (!id) return { content: `${action} needs an id.`, isError: true };
      const item = setWatcherEnabled(id, action === "enable");
      return item
        ? { content: `${action === "enable" ? "Enabled" : "Disabled"} ${id}.`, display: `${action}d ${id}` }
        : { content: `No watcher with id ${id}.`, isError: true };
    }

    if (action !== "add") return { content: `Unknown watch_path action "${action}".`, isError: true };

    // ── add ──
    const path = String(args.path ?? "").trim();
    if (!path) return { content: "add needs a path to watch.", isError: true };
    if (!existsSync(expandHome(path))) return { content: `Path not found: ${path}.`, isError: true };
    const doAction = (args.do === "run" ? "run" : "notify") as WatchAction;
    const message = typeof args.message === "string" ? args.message.trim() : "";
    const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
    if (doAction === "notify" && !message) return { content: "A 'notify' watcher needs a message.", isError: true };
    if (doAction === "run" && !prompt) return { content: "A 'run' watcher needs a prompt.", isError: true };
    const title = String(args.title ?? "").trim() || `watch ${path}`;
    const debounceSec = Number(args.debounce_seconds);
    const item = addWatcher({
      path,
      action: doAction,
      title,
      message,
      prompt,
      glob: typeof args.glob === "string" ? args.glob : undefined,
      debounceMs: Number.isFinite(debounceSec) && debounceSec > 0 ? debounceSec * 1000 : undefined,
      authorization: doAction === "run" ? { createdBy: "user", instruction: prompt, allowedCapabilities: ["read_public", "read_private"], outwardAllowed: false, approvedAt: Date.now() } : undefined,
    });
    return {
      content: `Watcher set (live while Sophie is running):\n${renderItem(item)}`,
      display: `watching ${path}`,
    };
  },
};
