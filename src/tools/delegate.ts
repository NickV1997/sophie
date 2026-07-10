import {
  addDelegate,
  cancelDelegate,
  getDelegate,
  listDelegates,
  updateDelegateSent,
  setDelegateScheduleId,
} from "../agent/delegates.ts";
import { lookupPeople, renderPerson } from "../people/store.ts";
import { addCron } from "../agent/scheduler.ts";
import type { Tool } from "./types.ts";

export const delegateTool: Tool = {
  name: "delegate",
  description:
    "Manage standing delegations — recurring commitments to keep specific people informed about topics. Use add to create a delegation with a cron schedule; fire to draft and send an update right now; list to review active delegations; cancel to remove one.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["add", "list", "fire", "cancel"],
        description: "add: create delegation; list: show active; fire: draft+send update now; cancel: disable",
      },
      id: { type: "string", description: "Delegation id (for fire/cancel)" },
      title: { type: "string", description: "Short label, e.g. 'Paul / Stivy updates'" },
      person: { type: "string", description: "Contact name" },
      topic: { type: "string", description: "What to keep them informed about" },
      instruction: { type: "string", description: "How to frame updates — tone, what to include" },
      channel: { type: "string", enum: ["imessage", "notify"], description: "How to send (default: imessage)" },
      cron: { type: "string", description: "5-field cron for recurring check-ins (e.g. '0 9 * * 5' for Fri 9am). Optional." },
      auto_send: { type: "boolean", description: "Auto-send without asking (default false = draft+ask)" },
    },
    required: ["action"],
  },
  summarize(args) {
    if (args.action === "fire") return `fire · ${args.id ?? "?"}`;
    if (args.action === "cancel") return `cancel · ${args.id ?? "?"}`;
    if (args.action === "add") return `add · ${args.person ?? "?"}`;
    return "list";
  },
  risk(args) {
    return args.action === "list" ? "safe" : "caution";
  },
  async execute(args) {
    const action = String(args.action ?? "").trim();

    if (action === "list") {
      const active = listDelegates();
      if (!active.length) return { content: "No active delegations. Use action:add to create one." };
      const lines = active.map((d) => {
        const sent = d.lastSent ? `last sent: ${new Date(d.lastSent).toISOString().slice(0, 10)}` : "never sent";
        const sched = d.cron ? ` · cron: ${d.cron}` : "";
        return `- [${d.id}] ${d.title} · ${d.person} · ${d.topic} · ${sent}${sched}`;
      });
      return { content: lines.join("\n") };
    }

    if (action === "add") {
      const person = String(args.person ?? "").trim();
      const topic = String(args.topic ?? "").trim();
      const instruction = String(args.instruction ?? "").trim();
      const title = String(args.title ?? "").trim() || `${person} / ${topic}`;
      if (!person || !topic || !instruction) {
        return { content: "person, topic, and instruction are required.", isError: true };
      }

      const channel = (args.channel === "notify" ? "notify" : "imessage") as "imessage" | "notify";
      const autoSend = args.auto_send === true;
      const cronExpr = args.cron ? String(args.cron).trim() : undefined;

      const rec = addDelegate({ title, person, topic, instruction, channel, cron: cronExpr, autoSend });

      let schedMsg = "";
      if (cronExpr) {
        try {
          const schedItem = addCron({
            title: `Delegate: ${title}`,
            cron: cronExpr,
            action: "run",
            prompt: `You have a standing delegation: keep ${person} informed about ${topic}. ${instruction}. Draft an update based on the current state of things and send it via ${channel === "imessage" ? "iMessage (apple tool, messages_send)" : "notification (notify tool)"}.`,
          });
          setDelegateScheduleId(rec.id, schedItem.id);
          schedMsg = ` Recurring schedule set (${cronExpr}, schedule id: ${schedItem.id}).`;
        } catch (e: any) {
          schedMsg = ` Warning: could not set cron schedule — ${e?.message ?? "unknown error"}.`;
        }
      }

      return {
        content: `Delegation created: [${rec.id}] ${rec.title}.${schedMsg}\nPerson: ${rec.person}\nTopic: ${rec.topic}\nChannel: ${rec.channel}\nInstruction: ${rec.instruction}`,
        display: rec.title,
      };
    }

    if (action === "fire") {
      const id = String(args.id ?? "").trim();
      if (!id) return { content: "id is required for fire.", isError: true };

      const del = getDelegate(id);
      if (!del) return { content: `No delegation found with id "${id}".`, isError: true };

      // Look up person context
      const people = lookupPeople(del.person);
      const personContext = people.length ? renderPerson(people[0]!) : `No person record found for "${del.person}".`;

      // Update lastSent
      updateDelegateSent(id);

      const draftGuidance = [
        `Draft an update for ${del.person} about: ${del.topic}.`,
        `Instruction: ${del.instruction}`,
        `Channel: ${del.channel === "imessage" ? "iMessage" : "notification"}`,
        "",
        "Person context:",
        personContext,
        "",
        `After drafting, send via: ${del.channel === "imessage" ? `apple(action:"messages_send", to:"${del.person}", text:<draft>)` : `notify(message:<draft>)`}`,
      ].join("\n");

      return {
        content: draftGuidance,
        display: `${del.person} / ${del.topic}`,
      };
    }

    if (action === "cancel") {
      const id = String(args.id ?? "").trim();
      if (!id) return { content: "id is required for cancel.", isError: true };
      const ok = cancelDelegate(id);
      if (!ok) return { content: `No delegation found with id "${id}".`, isError: true };
      return { content: `Delegation "${id}" cancelled.` };
    }

    return { content: `Unknown action "${action}". Valid: add, list, fire, cancel.`, isError: true };
  },
};
