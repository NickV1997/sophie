import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clipForHistory } from "../src/agent/context.ts";
import { grep } from "../src/tools/fs.ts";
import { pageTitle, stripHtml } from "../src/tools/web.ts";

describe("grep relevance ranking", () => {
  test("densest file first, per-file cap, hidden-matches summary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sophie-grep-"));
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(join(dir, "sparse.ts"), "const needle = 1;\n");
    writeFileSync(join(dir, "sub/dense.ts"), Array.from({ length: 30 }, (_, i) => `needle line ${i}`).join("\n"));
    const result = await grep.execute({ pattern: "needle", path: dir }, { cwd: dir });
    const lines = result.content.split("\n");
    // The 30-match file outranks the 1-match file despite glob order.
    expect(lines[0]).toContain("dense.ts");
    expect(result.content).toContain("sparse.ts");
    // Per-file cap: 30 matches, at most 15 shown, with an elision note.
    expect(lines.filter((l) => l.includes("dense.ts:")).length).toBeLessThanOrEqual(15);
    expect(result.content).toContain("more in");
    expect(result.display).toContain("31 matches in 2 files");
  });

  test("no matches stays a clean miss", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sophie-grep-"));
    writeFileSync(join(dir, "a.txt"), "nothing here");
    const result = await grep.execute({ pattern: "zzz_absent", path: dir }, { cwd: dir });
    expect(result.content).toContain("No matches");
  });
});

describe("web_fetch readability extraction", () => {
  const page = `<!doctype html><html><head><title>Bun 1.3 &amp; friends</title><style>.x{}</style>
    <script>var junk = 1;</script></head><body>
    <nav>Home | Docs | Pricing | Login | Blog</nav>
    <header>SiteName mega menu</header>
    <main><h1>Release notes</h1><p>Bun 1.3 ships speculative decoding support.</p>
    <ul><li>Faster startup</li><li>Lower memory</li></ul>
    ${"<p>padding content to make the main container clearly real. </p>".repeat(10)}</main>
    <aside>Related links</aside>
    <footer>© 2026 SiteName. Cookie settings. Terms.</footer></body></html>`;

  test("keeps the article, drops nav/header/footer/scripts", () => {
    const text = stripHtml(page);
    expect(text).toContain("Bun 1.3 ships speculative decoding support.");
    expect(text).toContain("- Faster startup");
    expect(text).not.toContain("Cookie settings");
    expect(text).not.toContain("mega menu");
    expect(text).not.toContain("Home | Docs");
    expect(text).not.toContain("var junk");
  });

  test("extracts and decodes the title", () => {
    expect(pageTitle(page)).toBe("Bun 1.3 & friends");
  });

  test("falls back to whole-body cleanup when there is no main container", () => {
    const bare = "<html><body><p>Just a paragraph.</p><footer>legal</footer></body></html>";
    const text = stripHtml(bare);
    expect(text).toContain("Just a paragraph.");
    expect(text).not.toContain("legal");
  });
});

describe("clipForHistory favor modes", () => {
  const content = `HEAD-MARKER ${"x".repeat(10_000)} TAIL-MARKER`;

  test("head mode keeps the head (default, unchanged behavior)", () => {
    const clipped = clipForHistory(content, 1000);
    expect(clipped).toContain("HEAD-MARKER");
    expect(clipped).toContain("truncated");
    expect(clipped.length).toBeLessThan(1400);
  });

  test("tail mode keeps the tail for command output", () => {
    const clipped = clipForHistory(content, 1000, "tail");
    expect(clipped).toContain("TAIL-MARKER");
    expect(clipped).toContain("HEAD-MARKER".slice(0, 5)); // small head kept too
    expect(clipped).toContain("truncated");
  });

  test("short content is untouched in both modes", () => {
    expect(clipForHistory("short", 1000, "tail")).toBe("short");
  });
});
