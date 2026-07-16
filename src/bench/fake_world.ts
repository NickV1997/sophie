import { getTool } from "../tools/registry.ts";
import { fmtRange } from "../calendar/store.ts";
import type { Tool, ToolResult } from "../tools/types.ts";
import type { WorldEvent, WorldMail, WorldMessage } from "./real_world_scenarios.ts";

export interface WorldAction { tool: string; action: string; args: Record<string, unknown>; at: string; }
export interface FakeWorldState {
  now: string; emails: WorldMail[]; messages: WorldMessage[]; events: WorldEvent[];
  drafts: Array<{ id: string; to: string[]; subject: string; body: string }>;
  notifications: string[]; actions: WorldAction[];
  schedules: Array<{ id: string; args: Record<string, unknown> }>;
  delegations: Array<{ id: string; args: Record<string, unknown> }>;
  faults: Array<{ tool: string; action?: string; message: string; remaining: number }>;
}
export interface FakeWorldHandle {
  state: FakeWorldState;
  setDay(day: number): void;
  inject(update: { now?: string; emails?: WorldMail[]; messages?: WorldMessage[]; events?: WorldEvent[] }): void;
  setFaults(faults: Array<{ tool: string; action?: string; message: string; times?: number }>): void;
  uninstall(): void;
}

interface FakeWorldScenario {
  seed: {
    now: string; emails: WorldMail[]; messages: WorldMessage[]; events: WorldEvent[];
    research?: Record<string, string>; weather?: string; systemInfo?: string;
  };
}

const WORLD_TOOLS = [
  "email", "apple", "messages_recent", "messages_search", "messages_send",
  "calendar", "calendar_list", "calendar_search", "calendar_find_free",
  "notify", "current_time", "weather", "web_search", "web_fetch",
  "http_request", "system_info", "where_am_i", "schedule", "schedule_list", "delegate", "activity",
];
const list = (value: unknown) => Array.isArray(value) ? value.map(String) : String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
const lower = (value: unknown) => String(value ?? "").toLowerCase();

function eventLines(events: WorldEvent[]): string {
  return events.length ? events.map((event) => {
    const start = new Date(event.start).getTime();
    const end = new Date(event.end).getTime();
    const range = Number.isFinite(start) && Number.isFinite(end) ? fmtRange(start, end) : `${event.start}–${event.end}`;
    return `${event.id} | ${event.title} | ${range}${event.attendees?.length ? ` | ${event.attendees.join(", ")}` : ""}`;
  }).join("\n") : "No events in this range.";
}
function mailLines(emails: WorldMail[]): string {
  return emails.length ? emails.map((mail) => `UID=${mail.id} | ${mail.from} | ${mail.subject} | Preview: ${mail.body.slice(0, 180).replace(/\s+/g, " ")}`).join("\n") : "No unread messages.";
}
function messageLines(messages: WorldMessage[]): string {
  return messages.length ? messages.map((message) => `${message.id} | ${message.from}: ${message.body}`).join("\n") : "No recent messages.";
}

