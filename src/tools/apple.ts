import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import type { Tool, ToolResult } from "./types.ts";

/**
 * apple — the macOS ecosystem bridge: Messages, Notes, Reminders, Contacts, and alarm-like alerts.
 *
 * Reads Messages straight from ~/Library/Messages/chat.db (fast, no Apple
 * events; needs Full Disk Access). Contact name resolution reads Contacts via
 * JXA (result cached for 5 minutes). Everything else goes through osascript:
 * JXA for Notes/Reminders (bulk property fetches) and classic AppleScript for
 * sending an iMessage.
 */

const OSA_TIMEOUT_MS = 45_000;
const CONTACT_CACHE_TTL_MS = 5 * 60 * 1000;

function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** HTML-encode plain text for embedding inside a Notes HTML body. */
function hesc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function runOsa(
  script: string,
  opts: { lang?: "AppleScript" | "JavaScript"; args?: string[]; signal?: AbortSignal } = {},
): Promise<{ ok: boolean; out: string; err: string }> {
  const cmd = ["osascript"];
  if (opts.lang === "JavaScript") cmd.push("-l", "JavaScript");
  cmd.push("-e", script, ...(opts.args ?? []));
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore", signal: opts.signal });
    const timer = setTimeout(() => proc.kill(), OSA_TIMEOUT_MS);
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const code = await proc.exited;
    clearTimeout(timer);
    return { ok: code === 0, out: out.trim(), err: err.trim() };
  } catch (e: any) {
    return { ok: false, out: "", err: e?.message ?? String(e) };
  }
}

function osaGuidance(err: string): string {
  if (/-1743|not authoriz/i.test(err)) {
    return "macOS blocked the automation. Approve it in System Settings → Privacy & Security → Automation (allow your terminal to control the target app), then retry.";
  }
  if (/-600|isn't running|not running/i.test(err)) {
    return "The target app isn't available. Open it once manually, then retry.";
  }
  return err;
}

// ── Contact map (phone/email → name) ────────────────────────────────────────

interface ContactMap {
  phones: Map<string, string>;
  emails: Map<string, string>;
  /** lowercased-name → { phones[], emails[] } for name→number lookup */
  byName: Map<string, { name: string; phones: string[]; emails: string[] }>;
  expiresAt: number;
}

let _contactCache: ContactMap | null = null;

/** Build a contact map from the Contacts app via JXA. Cached for 5 minutes. */
async function getContactMap(signal?: AbortSignal): Promise<ContactMap> {
  const now = Date.now();
  if (_contactCache && now < _contactCache.expiresAt) return _contactCache;

  // One JXA call that returns all people+phones+emails as JSON.
  // Phones are sorted so mobile/cell/iPhone labels come first.
  const script =
    "function run(){" +
    'const app=Application("Contacts");' +
    "const people=app.people();const rows=[];" +
    "const mobilePref=['mobile','iphone','cell','main'];" +
    "for(const p of people){try{" +
    'const fn=p.firstName()||"";const ln=p.lastName()||"";' +
    'const nn=p.nickname()||"";' +
    'const name=(fn+" "+ln).trim()||nn;if(!name)continue;' +
    "const allPh=[];for(const ph of p.phones()){try{const v=ph.value()||'';const l=(ph.label()||'').toLowerCase();if(v)allPh.push({v,l});}catch(e){}}" +
    "allPh.sort((a,b)=>{const ai=mobilePref.findIndex(m=>a.l.includes(m));const bi=mobilePref.findIndex(m=>b.l.includes(m));return (ai===-1?99:ai)-(bi===-1?99:bi);});" +
    "const phones=allPh.map(p=>p.v);" +
    "const emails=[];for(const em of p.emails()){try{emails.push(em.value()||'');}catch(e){}}" +
    "rows.push({name,phones,emails});" +
    "}catch(e){}}" +
    "return JSON.stringify(rows);}";

  const res = await runOsa(script, { lang: "JavaScript", signal });

  const phones = new Map<string, string>();
  const emails = new Map<string, string>();
  const byName = new Map<string, { name: string; phones: string[]; emails: string[] }>();

  if (res.ok && res.out) {
    try {
      const rows = JSON.parse(res.out) as { name: string; phones: string[]; emails: string[] }[];
      for (const row of rows) {
        const { name, phones: phs, emails: ems } = row;
        byName.set(name.toLowerCase(), row);
        for (const ph of phs) {
          if (!ph) continue;
          phones.set(ph, name);
          const digits = ph.replace(/\D/g, "");
          if (digits) {
            phones.set(digits, name);
            if (digits.length > 10) phones.set(digits.slice(-10), name);
          }
        }
        for (const em of ems) {
          if (em) emails.set(em.toLowerCase(), name);
        }
      }
    } catch { /* corrupt JSON — cache will be empty but won't crash */ }
  }

  _contactCache = { phones, emails, byName, expiresAt: now + CONTACT_CACHE_TTL_MS };
  return _contactCache;
}

/** Resolve a phone/email handle to a saved contact name. Returns null if unknown. */
function resolveHandle(handle: string, map: ContactMap): string | null {
  if (!handle) return null;
  if (handle.includes("@")) return map.emails.get(handle.toLowerCase()) ?? null;
  const name = map.phones.get(handle);
  if (name) return name;
  const digits = handle.replace(/\D/g, "");
  return map.phones.get(digits) ?? map.phones.get(digits.slice(-10)) ?? null;
}

/**
 * Search the contact map for a name query. Returns best matching entries
 * (starts-with ranked above contains).
 */
function searchByName(
  query: string,
  map: ContactMap,
): { name: string; phones: string[]; emails: string[] }[] {
  const q = query.toLowerCase();
  const starts: typeof map.byName extends Map<string, infer V> ? V[] : never[] = [];
  const contains: typeof starts = [];
  for (const [key, val] of map.byName) {
    if (key.startsWith(q)) starts.push(val);
    else if (key.includes(q)) contains.push(val);
  }
  return [...starts, ...contains].slice(0, 10);
}

/** True if the string looks like a raw phone/email, not a human name. */
function looksLikeAddress(s: string): boolean {
  return /^\+?\d[\d\s\-().]{5,}$/.test(s) || s.includes("@");
}

/** Normalize US phone numbers to +1XXXXXXXXXX for iMessage. */
function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return phone;
}

