import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { join } from "node:path";
import { config } from "../config.ts";
import { MEMORY_DIR } from "../memory/store.ts";
import type { Tool, ToolResult } from "./types.ts";

interface EmailDraft {
  id: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  createdAt: number;
  updatedAt: number;
}

const DRAFTS_PATH = join(MEMORY_DIR, "email_drafts.json");

function configured(): string | null {
  if (!config.emailAddress) return "SOPHIE_EMAIL_ADDRESS is not set.";
  if (!config.emailAppPassword) return "SOPHIE_EMAIL_APP_PASSWORD is not set.";
  if (!config.emailImapHost || !config.emailImapPort) return "IMAP host/port is not configured.";
  if (!config.emailSmtpHost || !config.emailSmtpPort) return "SMTP host/port is not configured.";
  return null;
}

function splitAddresses(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((s) => s.trim()).filter(Boolean);
  return String(value ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

function loadDrafts(): EmailDraft[] {
  try {
    if (!existsSync(DRAFTS_PATH)) return [];
    const parsed = JSON.parse(readFileSync(DRAFTS_PATH, "utf8"));
    return Array.isArray(parsed?.drafts) ? parsed.drafts : [];
  } catch {
    return [];
  }
}

function saveDrafts(drafts: EmailDraft[]): void {
  if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true });
  writeFileSync(DRAFTS_PATH, `${JSON.stringify({ drafts }, null, 2)}\n`);
}