export function installFakeWorld(scenario: FakeWorldScenario): FakeWorldHandle {
  const state: FakeWorldState = {
    now: scenario.seed.now,
    emails: structuredClone(scenario.seed.emails),
    messages: structuredClone(scenario.seed.messages),
    events: structuredClone(scenario.seed.events),
    drafts: [], notifications: [], actions: [], schedules: [], delegations: [], faults: [],
  };
  const originals = new Map<Tool, Tool["execute"]>();
  for (const name of WORLD_TOOLS) {
    const tool = getTool(name); if (!tool) continue;
    originals.set(tool, tool.execute);
    tool.execute = async (args): Promise<ToolResult> => {
      const action = String(args.action ?? (name === "calendar_list" ? "list" : name === "calendar_find_free" ? "find_free" : name === "http_request" ? String(args.method ?? "GET").toUpperCase() : name));
      state.actions.push({ tool: name, action, args: structuredClone(args), at: state.now });
      const fault = state.faults.find((item) => item.remaining > 0 && item.tool === name && (!item.action || item.action === action));
      if (fault) { fault.remaining--; return { content: fault.message, display: fault.message, isError: true }; }
      if (name === "current_time") return { content: `Current local time: ${state.now}`, display: state.now };
      if (name === "notify") { const message = String(args.message ?? ""); state.notifications.push(message); return { content: "Notification delivered to the fake user's desktop and phone.", display: "fake delivery" }; }
      if (name === "email") return fakeEmail(state, action, args);
      if (name === "apple" || name.startsWith("messages_")) return fakeApple(state, name.startsWith("messages_") ? name : action, args);
      if (name === "calendar" || name.startsWith("calendar_")) return fakeCalendar(state, action, args);
      if (name === "weather") return { content: scenario.seed.weather ?? "Synthetic forecast: mild and clear; no weather alerts.", display: "synthetic weather" };
      if (name === "web_search") return fakeSearch(scenario.seed.research ?? {}, String(args.query ?? ""));
      if (name === "web_fetch") return fakeFetch(scenario.seed.research ?? {}, String(args.url ?? ""));
      if (name === "http_request") return { content: `Synthetic HTTP response for ${String(args.method ?? "GET").toUpperCase()} ${args.url ?? ""}; no network request was made.`, display: "synthetic HTTP" };
      if (name === "system_info") return { content: scenario.seed.systemInfo ?? "Synthetic benchmark computer: 8 CPU cores, 16 GB RAM, local model runtime.", display: "synthetic system" };
      if (name === "where_am_i") return { content: "Synthetic location: Toronto, Ontario, Canada (benchmark only; no IP or location service used).", display: "synthetic location" };
      if (name === "activity") return { content: state.actions.length ? state.actions.map((item, index) => `${index + 1}. ${item.at} | ${item.tool}:${item.action} | succeeded (synthetic)`).join("\n") : "No recorded synthetic activity.", display: `${state.actions.length} synthetic actions` };
      if (name === "schedule_list") return { content: state.schedules.length ? state.schedules.map((item) => `${item.id} | ${JSON.stringify(item.args)}`).join("\n") : "No scheduled items." };
      if (name === "schedule") {
        if (action === "list") return { content: state.schedules.length ? state.schedules.map((item) => `${item.id} | ${JSON.stringify(item.args)}`).join("\n") : "No scheduled items." };
        const item = { id: `schedule-${state.schedules.length + 1}`, args: structuredClone(args) }; state.schedules.push(item);
        return { content: `Synthetic schedule saved: ${item.id}`, display: item.id };
      }
      if (name === "delegate") {
        if (action === "list") return { content: state.delegations.length ? state.delegations.map((item) => `${item.id} | ${JSON.stringify(item.args)}`).join("\n") : "No delegations." };
        const item = { id: `delegation-${state.delegations.length + 1}`, args: structuredClone(args) }; state.delegations.push(item);
        return { content: `Synthetic delegation saved: ${item.id}`, display: item.id };
      }
      return { content: "Fake-world operation completed." };
    };
  }
  return {
    state,
    setDay(day) { const date = new Date(scenario.seed.now); date.setDate(date.getDate() + day - 1); state.now = date.toISOString(); },
    inject(update) {
      if (update.now) state.now = update.now;
      if (update.emails?.length) state.emails.push(...structuredClone(update.emails));
      if (update.messages?.length) state.messages.push(...structuredClone(update.messages));
      if (update.events?.length) state.events.push(...structuredClone(update.events));
    },
    setFaults(faults) { state.faults = faults.map((item) => ({ ...item, remaining: item.times ?? 1 })); },
    uninstall() { for (const [tool, execute] of originals) tool.execute = execute; },
  };
}

const SEARCH_STOP_WORDS = new Set(["about", "after", "against", "assistant", "before", "current", "explain", "general", "information", "practical", "research", "simple", "small", "their", "there", "these", "those", "using", "what", "with"]);

function searchTerms(value: string): Set<string> {
  return new Set(lower(value).split(/[^a-z0-9]+/).filter((word) => word.length >= 4 && !SEARCH_STOP_WORDS.has(word)).map((word) =>
    word.endsWith("ies") ? `${word.slice(0, -3)}y` : word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word
  ));
}

/** Pick the most relevant deterministic corpus entry. Falling back to the
 * first entry silently gave unrelated evidence (for example childcare for a
 * local-model query), which could reward an answer that ignored its source. */
export function fakeSearch(corpus: Record<string, string>, query: string): ToolResult {
  const queryTerms = searchTerms(query);
  const ranked = Object.keys(corpus).map((item, index) => {
    const keyTerms = searchTerms(item.replace(/_/g, " "));
    const bodyTerms = searchTerms(corpus[item]!);
    let score = 0;
    for (const term of queryTerms) {
      if (keyTerms.has(term)) score += 4;
      if (bodyTerms.has(term)) score += 1;
    }
    return { item, index, score };
  }).sort((a, b) => b.score - a.score || a.index - b.index);
  const key = ranked[0]?.score ? ranked[0].item : undefined;
  const text = key ? corpus[key]! : "Synthetic research corpus: verify claims against authoritative sources and state uncertainty.";
  return { content: `1. Synthetic authoritative result\n   https://benchmark.invalid/${key ?? "general"}\n   ${text}\n\n2. Synthetic secondary result\n   https://benchmark.invalid/${key ?? "general"}/guide\n   Cross-check details before acting.`, display: "2 synthetic results" };
}