// ── Messages (chat.db) ───────────────────────────────────────────────────────

function appleDateToMs(v: number): number {
  const APPLE_EPOCH_MS = 978_307_200_000;
  if (v > 1e14) return APPLE_EPOCH_MS + v / 1e6;
  return APPLE_EPOCH_MS + v * 1000;
}

export function textFromAttributedBody(blob: Uint8Array | null): string {
  if (!blob || !blob.length) return "";
  const buf = Buffer.from(blob);
  const marker = buf.indexOf(Buffer.from("NSString"));
  if (marker !== -1) {
    const plus = buf.indexOf(0x2b, marker);
    if (plus !== -1 && plus + 2 < buf.length) {
      let start = plus + 2;
      let len = buf[plus + 1]!;
      if (len === 0x81) { len = buf.readUInt16LE(plus + 2); start = plus + 4; }
      else if (len === 0x82) { len = buf.readUInt32LE(plus + 2); start = plus + 6; }
      if (start + len <= buf.length) {
        const text = buf.subarray(start, start + len).toString("utf8");
        if (text && !text.includes("")) return text;
      }
    }
  }
  const printable = buf.toString("latin1").match(/[\x20-\x7E]{5,}/g) ?? [];
  const candidates = printable.filter((s) => !/^(NS|__kIM|bplist|streamtyped|iI\b)/.test(s));
  return candidates.sort((a, b) => b.length - a.length)[0] ?? "";
}

async function messagesRecent(args: Record<string, any>, signal?: AbortSignal): Promise<ToolResult> {
  const dbPath = join(homedir(), "Library", "Messages", "chat.db");
  if (!existsSync(dbPath)) return { content: `Messages database not found at ${dbPath}.`, isError: true };
  const limit = Math.max(1, Math.min(Math.floor(Number(args.limit) || 20), 100));
  const chat = typeof args.chat === "string" ? args.chat.trim() : "";
  try {
    const { Database } = await import("bun:sqlite");
    const db = new Database(dbPath, { readonly: true });
    try {
      const filter = chat
        ? "WHERE (c.display_name LIKE $chat OR c.chat_identifier LIKE $chat OR h.id LIKE $chat)"
        : "";
      const rows = db
        .query(
          `SELECT m.date AS date, m.is_from_me AS fromMe, m.text AS text, m.attributedBody AS body,
                  h.id AS handle, c.display_name AS chatName, c.chat_identifier AS chatId
           FROM message m
           LEFT JOIN handle h ON m.handle_id = h.ROWID
           LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
           LEFT JOIN chat c ON c.ROWID = cmj.chat_id
           ${filter}
           ORDER BY m.date DESC LIMIT $limit`,
        )
        .all(chat ? { $chat: `%${chat}%`, $limit: limit } : ({ $limit: limit } as any)) as any[];
      if (!rows.length) {
        return { content: chat ? `No messages found matching "${chat}".` : "No messages found.", display: "0 messages" };
      }
      // Resolve phone handles to saved contact names.
      const contactMap = await getContactMap(signal).catch(() => null);
      const lines = rows.reverse().map((r) => {
        const when = new Date(appleDateToMs(Number(r.date))).toLocaleString("en-US", {
          month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
        });
        const rawHandle = r.chatName || r.handle || "unknown";
        const resolvedName = contactMap ? (resolveHandle(r.handle ?? "", contactMap) ?? rawHandle) : rawHandle;
        const who = r.fromMe ? "Me" : resolvedName;
        const dest = r.fromMe ? (resolveHandle(r.handle ?? "", contactMap ?? { phones: new Map(), emails: new Map(), byName: new Map(), expiresAt: 0 }) ?? r.handle ?? r.chatName ?? "") : "";
        const toSuffix = dest ? ` → ${dest}` : r.chatName && !r.fromMe ? "" : r.chatName ? ` → ${r.chatName}` : "";
        const body = (typeof r.text === "string" && r.text.trim()) || textFromAttributedBody(r.body) || "(attachment or reaction)";
        return `[${when}] ${who}${toSuffix}: ${body.replace(/\s+/g, " ").slice(0, 300)}`;
      });
      return {
        content: `Recent Messages${chat ? ` matching "${chat}"` : ""} (oldest first):\n${lines.join("\n")}`,
        display: `${rows.length} messages`,
      };
    } finally {
      db.close();
    }
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    if (/unable to open|authorization|SQLITE_CANTOPEN|access/i.test(msg)) {
      return {
        content:
          "Cannot read the Messages database — macOS requires Full Disk Access. " +
          "Grant it in System Settings → Privacy & Security → Full Disk Access (add your terminal app), then restart the terminal and retry.",
        isError: true,
        display: "needs Full Disk Access",
      };
    }
    return { content: `Messages read failed: ${msg}`, isError: true };
  }
}

async function messagesSearch(args: Record<string, any>, signal?: AbortSignal): Promise<ToolResult> {
  const keyword = String(args.keyword ?? "").trim();
  if (!keyword) return { content: "messages_search needs a 'keyword'.", isError: true };
  const dbPath = join(homedir(), "Library", "Messages", "chat.db");
  if (!existsSync(dbPath)) return { content: `Messages database not found at ${dbPath}.`, isError: true };
  const limit = Math.max(1, Math.min(Math.floor(Number(args.limit) || 20), 50));
  try {
    const { Database } = await import("bun:sqlite");
    const db = new Database(dbPath, { readonly: true });
    try {
      const rows = db
        .query(
          `SELECT m.date AS date, m.is_from_me AS fromMe, m.text AS text, m.attributedBody AS body,
                  h.id AS handle, c.display_name AS chatName
           FROM message m
           LEFT JOIN handle h ON m.handle_id = h.ROWID
           LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
           LEFT JOIN chat c ON c.ROWID = cmj.chat_id
           WHERE m.text LIKE $kw
           ORDER BY m.date DESC LIMIT $limit`,
        )
        .all({ $kw: `%${keyword}%`, $limit: limit }) as any[];
      if (!rows.length) return { content: `No messages found containing "${keyword}".`, display: "0 results" };
      const contactMap = await getContactMap(signal).catch(() => null);
      const lines = rows.reverse().map((r) => {
        const when = new Date(appleDateToMs(Number(r.date))).toLocaleString("en-US", {
          month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
        });
        const rawHandle = r.chatName || r.handle || "unknown";
        const resolvedName = contactMap ? (resolveHandle(r.handle ?? "", contactMap) ?? rawHandle) : rawHandle;
        const who = r.fromMe ? "Me" : resolvedName;
        const body = (typeof r.text === "string" && r.text.trim()) || textFromAttributedBody(r.body) || "";
        return `[${when}] ${who}: ${body.replace(/\s+/g, " ").slice(0, 300)}`;
      });
      return {
        content: `Messages containing "${keyword}" (oldest first):\n${lines.join("\n")}`,
        display: `${rows.length} results`,
      };
    } finally {
      db.close();
    }
  } catch (e: any) {
    return { content: `Messages search failed: ${e?.message ?? e}`, isError: true };
  }
}