function newDraftId(): string {
  return `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function decodeMimeWords(s: string): string {
  return s.replace(/=\?([^?]+)\?([bqBQ])\?([^?]+)\?=/g, (_m, charset, enc, text) => {
    try {
      const bytes = enc.toLowerCase() === "b"
        ? Buffer.from(text, "base64")
        : Buffer.from(text.replace(/_/g, " ").replace(/=([0-9a-f]{2})/gi, (_: string, h: string) => String.fromCharCode(parseInt(h, 16))), "binary");
      return bytes.toString(String(charset).toLowerCase().includes("utf-8") ? "utf8" : "latin1");
    } catch {
      return text;
    }
  });
}

function parseHeaders(raw: string): Record<string, string> {
  const head = raw.split(/\r?\n\r?\n/, 1)[0] ?? "";
  const out: Record<string, string> = {};
  let cur = "";
  for (const line of head.split(/\r?\n/)) {
    if (/^\s/.test(line) && cur) {
      out[cur] += ` ${line.trim()}`;
      continue;
    }
    const m = /^([^:]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    cur = m[1].toLowerCase();
    out[cur] = decodeMimeWords(m[2].trim());
  }
  return out;
}

function plainText(raw: string, max = 4000): string {
  const [, body = raw] = raw.split(/\r?\n\r?\n/, 2);
  return body
    .replace(/\r/g, "")
    .replace(/--[^\n]+/g, "")
    .replace(/Content-[^\n]+\n/gi, "")
    .trim()
    .slice(0, max);
}

class ImapClient {
  private socket!: TLSSocket;
  private tag = 0;
  private buffer = "";

  async connect(): Promise<void> {
    this.socket = tlsConnect({
      host: config.emailImapHost,
      port: config.emailImapPort,
      servername: config.emailImapHost,
    });
    this.socket.setEncoding("utf8");
    this.socket.on("data", (d) => { this.buffer += String(d); });
    await new Promise<void>((resolve, reject) => {
      this.socket.once("secureConnect", () => resolve());
      this.socket.once("error", reject);
    });
    await this.waitFor(/^\* OK/m);
    await this.cmd(`LOGIN ${quote(config.emailAddress)} ${quote(config.emailAppPassword.replace(/\s+/g, ""))}`);
  }

  close(): void {
    try { this.socket.end(); } catch {}
  }

  async select(mailbox: string): Promise<void> {
    await this.cmd(`SELECT ${quoteMailbox(mailbox)}`);
  }

  async search(criteria: string): Promise<string[]> {
    const res = await this.cmd(`UID SEARCH ${criteria}`);
    const line = res.split(/\r?\n/).find((l) => l.startsWith("* SEARCH")) ?? "";
    return line.replace(/^\* SEARCH\s*/, "").trim().split(/\s+/).filter(Boolean);
  }

  async fetchRaw(uid: string): Promise<string> {
    const tag = this.nextTag();
    this.socket.write(`${tag} UID FETCH ${uid} (BODY.PEEK[])\r\n`);
    const res = await this.waitFor(new RegExp(`^${tag} (OK|NO|BAD)`, "m"));
    if (!new RegExp(`^${tag} OK`, "m").test(res)) throw new Error(`IMAP fetch failed: ${tail(res)}`);
    return extractLiteral(res) || res;
  }

  private nextTag(): string {
    return `A${++this.tag}`;
  }

  private async cmd(command: string): Promise<string> {
    const tag = this.nextTag();
    this.socket.write(`${tag} ${command}\r\n`);
    const res = await this.waitFor(new RegExp(`^${tag} (OK|NO|BAD)`, "m"));
    if (!new RegExp(`^${tag} OK`, "m").test(res)) throw new Error(`IMAP command failed: ${tail(res)}`);
    return res;
  }

  private waitFor(pattern: RegExp): Promise<string> {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const tick = () => {
        if (pattern.test(this.buffer)) {
          const out = this.buffer;
          this.buffer = "";
          resolve(out);
          return;
        }
        if (Date.now() - start > 30_000) {
          reject(new Error("IMAP timed out."));
          return;
        }
        setTimeout(tick, 25);
      };
      tick();
    });
  }
}

function quote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function quoteMailbox(s: string): string {
  if (/^[A-Za-z0-9_/-]+$/.test(s)) return s;
  return quote(s);
}

function extractLiteral(res: string): string {
  const m = /\{(\d+)\}\r?\n/.exec(res);
  if (!m) return "";
  return res.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + Number(m[1]));
}

function tail(s: string): string {
  return s.trim().split(/\r?\n/).slice(-2).join(" ");
}

async function listMailbox(kind: "unread" | "all" | "drafts", limit: number): Promise<string> {
  const imap = new ImapClient();
  try {
    await imap.connect();
    const mailbox = kind === "drafts" ? "[Gmail]/Drafts" : "INBOX";
    await imap.select(mailbox);
    const ids = await imap.search(kind === "unread" ? "UNSEEN" : "ALL");
    const selected = ids.slice(-limit).reverse();
    if (!selected.length) return kind === "unread" ? "No unread messages." : `No messages found in ${mailbox}.`;
    const rows: string[] = [];
    for (const uid of selected) {
      const raw = await imap.fetchRaw(uid);
      const h = parseHeaders(raw);
      rows.push(`${uid} | ${h.from ?? "(unknown)"} | ${h.date ?? ""} | ${h.subject ?? "(no subject)"}`);
    }
    return rows.join("\n");
  } finally {
    imap.close();
  }
}

async function readMessage(uid: string, mailbox = "INBOX"): Promise<string> {
  const imap = new ImapClient();
  try {
    await imap.connect();
    await imap.select(mailbox);
    const raw = await imap.fetchRaw(uid);
    const h = parseHeaders(raw);
    return [
      `UID: ${uid}`,
      `From: ${h.from ?? ""}`,
      `To: ${h.to ?? ""}`,
      `Date: ${h.date ?? ""}`,
      `Subject: ${h.subject ?? "(no subject)"}`,
      "",
      plainText(raw),
    ].join("\n");
  } finally {
    imap.close();
  }
}

async function sendMail(input: { to: string[]; cc?: string[]; bcc?: string[]; subject: string; body: string }): Promise<void> {
  const socket = tlsConnect({
    host: config.emailSmtpHost,
    port: config.emailSmtpPort,
    servername: config.emailSmtpHost,
  });
  socket.setEncoding("utf8");
  let buf = "";
  socket.on("data", (d) => { buf += String(d); });
  await new Promise<void>((resolve, reject) => {
    socket.once("secureConnect", () => resolve());
    socket.once("error", reject);
  });
  async function expect(re: RegExp): Promise<string> {
    const start = Date.now();
    while (!re.test(buf)) {
      if (Date.now() - start > 30_000) throw new Error("SMTP timed out.");
      await new Promise((r) => setTimeout(r, 25));
    }
    const out = buf;
    buf = "";
    return out;
  }
  async function cmd(s: string, re = /^[23]\d\d/m): Promise<void> {
    socket.write(`${s}\r\n`);
    const out = await expect(re);
    if (!re.test(out)) throw new Error(`SMTP failed: ${tail(out)}`);
  }
  await expect(/^220/m);
  await cmd("EHLO sophie.local");
  await cmd("AUTH LOGIN", /^334/m);
  await cmd(Buffer.from(config.emailAddress).toString("base64"), /^334/m);
  await cmd(Buffer.from(config.emailAppPassword.replace(/\s+/g, "")).toString("base64"));
  await cmd(`MAIL FROM:<${config.emailAddress}>`);
  for (const to of [...input.to, ...(input.cc ?? []), ...(input.bcc ?? [])]) await cmd(`RCPT TO:<${to}>`);
  await cmd("DATA", /^354/m);
  const headers = [
    `From: ${config.emailAddress}`,
    `To: ${input.to.join(", ")}`,
    input.cc?.length ? `Cc: ${input.cc.join(", ")}` : "",
    `Subject: ${input.subject.replace(/\r?\n/g, " ")}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "",
  ].filter(Boolean).join("\r\n");
  socket.write(`${headers}\r\n${input.body.replace(/^\./gm, "..")}\r\n.\r\n`);
  await expect(/^250/m);
  socket.write("QUIT\r\n");
  socket.end();
}

