import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grep } from "../src/tools/fs.ts";

describe("grep binary handling", () => {
  test("matches text files but skips binary files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sophie-grep-"));
    writeFileSync(join(dir, "text.txt"), "hello world\nfind me here\n");
    // A file with NUL bytes around the search term — utf8 read yields mojibake,
    // not an exception, so it must be filtered by the binary guard.
    writeFileSync(join(dir, "blob.bin"), Buffer.from([0x66, 0x69, 0x6e, 0x64, 0x00, 0x00, 0xff, 0x66, 0x69, 0x6e, 0x64]));

    const result = await grep.execute({ pattern: "find" }, { cwd: dir } as any);
    expect(result.content).toContain("text.txt");
    expect(result.content).not.toContain("blob.bin");
  });
});
