import { existsSync, statSync } from "node:fs";
import { platform } from "node:os";
import { extname } from "node:path";
import { resolvePath } from "../system/paths.ts";
import type { Tool, ToolResult } from "./types.ts";

/**
 * read_document — text extraction from the file formats real life arrives in:
 * PDFs, Word docs, RTF, ODT, HTML. read_file covers plain text; this tool covers
 * everything that would come back as mojibake. Extraction is converter-based
 * (no bundled parser): pdftotext (poppler) when installed, the built-in PDFKit
 * via JXA on macOS, textutil on macOS for Word/RTF/HTML, pandoc anywhere.
 */

const PDF_EXTS = new Set([".pdf"]);
const TEXTUTIL_EXTS = new Set([".doc", ".docx", ".rtf", ".rtfd", ".odt", ".html", ".htm", ".webarchive", ".wordml"]);

async function runCmd(
  cmd: string[],
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore", signal: opts.signal });
    const timer = setTimeout(() => proc.kill(), opts.timeoutMs ?? 60_000);
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    clearTimeout(timer);
    return { ok: code === 0, stdout, stderr };
  } catch (e: any) {
    return { ok: false, stdout: "", stderr: e?.message ?? String(e) };
  }
}

async function hasCmd(name: string): Promise<boolean> {
  const { ok } = await runCmd(["which", name], { timeoutMs: 4000 });
  return ok;
}

/** PDF → text via macOS's built-in PDFKit (JXA) — the zero-install fallback. */
async function pdfViaPdfKit(path: string, signal?: AbortSignal): Promise<{ ok: boolean; text: string; err: string }> {
  const script =
    'ObjC.import("Quartz");' +
    "function run(argv){" +
    "const d=$.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0]));" +
    'if(!d||d.isNil()){return "SOPHIE_PDF_ERROR: could not open PDF";}' +
    "const s=d.string;" +
    'return s&&!s.isNil()?s.js:"";' +
    "}";
  const res = await runCmd(["osascript", "-l", "JavaScript", "-e", script, path], { signal, timeoutMs: 60_000 });
  if (!res.ok) return { ok: false, text: "", err: res.stderr.trim() || "osascript failed" };
  if (res.stdout.startsWith("SOPHIE_PDF_ERROR")) return { ok: false, text: "", err: res.stdout.trim() };
  return { ok: true, text: res.stdout, err: "" };
}

async function extract(path: string, args: Record<string, any>, signal?: AbortSignal): Promise<{ text: string; via: string } | ToolResult> {
  const ext = extname(path).toLowerCase();
  const os = platform();

  if (PDF_EXTS.has(ext)) {
    if (await hasCmd("pdftotext")) {
      const pageArgs: string[] = [];
      if (Number.isFinite(Number(args.first_page)) && Number(args.first_page) > 0) pageArgs.push("-f", String(Math.floor(Number(args.first_page))));
      if (Number.isFinite(Number(args.last_page)) && Number(args.last_page) > 0) pageArgs.push("-l", String(Math.floor(Number(args.last_page))));
      const res = await runCmd(["pdftotext", "-layout", ...pageArgs, path, "-"], { signal });
      if (res.ok) return { text: res.stdout, via: "pdftotext" };
      return { content: `pdftotext failed on ${path}: ${res.stderr.trim().slice(0, 300)}`, isError: true };
    }
    if (os === "darwin") {
      const res = await pdfViaPdfKit(path, signal);
      if (res.ok) return { text: res.text, via: "PDFKit" };
      return { content: `PDF extraction failed on ${path}: ${res.err.slice(0, 300)}. Installing poppler (brew install poppler) enables pdftotext.`, isError: true };
    }
    return { content: "No PDF extractor available. Install poppler (pdftotext) and retry.", isError: true };
  }

  if (TEXTUTIL_EXTS.has(ext)) {
    if (os === "darwin") {
      const res = await runCmd(["textutil", "-convert", "txt", "-stdout", path], { signal });
      if (res.ok) return { text: res.stdout, via: "textutil" };
      return { content: `textutil failed on ${path}: ${res.stderr.trim().slice(0, 300)}`, isError: true };
    }
    if (await hasCmd("pandoc")) {
      const res = await runCmd(["pandoc", "-t", "plain", path], { signal });
      if (res.ok) return { text: res.stdout, via: "pandoc" };
      return { content: `pandoc failed on ${path}: ${res.stderr.trim().slice(0, 300)}`, isError: true };
    }
    return { content: `No converter available for ${ext}. Install pandoc and retry.`, isError: true };
  }

  return {
    content:
      `Unsupported document type "${ext || "(no extension)"}". This tool reads PDF/DOC/DOCX/RTF/ODT/HTML; ` +
      "for plain text and code use read_file.",
    isError: true,
  };
}

export const readDocument: Tool = {
  name: "read_document",
  description:
    "Extract the text of a PDF, Word (.doc/.docx), RTF, ODT, or HTML document — the formats " +
    "read_file cannot handle. Supports PDF page ranges (first_page/last_page) and offset/max_chars " +
    "for long documents. Use read_file for plain text and code.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the document (absolute or relative to cwd)." },
      first_page: { type: "number", description: "PDF only: first page to extract (1-based)." },
      last_page: { type: "number", description: "PDF only: last page to extract (1-based)." },
      offset: { type: "number", description: "Skip this many characters of extracted text (default 0)." },
      max_chars: { type: "number", description: "Max characters returned (default 20000)." },
    },
    required: ["path"],
  },
  summarize: (a) => `read ${a.path}`,
  risk: () => "safe",
  async execute(args, ctx) {
    const path = resolvePath(ctx.cwd, String(args.path ?? ""));
    if (!existsSync(path)) return { content: `File not found: ${path}`, isError: true };
    if (statSync(path).isDirectory()) return { content: `${path} is a directory, not a document.`, isError: true };

    const result = await extract(path, args, ctx.signal);
    if (!("text" in result)) return result;

    const full = result.text.replace(/\r\n/g, "\n").replace(/\n{4,}/g, "\n\n\n").trim();
    if (!full) {
      return {
        content: `No extractable text in ${path} (via ${result.via}). It may be a scanned/image-only document.`,
        isError: true,
        display: "no text",
      };
    }
    const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
    const maxChars = Math.max(200, Math.min(Math.floor(Number(args.max_chars) || 20_000), 60_000));
    const slice = full.slice(offset, offset + maxChars);
    const remaining = full.length - offset - slice.length;
    return {
      content:
        `Document: ${path} (via ${result.via}, ${full.length} chars total` +
        `${offset ? `, from offset ${offset}` : ""})\n\n${slice}` +
        (remaining > 0 ? `\n\n…[${remaining} more characters — call again with offset=${offset + slice.length}]` : ""),
      display: `${slice.length} chars via ${result.via}`,
    };
  },
};