async function messagesSend(args: Record<string, any>, signal?: AbortSignal): Promise<ToolResult> {
  let to = String(args.to ?? "").trim();
  const text = String(args.text ?? "").trim();
  if (!to || !text) return { content: "messages_send needs 'to' (name, phone, or email) and 'text'.", isError: true };

  // If 'to' looks like a name rather than a phone/email, resolve it via Contacts.
  if (!looksLikeAddress(to)) {
    const contactMap = await getContactMap(signal).catch(() => null);
    if (!contactMap) {
      return { content: "Could not load Contacts to resolve the name. Try passing the phone number directly.", isError: true };
    }
    const matches = searchByName(to, contactMap);
    if (!matches.length) {
      return {
        content: `No contact found matching "${to}". Check the name spelling or pass a phone number directly.`,
        isError: true,
        display: `contact "${to}" not found`,
      };
    }
    // Prefer an exact full-name match over partial matches.
    const q = to.toLowerCase();
    const exactMatch = matches.find((m) => m.name.toLowerCase() === q);
    const best = exactMatch ?? matches[0]!;
    if (!best.phones.length && !best.emails.length) {
      return {
        content: `Found "${best.name}" in Contacts but they have no phone number or email.`,
        isError: true,
      };
    }
    if (!exactMatch && matches.length > 1) {
      const names = matches.slice(0, 5).map((m) => `"${m.name}" (${m.phones[0] ?? m.emails[0] ?? "no number"})`).join(", ");
      return {
        content: `"${to}" matched multiple contacts: ${names}. Be more specific or pass the phone number directly.`,
        isError: true,
        display: `ambiguous: ${matches.length} matches`,
      };
    }
    const resolvedName = best.name;
    to = normalizePhone(best.phones[0] ?? best.emails[0] ?? to);
    // Keep the resolved name for the success message.
    const script2 =
      `tell application "Messages"\n` +
      `  set targetService to 1st service whose service type = iMessage\n` +
      `  set targetBuddy to buddy "${esc(to)}" of targetService\n` +
      `  send "${esc(text)}" to targetBuddy\n` +
      `end tell`;
    const res2 = await runOsa(script2, { signal });
    if (!res2.ok) return { content: `Sending failed: ${osaGuidance(res2.err)}`, isError: true };
    return { content: `Sent iMessage to ${resolvedName} (${to}): "${text}"`, display: `sent to ${resolvedName}` };
  }

  to = normalizePhone(to);
  const script =
    `tell application "Messages"\n` +
    `  set targetService to 1st service whose service type = iMessage\n` +
    `  set targetBuddy to buddy "${esc(to)}" of targetService\n` +
    `  send "${esc(text)}" to targetBuddy\n` +
    `end tell`;
  const res = await runOsa(script, { signal });
  if (!res.ok) return { content: `Sending failed: ${osaGuidance(res.err)}`, isError: true };
  return { content: `Sent iMessage to ${to}: "${text}"`, display: `sent to ${to}` };
}

// ── Contacts ─────────────────────────────────────────────────────────────────

async function contactsLookup(args: Record<string, any>, signal?: AbortSignal): Promise<ToolResult> {
  const query = String(args.name ?? "").trim();
  if (!query) return { content: "contacts_lookup needs a 'name'.", isError: true };
  const contactMap = await getContactMap(signal).catch(() => null);
  if (!contactMap) {
    return { content: "Could not load Contacts. Make sure your terminal has Contacts access in System Settings → Privacy & Security → Contacts.", isError: true };
  }
  const matches = searchByName(query, contactMap);
  if (!matches.length) return { content: `No contact found matching "${query}".`, display: "0 matches" };
  const lines = matches.map((m) => {
    const phones = m.phones.length ? m.phones.join(", ") : "(no phone)";
    const emails = m.emails.length ? ` | email: ${m.emails.join(", ")}` : "";
    return `${m.name}: ${phones}${emails}`;
  });
  return {
    content: `Contacts matching "${query}":\n${lines.join("\n")}`,
    display: `${matches.length} match${matches.length === 1 ? "" : "es"}`,
  };
}

