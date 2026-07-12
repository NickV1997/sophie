import { getTool } from "../tools/registry.ts";
import type { Tool, ToolResult } from "../tools/types.ts";
import type { WeekScenario, WorldEvent, WorldMail, WorldMessage } from "./real_world_scenarios.ts";

export interface WorldAction { tool: string; action: string; args: Record<string, unknown>; at: string; }
export interface FakeWorldState {
  now: string; emails: WorldMail[]; messages: WorldMessage[]; events: WorldEvent[];
  drafts: Array<{ id: string; to: string[]; subject: string; body: string }>;
  notifications: string[]; actions: WorldAction[];
}
export interface FakeWorldHandle { state: FakeWorldState; setDay(day: number): void; uninstall(): void; }

const WORLD_TOOLS = ["email", "apple", "messages_recent", "messages_search", "messages_send", "calendar", "calendar_list", "calendar_search", "calendar_find_free", "notify", "current_time"];
const list = (value: unknown) => Array.isArray(value) ? value.map(String) : String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
const lower = (value: unknown) => String(value ?? "").toLowerCase();

function eventLines(events: WorldEvent[]): string {
  return events.length ? events.map((event) => `${event.id} | ${event.title} | ${event.start}–${event.end}${event.attendees?.length ? ` | ${event.attendees.join(", ")}` : ""}`).join("\n") : "No events in this range.";
}
function mailLines(emails: WorldMail[]): string {
  return emails.length ? emails.map((mail) => `UID=${mail.id} | ${mail.from} | ${mail.subject} | Preview: ${mail.body.slice(0, 180).replace(/\s+/g, " ")}`).join("\n") : "No unread messages.";
}
function messageLines(messages: WorldMessage[]): string {
  return messages.length ? messages.map((message) => `${message.id} | ${message.from}: ${message.body}`).join("\n") : "No recent messages.";
}

export function installFakeWorld(scenario: WeekScenario): FakeWorldHandle {
  const state: FakeWorldState = { now: scenario.seed.now, emails: structuredClone(scenario.seed.emails), messages: structuredClone(scenario.seed.messages), events: structuredClone(scenario.seed.events), drafts: [], notifications: [], actions: [] };
  const originals = new Map<Tool, Tool["execute"]>();
  for (const name of WORLD_TOOLS) {
    const tool = getTool(name); if (!tool) continue;
    originals.set(tool, tool.execute);
    tool.execute = async (args): Promise<ToolResult> => {
      const action = String(args.action ?? (name === "calendar_list" ? "list" : name === "calendar_find_free" ? "find_free" : name));
      state.actions.push({ tool: name, action, args: structuredClone(args), at: state.now });
      if (name === "current_time") return { content: `Current local time: ${state.now}`, display: state.now };
      if (name === "notify") { const message = String(args.message ?? ""); state.notifications.push(message); return { content: "Notification delivered to the fake user's desktop and phone.", display: "fake delivery" }; }
      if (name === "email") return fakeEmail(state, action, args);
      if (name === "apple" || name.startsWith("messages_")) return fakeApple(state, name.startsWith("messages_") ? name : action, args);
      if (name === "calendar" || name.startsWith("calendar_")) return fakeCalendar(state, action, args);
      return { content: "Fake-world operation completed." };
    };
  }
  return {
    state,
    setDay(day) { const date = new Date(scenario.seed.now); date.setDate(date.getDate() + day - 1); state.now = date.toISOString(); },
    uninstall() { for (const [tool, execute] of originals) tool.execute = execute; },
  };
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