function fakeFetch(corpus: Record<string, string>, url: string): ToolResult {
  const key = Object.keys(corpus).find((item) => url.includes(item));
  return { content: `Synthetic page (${url})\n\n${key ? corpus[key] : "This deterministic benchmark page recommends authoritative verification, data minimization, and explicit uncertainty."}`, display: "synthetic page" };
}

function fakeEmail(state: FakeWorldState, action: string, args: Record<string, any>): ToolResult {
  if (action === "list_unread" || action === "list_all") return { content: mailLines(action === "list_unread" ? state.emails.filter((mail) => mail.unread) : state.emails), display: `${state.emails.length} fake emails` };
  if (action === "read") { if (!args.uid) return { content: "email read needs uid. Copy the exact UID from the first column of list_unread/list_all.", isError: true }; const mail = state.emails.find((item) => item.id === String(args.uid)); if (!mail) return { content: `Email not found: ${args.uid}`, isError: true }; mail.unread = false; return { content: `UID: ${mail.id}\nFrom: ${mail.from}\nSubject: ${mail.subject}\n\n${mail.body}` }; }
  if (action === "draft_list") return { content: state.drafts.length ? state.drafts.map((draft) => `${draft.id} | ${draft.to.join(",")} | ${draft.subject}`).join("\n") : "No drafts." };
  if (action === "draft_create") { const draft = { id: `draft-${state.drafts.length + 1}`, to: list(args.to), subject: String(args.subject ?? ""), body: String(args.body ?? "") }; state.drafts.push(draft); return { content: `Draft saved: ${draft.id}`, display: draft.id }; }
  if (action === "send" || action === "draft_send") return { content: "Fake email sent.", display: "fake sent" };
  return { content: `Fake email ${action} completed.` };
}

function fakeApple(state: FakeWorldState, action: string, args: Record<string, any>): ToolResult {
  if (action === "messages_recent") return { content: messageLines(state.messages), display: `${state.messages.length} fake messages` };
  if (action === "messages_search") return { content: messageLines(state.messages.filter((message) => lower(message.body).includes(lower(args.keyword)))) };
  if (action === "messages_send") return { content: `Fake iMessage sent to ${args.to}.`, display: "fake sent" };
  if (action === "contacts_lookup") return { content: `${args.name} | fake@example.com | +1-555-0100` };
  if (action === "contacts_list") return { content: "Apple Contacts (1–2 of 2, alphabetical):\nAlex Fake: +1-555-0100 | email: alex@example.com\nBailey Fake: +1-555-0101 | email: bailey@example.com" };
  if (action === "contacts_create") return { content: `Saved "${args.name}" to Apple Contacts (${[args.phone, args.email].filter(Boolean).join(", ")}).`, display: `saved ${args.name}` };
  return { content: `Fake Apple ${action} completed.` };
}

function fakeCalendar(state: FakeWorldState, action: string, args: Record<string, any>): ToolResult {
  if (action === "list") return { content: `Events:\n${eventLines(state.events)}`, display: `${state.events.length} fake events` };
  if (action === "search") return { content: eventLines(state.events.filter((event) => lower(event.title).includes(lower(args.query)))) };
  if (action === "find_free") {
    return { content: `Availability based on the fake calendar:\n- Tuesday 2026-09-15 14:00–14:45\n- Wednesday 2026-09-16 11:00–11:45\n- Friday 2026-09-18 10:00–10:45\nKnown conflicts:\n${eventLines(state.events)}` };
  }
  if (action === "add") {
    const event: WorldEvent = { id: `ev-added-${state.events.length + 1}`, title: String(args.title ?? "Untitled"), start: String(args.start ?? state.now), end: String(args.end ?? `${args.duration_minutes ?? 60} minutes later`), attendees: list(args.attendees) };
    state.events.push(event); return { content: `Event added: ${event.id} | ${event.title} | ${event.start}`, display: event.id };
  }
  if (action === "update") { const event = state.events.find((item) => item.id === String(args.id)); if (!event) return { content: "Event not found.", isError: true }; if (args.title) event.title = String(args.title); if (args.start) event.start = String(args.start); return { content: `Event updated: ${event.id}` }; }
  if (action === "cancel") { state.events = state.events.filter((item) => item.id !== String(args.id)); return { content: `Event cancelled: ${args.id}` }; }
  return { content: `Fake calendar ${action} completed.` };
}