// ── Notes (JXA) ──────────────────────────────────────────────────────────────

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(div|p|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Apply inline markdown (bold/italic/code/links/strike) after HTML-encoding the text. */
function inlineMd(s: string): string {
  s = hesc(s);
  s = s.replace(/\*\*\*(.+?)\*\*\*/g, "<b><i>$1</i></b>");
  s = s.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  s = s.replace(/__(.+?)__/g, "<b>$1</b>");
  s = s.replace(/\*(.+?)\*/g, "<i>$1</i>");
  s = s.replace(/_(.+?)_/g, "<i>$1</i>");
  s = s.replace(/~~(.+?)~~/g, "<s>$1</s>");
  s = s.replace(/`(.+?)`/g, "<tt>$1</tt>");
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  return s;
}

/**
 * Convert markdown to Apple Notes HTML.
 * Supports: headings (#/##/###), bullets (- * +), numbered lists,
 * bold (**), italic (*), strikethrough (~~), inline code (`), links ([t](url)).
 * The h1 is reserved for the note title; # maps to h2.
 */
function mdToHtml(md: string): string {
  if (!md.trim()) return "";
  const lines = md.split("\n");
  const out: string[] = [];
  let inUl = false;
  let inOl = false;

  const closeList = (): void => {
    if (inUl) { out.push("</ul>"); inUl = false; }
    if (inOl) { out.push("</ol>"); inOl = false; }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    const ulM = /^[ \t]*[-*+] (.+)/.exec(line);
    if (ulM) {
      if (inOl) { out.push("</ol>"); inOl = false; }
      if (!inUl) { out.push("<ul>"); inUl = true; }
      out.push(`<li>${inlineMd(ulM[1]!)}</li>`);
      continue;
    }

    const olM = /^[ \t]*\d+[.)]\s+(.+)/.exec(line);
    if (olM) {
      if (inUl) { out.push("</ul>"); inUl = false; }
      if (!inOl) { out.push("<ol>"); inOl = true; }
      out.push(`<li>${inlineMd(olM[1]!)}</li>`);
      continue;
    }

    closeList();

    const hM = /^(#{1,6}) (.+)/.exec(line);
    if (hM) {
      const level = Math.min(hM[1]!.length + 1, 3);
      out.push(`<h${level}>${inlineMd(hM[2]!)}</h${level}>`);
      continue;
    }

    if (!line.trim()) { out.push("<br>"); continue; }

    out.push(`${inlineMd(line)}<br>`);
  }

  closeList();
  return out.join("");
}

async function notesList(args: Record<string, any>, signal?: AbortSignal): Promise<ToolResult> {
  const limit = Math.max(1, Math.min(Math.floor(Number(args.limit) || 25), 100));
  const folder = typeof args.folder === "string" ? args.folder.trim() : "";
  const script =
    "function run(argv){" +
    'const app=Application("Notes");const limit=Number(argv[0]);const folder=argv[1];' +
    "const col=folder?app.folders.byName(folder).notes:app.notes;" +
    "const all=col();all.sort((a,b)=>b.modificationDate()-a.modificationDate());" +
    "const rows=[];for(let i=0;i<Math.min(all.length,limit);i++){try{" +
    "const n=all[i];const date=n.modificationDate();" +
    "const raw=n.body()||'';const snippet=raw.replace(/<[^>]+>/g,' ').replace(/&[^;]{1,7};/g,' ').replace(/\\s+/g,' ').trim().slice(0,100);" +
    "rows.push(date.toISOString().slice(0,10)+' | '+n.name()+(snippet?' — '+snippet:''));" +
    "}catch(e){}}" +
    'return rows.join("\\n");' +
    "}";
  const res = await runOsa(script, { lang: "JavaScript", args: [String(limit), folder], signal });
  if (!res.ok) {
    return {
      content: `Could not list Notes: ${osaGuidance(res.err)}`,
      display: "notes unavailable",
    };
  }
  return {
    content: res.out ? `Notes${folder ? ` in "${folder}"` : ""} (newest first):\n${res.out}` : "No notes found.",
    display: `${res.out ? res.out.split("\n").length : 0} notes`,
  };
}

async function notesRead(args: Record<string, any>, signal?: AbortSignal): Promise<ToolResult> {
  const title = String(args.title ?? "").trim();
  if (!title) return { content: "notes_read needs a 'title'.", isError: true };
  const script =
    "function run(argv){" +
    'const app=Application("Notes");const hits=app.notes.whose({name:{_contains:argv[0]}});' +
    'if(hits.length===0)return "SOPHIE_NOT_FOUND";' +
    "return hits[0].name()+\"\\n---\\n\"+hits[0].body();" +
    "}";
  const res = await runOsa(script, { lang: "JavaScript", args: [title], signal });
  if (!res.ok) return { content: `Notes read failed: ${osaGuidance(res.err)}`, isError: true };
  if (res.out === "SOPHIE_NOT_FOUND") return { content: `No note with a title containing "${title}".`, isError: true };
  const [name, ...rest] = res.out.split("\n---\n");
  const body = stripHtml(rest.join("\n---\n"));
  return { content: `Note: ${name}\n\n${body.slice(0, 12_000)}`, display: name };
}

async function notesCreate(args: Record<string, any>, signal?: AbortSignal): Promise<ToolResult> {
  const title = String(args.title ?? "").trim();
  const body = String(args.body ?? "").trim();
  if (!title) return { content: "notes_create needs a 'title' (body optional).", isError: true };
  const folder = typeof args.folder === "string" ? args.folder.trim() : "";
  const bodyHtml = body ? mdToHtml(body) : "";
  const fullHtml = `<h1>${hesc(title)}</h1>${bodyHtml ? `<br>${bodyHtml}` : ""}`;
  const script =
    "function run(argv){" +
    'const app=Application("Notes");const html=argv[0];const folder=argv[1];' +
    'const props={body:html};' +
    'if(folder){app.make({new:"note",at:app.folders.byName(folder),withProperties:props});}' +
    'else{app.make({new:"note",withProperties:props});}' +
    'return "ok";' +
    "}";
  const res = await runOsa(script, { lang: "JavaScript", args: [fullHtml, folder], signal });
  if (!res.ok) return { content: `Note creation failed: ${osaGuidance(res.err)}`, isError: true };
  return { content: `Created note "${title}"${folder ? ` in folder "${folder}"` : ""}.`, display: `note: ${title}` };
}

async function notesAppend(args: Record<string, any>, signal?: AbortSignal): Promise<ToolResult> {
  const title = String(args.title ?? "").trim();
  const body = String(args.body ?? "").trim();
  if (!title || !body) return { content: "notes_append needs 'title' and 'body'.", isError: true };
  const appended = mdToHtml(body);
  const script =
    "function run(argv){" +
    'const app=Application("Notes");const hits=app.notes.whose({name:{_contains:argv[0]}});' +
    'if(hits.length===0)return "SOPHIE_NOT_FOUND";' +
    "const note=hits[0];note.body=(note.body()||'')+'<br>'+argv[1];" +
    "return note.name();" +
    "}";
  const res = await runOsa(script, { lang: "JavaScript", args: [title, appended], signal });
  if (!res.ok) return { content: `Notes append failed: ${osaGuidance(res.err)}`, isError: true };
  if (res.out === "SOPHIE_NOT_FOUND") return { content: `No note with a title containing "${title}".`, isError: true };
  return { content: `Appended to note "${res.out}".`, display: `appended: ${res.out}` };
}

async function notesReplace(args: Record<string, any>, signal?: AbortSignal): Promise<ToolResult> {
  const title = String(args.title ?? "").trim();
  const body = String(args.body ?? "").trim();
  if (!title || !body) return { content: "notes_replace needs 'title' and 'body'.", isError: true };
  const newHtml = mdToHtml(body);
  const script =
    "function run(argv){" +
    'const app=Application("Notes");const hits=app.notes.whose({name:{_contains:argv[0]}});' +
    'if(hits.length===0)return "SOPHIE_NOT_FOUND";' +
    "const note=hits[0];const cur=note.body()||'';" +
    "const h1End=cur.indexOf('</h1>');const header=h1End!==-1?cur.slice(0,h1End+5):'<h1>'+note.name()+'</h1>';" +
    "note.body=header+'<br>'+argv[1];" +
    "return note.name();" +
    "}";
  const res = await runOsa(script, { lang: "JavaScript", args: [title, newHtml], signal });
  if (!res.ok) return { content: `Notes replace failed: ${osaGuidance(res.err)}`, isError: true };
  if (res.out === "SOPHIE_NOT_FOUND") return { content: `No note with a title containing "${title}".`, isError: true };
  return { content: `Replaced body of note "${res.out}".`, display: `updated: ${res.out}` };
}

async function notesRename(args: Record<string, any>, signal?: AbortSignal): Promise<ToolResult> {
  const title = String(args.title ?? "").trim();
  const newTitle = typeof args.new_title === "string" ? args.new_title.trim() : "";
  if (!title || !newTitle) return { content: "notes_rename needs 'title' and 'new_title'.", isError: true };
  const newTitleHtml = hesc(newTitle);
  const script =
    "function run(argv){" +
    'const app=Application("Notes");const hits=app.notes.whose({name:{_contains:argv[0]}});' +
    'if(hits.length===0)return "SOPHIE_NOT_FOUND";' +
    "const note=hits[0];const oldName=note.name();const cur=note.body()||'';" +
    "const h1End=cur.indexOf('</h1>');const rest=h1End!==-1?cur.slice(h1End+5):cur;" +
    "note.body='<h1>'+argv[1]+'</h1>'+rest;" +
    "return oldName;" +
    "}";
  const res = await runOsa(script, { lang: "JavaScript", args: [title, newTitleHtml], signal });
  if (!res.ok) return { content: `Rename failed: ${osaGuidance(res.err)}`, isError: true };
  if (res.out === "SOPHIE_NOT_FOUND") return { content: `No note with a title containing "${title}".`, isError: true };
  return { content: `Renamed "${res.out}" → "${newTitle}".`, display: `renamed: ${newTitle}` };
}

async function notesDelete(args: Record<string, any>, signal?: AbortSignal): Promise<ToolResult> {
  const title = String(args.title ?? "").trim();
  if (!title) return { content: "notes_delete needs a 'title'.", isError: true };
  const script =
    "function run(argv){" +
    'const app=Application("Notes");' +
    'const hits=app.notes.whose({name:{_contains:argv[0]}});' +
    'if(hits.length===0)return "SOPHIE_NOT_FOUND";' +
    'const name=hits[0].name();app.delete(hits[0]);return name;' +
    "}";
  const res = await runOsa(script, { lang: "JavaScript", args: [title], signal });
  if (!res.ok) return { content: `Delete failed: ${osaGuidance(res.err)}`, isError: true };
  if (res.out === "SOPHIE_NOT_FOUND") return { content: `No note with a title containing "${title}".`, isError: true };
  return { content: `Deleted note "${res.out}".`, display: `deleted: ${res.out}` };
}

async function notesMove(args: Record<string, any>, signal?: AbortSignal): Promise<ToolResult> {
  const title = String(args.title ?? "").trim();
  const folder = typeof args.folder === "string" ? args.folder.trim() : "";
  if (!title || !folder) return { content: "notes_move needs 'title' and 'folder'.", isError: true };
  const script =
    "function run(argv){" +
    'const app=Application("Notes");' +
    'const hits=app.notes.whose({name:{_contains:argv[0]}});' +
    'if(hits.length===0)return "SOPHIE_NOT_FOUND";' +
    'const name=hits[0].name();app.move(hits[0],{to:app.folders.byName(argv[1])});return name;' +
    "}";
  const res = await runOsa(script, { lang: "JavaScript", args: [title, folder], signal });
  if (!res.ok) return { content: `Move failed: ${osaGuidance(res.err)}`, isError: true };
  if (res.out === "SOPHIE_NOT_FOUND") return { content: `No note with a title containing "${title}".`, isError: true };
  return { content: `Moved "${res.out}" to folder "${folder}".`, display: `moved: ${res.out}` };
}

async function notesSearch(args: Record<string, any>, signal?: AbortSignal): Promise<ToolResult> {
  const keyword = String(args.keyword ?? "").trim();
  if (!keyword) return { content: "notes_search needs a 'keyword'.", isError: true };
  const limit = Math.max(1, Math.min(Math.floor(Number(args.limit) || 10), 30));
  const folder = typeof args.folder === "string" ? args.folder.trim() : "";
  const script =
    "function run(argv){" +
    'const app=Application("Notes");const kw=argv[0].toLowerCase();const limit=Number(argv[1]);const folder=argv[2];' +
    "const col=folder?app.folders.byName(folder).notes:app.notes;const all=col();const hits=[];" +
    "for(const n of all){try{" +
    "const name=n.name()||'';const body=n.body()||'';" +
    "if(name.toLowerCase().includes(kw)||body.toLowerCase().includes(kw)){" +
    "const date=n.modificationDate();const snippet=body.replace(/<[^>]+>/g,' ').replace(/&[^;]{1,7};/g,' ').replace(/\\s+/g,' ').trim().slice(0,100);" +
    "hits.push(date.toISOString().slice(0,10)+' | '+name+(snippet?' — '+snippet:''));}" +
    "}catch(e){} if(hits.length>=limit)break;}" +
    'return hits.join("\\n");' +
    "}";
  const res = await runOsa(script, { lang: "JavaScript", args: [keyword, String(limit), folder], signal });
  if (!res.ok) return { content: `Notes search failed: ${osaGuidance(res.err)}`, isError: true };
  if (!res.out) return { content: `No notes found containing "${keyword}".`, display: "0 results" };
  return {
    content: `Notes containing "${keyword}":\n${res.out}`,
    display: `${res.out.split("\n").length} result${res.out.split("\n").length === 1 ? "" : "s"}`,
  };
}

async function foldersList(signal?: AbortSignal): Promise<ToolResult> {
  const script =
    "function run(){" +
    'const app=Application("Notes");const folders=app.folders();const rows=[];' +
    "for(const f of folders){try{rows.push(f.name()+' ('+f.notes().length+' notes)');}catch(e){}}" +
    'return rows.join("\\n");' +
    "}";
  const res = await runOsa(script, { lang: "JavaScript", signal });
  if (!res.ok) return { content: `Folders list failed: ${osaGuidance(res.err)}`, isError: true };
  return {
    content: res.out ? `Notes folders:\n${res.out}` : "No folders found.",
    display: res.out ? `${res.out.split("\n").length} folders` : "0 folders",
  };
}

async function folderCreate(args: Record<string, any>, signal?: AbortSignal): Promise<ToolResult> {
  const name = typeof args.folder === "string" ? args.folder.trim() : "";
  if (!name) return { content: "folders_create needs a 'folder' name.", isError: true };
  const script =
    "function run(argv){" +
    'const app=Application("Notes");' +
    'app.make({new:"folder",withProperties:{name:argv[0]}});return argv[0];' +
    "}";
  const res = await runOsa(script, { lang: "JavaScript", args: [name], signal });
  if (!res.ok) return { content: `Folder creation failed: ${osaGuidance(res.err)}`, isError: true };
  return { content: `Created Notes folder "${name}".`, display: `folder: ${name}` };
}

// ── Reminders (JXA) ──────────────────────────────────────────────────────────

async function ensureReminderList(name: string, signal?: AbortSignal): Promise<boolean> {
  const script =
    "function run(argv){" +
    'const app=Application("Reminders");const name=argv[0];' +
    "try{app.lists.byName(name).name();return 'ok';}catch(e){app.lists.push(app.List({name}));return 'created';}" +
    "}";
  const res = await runOsa(script, { lang: "JavaScript", args: [name], signal });
  return res.ok;
}

async function remindersLists(signal?: AbortSignal): Promise<ToolResult> {
  const script =
    "function run(){" +
    'const app=Application("Reminders");' +
    "const lists=app.lists();const rows=[];" +
    "for(const l of lists){try{const name=l.name();const count=l.reminders.whose({completed:false}).length;rows.push(name+' ('+count+' open)');}catch(e){}}" +
    'return rows.join("\\n");' +
    "}";
  const res = await runOsa(script, { lang: "JavaScript", signal });
  if (!res.ok) return { content: `Reminders lists failed: ${osaGuidance(res.err)}`, isError: true };
  return {
    content: res.out ? `Reminder lists:\n${res.out}` : "No reminder lists found.",
    display: res.out ? `${res.out.split("\n").length} lists` : "0 lists",
  };
}

async function remindersList(args: Record<string, any>, signal?: AbortSignal): Promise<ToolResult> {
  const listName = typeof args.list === "string" ? args.list.trim() : "";
  const limit = Math.max(1, Math.min(Math.floor(Number(args.limit) || 30), 100));
  const script =
    "function run(argv){" +
    'const app=Application("Reminders");const listName=argv[0];const limit=Number(argv[1]);' +
    "const list=listName?app.lists.byName(listName):app.defaultList();" +
    "const rs=list.reminders.whose({completed:false});" +
    "const names=rs.name();const dues=rs.dueDate();const notes=rs.body();" +
    "return names.slice(0,limit).map((n,i)=>{const d=dues[i];" +
    'const note=notes[i]?(" | "+notes[i].slice(0,80)):"";' +
    'return (d?d.toISOString().slice(0,16).replace("T"," "):"no due date")+" | "+n+note;}).join("\\n");' +
    "}";
  const res = await runOsa(script, { lang: "JavaScript", args: [listName, String(limit)], signal });
  if (!res.ok) return { content: `Reminders list failed: ${osaGuidance(res.err)}`, isError: true };
  return {
    content: res.out
      ? `Open reminders${listName ? ` in "${listName}"` : ""}:\n${res.out}`
      : `No open reminders${listName ? ` in "${listName}"` : ""}.`,
    display: `${res.out ? res.out.split("\n").length : 0} open`,
  };
}

async function remindersCreate(args: Record<string, any>, signal?: AbortSignal): Promise<ToolResult> {
  const name = String(args.name ?? "").trim();
  if (!name) return { content: "reminders_create needs a 'name'.", isError: true };
  const listName = typeof args.list === "string" ? args.list.trim() : "";
  const notes = typeof args.notes === "string" ? args.notes.trim() : "";
  const due = typeof args.due === "string" ? args.due.trim() : "";
  let dueMs = 0;
  if (due) {
    const parsed = new Date(due.includes("T") || due.includes(" ") ? due : `${due}T09:00`);
    if (!Number.isFinite(parsed.getTime())) return { content: `Could not parse due time "${due}". Use ISO like 2026-07-03 18:00.`, isError: true };
    dueMs = parsed.getTime();
  }
  const script =
    "function run(argv){" +
    'const app=Application("Reminders");const listName=argv[0];' +
    "const list=listName?app.lists.byName(listName):app.defaultList();" +
    "const props={name:argv[1]};" +
    "if(argv[2])props.body=argv[2];" +
    "if(argv[3]!=='0')props.dueDate=new Date(Number(argv[3]));" +
    "list.reminders.push(app.Reminder(props));" +
    'return "ok";' +
    "}";
  const res = await runOsa(script, { lang: "JavaScript", args: [listName, name, notes, String(dueMs)], signal });
  if (!res.ok) return { content: `Reminder creation failed: ${osaGuidance(res.err)}`, isError: true };
  return {
    content: `Created reminder "${name}"${dueMs ? ` due ${new Date(dueMs).toLocaleString()}` : ""}${listName ? ` in "${listName}"` : ""}.`,
    display: `reminder: ${name}`,
  };
}

async function remindersUpdate(args: Record<string, any>, signal?: AbortSignal): Promise<ToolResult> {
  const name = String(args.name ?? "").trim();
  if (!name) return { content: "reminders_update needs 'name' to find the reminder.", isError: true };
  const listName = typeof args.list === "string" ? args.list.trim() : "";
  const newName = typeof args.new_name === "string" ? args.new_name.trim() : "";
  const due = typeof args.due === "string" ? args.due.trim() : "";
  const notes = typeof args.notes === "string" ? args.notes.trim() : "";
  let dueMs = 0;
  if (due) {
    const parsed = new Date(due.includes("T") || due.includes(" ") ? due : `${due}T09:00`);
    if (!Number.isFinite(parsed.getTime())) return { content: `Could not parse due time "${due}". Use ISO like 2026-07-03 18:00.`, isError: true };
    dueMs = parsed.getTime();
  }
  const script =
    "function run(argv){" +
    'const app=Application("Reminders");const listName=argv[0];' +
    "const list=listName?app.lists.byName(listName):app.defaultList();" +
    "const hits=list.reminders.whose({completed:false,name:{_contains:argv[1]}});" +
    'if(hits.length===0)return "SOPHIE_NOT_FOUND";' +
    "const r=hits[0];const original=r.name();" +
    "if(argv[2])r.name=argv[2];" +
    "if(argv[3]!=='0')r.dueDate=new Date(Number(argv[3]));" +
    "if(argv[4])r.body=argv[4];" +
    "return original;" +
    "}";
  const res = await runOsa(script, { lang: "JavaScript", args: [listName, name, newName, String(dueMs), notes], signal });
  if (!res.ok) return { content: `Reminder update failed: ${osaGuidance(res.err)}`, isError: true };
  if (res.out === "SOPHIE_NOT_FOUND") return { content: `No open reminder matching "${name}".`, isError: true };
  const changes = [newName && `renamed to "${newName}"`, dueMs && `due → ${new Date(dueMs).toLocaleString()}`, notes && `notes updated`].filter(Boolean).join(", ");
  return { content: `Updated reminder "${res.out}"${changes ? `: ${changes}` : ""}.`, display: `updated: ${res.out}` };
}

async function remindersComplete(args: Record<string, any>, signal?: AbortSignal): Promise<ToolResult> {
  const name = String(args.name ?? "").trim();
  if (!name) return { content: "reminders_complete needs a 'name'.", isError: true };
  const listName = typeof args.list === "string" ? args.list.trim() : "";
  const script =
    "function run(argv){" +
    'const app=Application("Reminders");const listName=argv[0];' +
    "const list=listName?app.lists.byName(listName):app.defaultList();" +
    "const hits=list.reminders.whose({completed:false,name:{_contains:argv[1]}});" +
    'if(hits.length===0){return "SOPHIE_NOT_FOUND";}' +
    "const n=hits[0].name();hits[0].completed=true;return n;" +
    "}";
  const res = await runOsa(script, { lang: "JavaScript", args: [listName, name], signal });
  if (!res.ok) return { content: `Completing reminder failed: ${osaGuidance(res.err)}`, isError: true };
  if (res.out === "SOPHIE_NOT_FOUND") return { content: `No open reminder matching "${name}".`, isError: true };
  return { content: `Marked reminder "${res.out}" completed.`, display: `done: ${res.out}` };
}

// ── Alarm-like alerts (Reminders-backed) ─────────────────────────────────────

const ALARM_LIST = "Sophie Alarms";

function parseAlarmTime(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  const hm = s.match(/^(\d{1,2}):(\d{2})$/);
  if (hm) {
    const d = new Date();
    d.setHours(Number(hm[1]), Number(hm[2]), 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  const d = new Date(s.includes("T") || s.includes(" ") ? s : `${s}T09:00`);
  return Number.isFinite(d.getTime()) ? d.getTime() : null;
}

async function alarmsCreate(args: Record<string, any>, signal?: AbortSignal): Promise<ToolResult> {
  const title = String(args.title ?? args.name ?? "Alarm").trim() || "Alarm";
  const atRaw = String(args.at ?? args.due ?? "").trim();
  if (!atRaw) return { content: "alarms_create needs 'at' (HH:MM, ISO, or YYYY-MM-DD HH:MM).", isError: true };
  const at = parseAlarmTime(atRaw);
  if (at == null || at <= Date.now()) return { content: `Could not parse a future alarm time from "${atRaw}".`, isError: true };
  await ensureReminderList(ALARM_LIST, signal);
  const script =
    "function run(argv){" +
    'const app=Application("Reminders");const list=app.lists.byName(argv[0]);' +
    "const r=app.Reminder({name:argv[1],body:'Created by Sophie as an alarm-like alert.',remindMeDate:new Date(Number(argv[2])),dueDate:new Date(Number(argv[2]))});" +
    "list.reminders.push(r);return r.id();" +
    "}";
  const res = await runOsa(script, { lang: "JavaScript", args: [ALARM_LIST, title, String(at)], signal });
  if (!res.ok) return { content: `Alarm creation failed: ${osaGuidance(res.err)}`, isError: true };
  return { content: `Created Apple Reminders alarm "${title}" for ${new Date(at).toLocaleString()}.`, display: `alarm: ${title}` };
}

async function alarmsList(signal?: AbortSignal): Promise<ToolResult> {
  await ensureReminderList(ALARM_LIST, signal);
  return remindersList({ list: ALARM_LIST, limit: 50 }, signal);
}

async function alarmsCancel(args: Record<string, any>, signal?: AbortSignal): Promise<ToolResult> {
  return remindersComplete({ name: args.name ?? args.title, list: ALARM_LIST }, signal);
}

// ── the tool ─────────────────────────────────────────────────────────────────

export const apple: Tool = {
  name: "apple",
  preconditions: ["Only available when the Environment Machine is macOS (darwin). On Windows/Linux, use cross-platform Sophie tools such as calendar, schedule, notify, and email."],
  description:
    "macOS ecosystem bridge — Contacts, iMessage, Notes, Reminders, and Apple-backed alarm alerts.\n" +
    "Actions:\n" +
    "• contacts_lookup — search Contacts by name → get phone numbers / emails (messages_send resolves names itself; only use this to preview matches before sending)\n" +
    "• messages_recent — recent iMessages; optional 'chat' filter by name/number; shows saved contact names\n" +
    "• messages_search — search message bodies by keyword\n" +
    "• messages_send — send an iMessage; 'to' can be a contact name (resolved automatically), phone number, or email\n" +
    "• notes_list — list notes newest-first with snippet preview; optional 'folder' filter\n" +
    "• notes_read — read full note body by title (partial match)\n" +
    "• notes_create — create a note; body supports markdown (bold, italic, lists, headings, links)\n" +
    "• notes_append — append markdown content to an existing note\n" +
    "• notes_replace — overwrite a note's body (keeps title)\n" +
    "• notes_rename — rename a note\n" +
    "• notes_delete — delete a note permanently\n" +
    "• notes_move — move a note to a different folder\n" +
    "• notes_search — full-text search across notes; optional 'folder' filter\n" +
    "• folders_list — list all Notes folders with note counts\n" +
    "• folders_create — create a new folder\n" +
    "• reminders_lists — list all Reminders lists and open counts\n" +
    "• reminders_list / reminders_create / reminders_update / reminders_complete\n" +
    "• alarms_create / alarms_list / alarms_cancel — alarm-like alerts backed by the Apple Reminders app; prefer Sophie's schedule tool for cross-platform alarms\n" +
    "macOS only. First use of each app triggers a one-time system permission prompt. Reading Messages needs Full Disk Access.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [
          "contacts_lookup",
          "messages_recent", "messages_search", "messages_send",
          "notes_list", "notes_read", "notes_create", "notes_append", "notes_replace",
          "notes_rename", "notes_delete", "notes_move", "notes_search",
          "folders_list", "folders_create",
          "reminders_lists", "reminders_list", "reminders_create", "reminders_update", "reminders_complete",
          "alarms_create", "alarms_list", "alarms_cancel",
        ],
        description: "What to do.",
      },
      // contacts
      name: { type: "string", description: "contacts_lookup: name to search for. reminders_create/update/complete: reminder name." },
      // messages
      chat: { type: "string", description: "messages_recent: filter by contact name, number, or group name." },
      keyword: { type: "string", description: "messages_search / notes_search: text to search for." },
      to: { type: "string", description: "messages_send: recipient — contact name (resolved automatically), phone number, or email." },
      text: {
        type: "string",
        description:
          "messages_send: the message text. Write as Sophie the assistant relay; I/me/my refer to Sophie.",
      },
      limit: { type: "number", description: "Max items to return (messages/notes/reminders lists)." },
      // notes
      title: { type: "string", description: "Note title. For read/append/replace/rename/delete/move: partial match. For create: exact title." },
      body: { type: "string", description: "notes_create / notes_append / notes_replace: body text. Supports markdown: **bold**, *italic*, - bullets, 1. lists, ## headings, `code`, [text](url), ~~strike~~." },
      new_title: { type: "string", description: "notes_rename: the new title." },
      folder: { type: "string", description: "Notes folder name. notes_list/notes_search: filter to this folder. notes_create/notes_move: target folder. folders_create: folder to create." },
      // reminders
      due: { type: "string", description: "reminders_create / reminders_update: due time — ISO or 'YYYY-MM-DD HH:MM'." },
      notes: { type: "string", description: "reminders_create / reminders_update: extra note text on the reminder." },
      new_name: { type: "string", description: "reminders_update: rename the reminder to this." },
      list: { type: "string", description: "Reminders list name (default: the default list)." },
      at: { type: "string", description: "alarms_create: alarm time — HH:MM, ISO, or 'YYYY-MM-DD HH:MM'." },
    },
    required: ["action"],
  },
  summarize: (a) => {
    const action = String(a.action ?? "");
    if (action === "contacts_lookup") return `contacts: ${a.name}`;
    if (action === "messages_send") return `iMessage → ${a.to}`;
    if (action === "messages_recent") return a.chat ? `messages · ${a.chat}` : "recent messages";
    if (action === "messages_search") return `messages search: ${a.keyword}`;
    if (action.startsWith("notes")) return `${action.replace("notes_", "notes: ")}${a.title ? ` "${a.title}"` : a.keyword ? ` "${a.keyword}"` : ""}`;
    if (action === "folders_list") return "notes folders";
    if (action === "folders_create") return `create folder "${a.folder}"`;
    if (action === "reminders_lists") return "reminder lists";
    if (action === "alarms_create") return `alarm "${a.title ?? a.name ?? "Alarm"}" at ${a.at ?? a.due ?? "?"}`;
    if (action === "alarms_list") return "alarms list";
    if (action === "alarms_cancel") return `cancel alarm "${a.name ?? a.title ?? "?"}"`;
    return `${action.replace("reminders_", "reminders: ")}${a.name ? ` "${a.name}"` : ""}`;
  },
  risk: (a) => {
    if (a.action === "messages_send" || a.action === "notes_delete") return "caution";
    return "safe";
  },
  async execute(args, ctx) {
    if (platform() !== "darwin") return { content: "The apple tool only works on macOS.", isError: true };
    const action = String(args.action ?? "");
    switch (action) {
      case "contacts_lookup":    return contactsLookup(args, ctx.signal);
      case "messages_recent":    return messagesRecent(args, ctx.signal);
      case "messages_search":    return messagesSearch(args, ctx.signal);
      case "messages_send":      return messagesSend(args, ctx.signal);
      case "notes_list":         return notesList(args, ctx.signal);
      case "notes_read":         return notesRead(args, ctx.signal);
      case "notes_create":       return notesCreate(args, ctx.signal);
      case "notes_append":       return notesAppend(args, ctx.signal);
      case "notes_replace":      return notesReplace(args, ctx.signal);
      case "notes_rename":       return notesRename(args, ctx.signal);
      case "notes_delete":       return notesDelete(args, ctx.signal);
      case "notes_move":         return notesMove(args, ctx.signal);
      case "notes_search":       return notesSearch(args, ctx.signal);
      case "folders_list":       return foldersList(ctx.signal);
      case "folders_create":     return folderCreate(args, ctx.signal);
      case "reminders_lists":    return remindersLists(ctx.signal);
      case "reminders_list":     return remindersList(args, ctx.signal);
      case "reminders_create":   return remindersCreate(args, ctx.signal);
      case "reminders_update":   return remindersUpdate(args, ctx.signal);
      case "reminders_complete": return remindersComplete(args, ctx.signal);
      case "alarms_create":      return alarmsCreate(args, ctx.signal);
      case "alarms_list":        return alarmsList(ctx.signal);
      case "alarms_cancel":      return alarmsCancel(args, ctx.signal);
      default:
        return { content: `Unknown apple action "${action}".`, isError: true };
    }
  },
};