export const emailTool: Tool = {
  name: "email",
  description:
    "Gmail over the user's app password. Read messages (unread/all), read Gmail drafts, manage local Sophie draft messages, and send email. " +
    "Actions: list_unread, list_all, list_gmail_drafts, read, draft_create, draft_list, draft_update, draft_delete, send, draft_send.",
  preconditions: ["Requires setup wizard email fields: Gmail address, Gmail app password, IMAP host/port, SMTP host/port."],
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list_unread", "list_all", "list_gmail_drafts", "read", "draft_create", "draft_list", "draft_update", "draft_delete", "send", "draft_send"] },
      uid: { type: "string", description: "IMAP UID to read." },
      mailbox: { type: "string", description: "Mailbox for read, default INBOX." },
      limit: { type: "number", description: "Max messages to list, default 10." },
      draft_id: { type: "string", description: "Local Sophie draft id." },
      to: { type: "array", items: { type: "string" }, description: "Recipients." },
      cc: { type: "array", items: { type: "string" }, description: "CC recipients." },
      bcc: { type: "array", items: { type: "string" }, description: "BCC recipients." },
      subject: { type: "string", description: "Email subject." },
      body: { type: "string", description: "Email body." },
    },
    required: ["action"],
  },
  summarize: (a) => `email ${a.action}${a.uid ? ` ${a.uid}` : a.draft_id ? ` ${a.draft_id}` : ""}`,
  risk: (a) => ["send", "draft_send", "draft_delete"].includes(String(a.action)) ? "caution" : "safe",
  async execute(args): Promise<ToolResult> {
    const action = String(args.action ?? "");
    const missing = configured();
    if (missing && !["draft_list", "draft_create", "draft_update", "draft_delete"].includes(action)) {
      return { content: `Email is not configured: ${missing}`, isError: true };
    }

    if (action === "list_unread" || action === "list_all" || action === "list_gmail_drafts") {
      const kind = action === "list_unread" ? "unread" : action === "list_gmail_drafts" ? "drafts" : "all";
      return { content: await listMailbox(kind, Math.min(Math.max(Number(args.limit) || 10, 1), 25)), display: kind };
    }
    if (action === "read") {
      const uid = String(args.uid ?? "").trim();
      if (!uid) return { content: "email read needs uid.", isError: true };
      return { content: await readMessage(uid, String(args.mailbox ?? "INBOX")) };
    }

    const drafts = loadDrafts();
    if (action === "draft_list") {
      return {
        content: drafts.length
          ? drafts.map((d) => `${d.id} | to ${d.to.join(", ")} | ${d.subject || "(no subject)"}`).join("\n")
          : "No local Sophie email drafts.",
      };
    }
    if (action === "draft_create") {
      const draft: EmailDraft = {
        id: newDraftId(),
        to: splitAddresses(args.to),
        cc: splitAddresses(args.cc),
        bcc: splitAddresses(args.bcc),
        subject: String(args.subject ?? ""),
        body: String(args.body ?? ""),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      drafts.push(draft);
      saveDrafts(drafts);
      return { content: `Draft saved: ${draft.id}`, display: draft.id };
    }
    if (action === "draft_update") {
      const id = String(args.draft_id ?? "").trim();
      const d = drafts.find((x) => x.id === id);
      if (!d) return { content: `Draft not found: ${id}`, isError: true };
      if (args.to !== undefined) d.to = splitAddresses(args.to);
      if (args.cc !== undefined) d.cc = splitAddresses(args.cc);
      if (args.bcc !== undefined) d.bcc = splitAddresses(args.bcc);
      if (args.subject !== undefined) d.subject = String(args.subject);
      if (args.body !== undefined) d.body = String(args.body);
      d.updatedAt = Date.now();
      saveDrafts(drafts);
      return { content: `Draft updated: ${id}`, display: id };
    }
    if (action === "draft_delete") {
      const id = String(args.draft_id ?? "").trim();
      const next = drafts.filter((d) => d.id !== id);
      saveDrafts(next);
      return { content: next.length === drafts.length ? `Draft not found: ${id}` : `Draft deleted: ${id}` };
    }
    if (action === "send") {
      const msg = { to: splitAddresses(args.to), cc: splitAddresses(args.cc), bcc: splitAddresses(args.bcc), subject: String(args.subject ?? ""), body: String(args.body ?? "") };
      if (!msg.to.length || !msg.subject || !msg.body) return { content: "email send needs to, subject, and body.", isError: true };
      await sendMail(msg);
      return { content: `Email sent to ${msg.to.join(", ")}.`, display: "sent" };
    }
    if (action === "draft_send") {
      const id = String(args.draft_id ?? "").trim();
      const d = drafts.find((x) => x.id === id);
      if (!d) return { content: `Draft not found: ${id}`, isError: true };
      if (!d.to.length || !d.subject || !d.body) return { content: "Draft needs to, subject, and body before sending.", isError: true };
      await sendMail(d);
      saveDrafts(drafts.filter((x) => x.id !== id));
      return { content: `Draft sent to ${d.to.join(", ")} and removed locally.`, display: "sent" };
    }
    return { content: `Unknown email action: ${action}`, isError: true };
  },
};
