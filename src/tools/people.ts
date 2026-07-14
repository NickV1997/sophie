import {
  addThread,
  closeThread,
  deletePerson,
  listPeople,
  logContact,
  lookupPeople,
  renderPerson,
  upsertPerson,
} from "../people/store.ts";
import type { Tool } from "./types.ts";

export const peopleTool: Tool = {
  name: "people",
  description:
    "Manage contact context — roles, relationships, open threads, notes, and interaction history. Look up a person when you need context to decide what to write; skip it when the user already gave you the message text. Use to record interactions and track open items.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["lookup", "upsert", "log_contact", "add_thread", "close_thread", "list", "delete"],
        description: "lookup: search by name; upsert: create/update; log_contact: record an interaction; add_thread: add open item; close_thread: resolve an item; list: all people; delete: remove a record",
      },
      people: {
        type: "array",
        description: "For action:upsert, validate and save several people in one call.",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            role: { type: "string" },
            relationship: { type: "string" },
            aliases: { type: "array", items: { type: "string" } },
            phones: { type: "array", items: { type: "string" } },
            emails: { type: "array", items: { type: "string" } },
            tags: { type: "array", items: { type: "string" } },
            notes: { type: "string" },
            open_threads: { type: "array", items: { type: "string" } },
          },
          required: ["name"],
        },
      },
      name: { type: "string", description: "Person name (required for all actions except list)" },
      role: { type: "string", description: "Role: investor, cofounder, client, friend, etc." },
      relationship: { type: "string", description: "One-sentence summary of the relationship" },
      aliases: { type: "array", items: { type: "string" }, description: "Nicknames / terms of endearment to recognize (e.g. 'babushka', 'dad', 'boss'). Lookups match aliases exactly." },
      phones: { type: "array", items: { type: "string" }, description: "Phone numbers" },
      emails: { type: "array", items: { type: "string" }, description: "Email addresses" },
      tags: { type: "array", items: { type: "string" }, description: "Tags for grouping/search" },
      notes: { type: "string", description: "Freeform notes to add (appended to existing)" },
      open_threads: { type: "array", items: { type: "string" }, description: "Open threads/pending items to add" },
      thread: { type: "string", description: "Thread text (for add_thread) or substring match (for close_thread)" },
      note: { type: "string", description: "Optional note to attach when logging contact" },
    },
    required: ["action"],
  },
  summarize(args) {
    const name = args.name ? ` · ${args.name}` : "";
    return `${args.action}${name}`;
  },
  risk(args) {
    const safe = new Set(["lookup", "log_contact", "list"]);
    return safe.has(args.action) ? "safe" : "caution";
  },
  async execute(args) {
    const action = String(args.action ?? "").trim();

    if (action === "list") {
      const all = listPeople();
      if (!all.length) return { content: "No people records yet. Use action:upsert to add someone." };
      return { content: all.map(renderPerson).join("\n\n---\n\n") };
    }

    if (action === "lookup") {
      const q = String(args.name ?? "").trim();
      if (!q) return { content: "Provide name to search.", isError: true };
      const hits = lookupPeople(q);
      if (!hits.length) return { content: `No person found matching "${q}".` };
      return { content: hits.map(renderPerson).join("\n\n---\n\n") };
    }

    if (action === "upsert") {
      const batch = Array.isArray(args.people) && args.people.length
        ? args.people.slice(0, 20).map((item) => item as Record<string, unknown>)
        : [args as Record<string, unknown>];
      const prepared = batch.map((item) => ({
        name: String(item.name ?? "").trim(),
        role: item.role != null ? String(item.role) : undefined,
        relationship: item.relationship != null ? String(item.relationship) : undefined,
        aliases: Array.isArray(item.aliases) ? item.aliases.map(String) : undefined,
        phones: Array.isArray(item.phones) ? item.phones.map(String) : undefined,
        emails: Array.isArray(item.emails) ? item.emails.map(String) : undefined,
        tags: Array.isArray(item.tags) ? item.tags.map(String) : undefined,
        notes: item.notes != null ? String(item.notes) : undefined,
        openThreads: Array.isArray(item.open_threads) ? item.open_threads.map(String) : undefined,
      }));
      if (prepared.some((item) => !item.name)) return { content: "Every person needs a name; no people were saved.", isError: true };
      const saved = prepared.map((item) => upsertPerson(item));
      return { content: `Saved ${saved.length} people record${saved.length === 1 ? "" : "s"}.\n\n${saved.map(renderPerson).join("\n\n---\n\n")}`, display: saved.map((item) => item.name).join(", ") };
    }

    if (action === "log_contact") {
      const name = String(args.name ?? "").trim();
      if (!name) return { content: "name is required.", isError: true };
      const note = args.note != null ? String(args.note) : undefined;
      const rec = logContact(name, note);
      if (!rec) return { content: `No person found matching "${name}".`, isError: true };
      return { content: `Contact logged for ${rec.name}.\n\n${renderPerson(rec)}`, display: rec.name };
    }

    if (action === "add_thread") {
      const name = String(args.name ?? "").trim();
      const thread = String(args.thread ?? "").trim();
      if (!name || !thread) return { content: "name and thread are required.", isError: true };
      const rec = addThread(name, thread);
      if (!rec) return { content: `No person found matching "${name}".`, isError: true };
      return { content: `Thread added.\n\n${renderPerson(rec)}`, display: rec.name };
    }

    if (action === "close_thread") {
      const name = String(args.name ?? "").trim();
      const thread = String(args.thread ?? "").trim();
      if (!name || !thread) return { content: "name and thread are required.", isError: true };
      const rec = closeThread(name, thread);
      if (!rec) return { content: `No person found matching "${name}".`, isError: true };
      return { content: `Thread(s) matching "${thread}" closed.\n\n${renderPerson(rec)}`, display: rec.name };
    }

    if (action === "delete") {
      const name = String(args.name ?? "").trim();
      if (!name) return { content: "name is required.", isError: true };
      const ok = deletePerson(name);
      if (!ok) return { content: `No person found matching "${name}".`, isError: true };
      return { content: `Deleted record for "${name}".` };
    }

    return { content: `Unknown action "${action}". Valid: lookup, upsert, log_contact, add_thread, close_thread, list, delete.`, isError: true };
  },
};
