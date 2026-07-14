import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { REPO_ROOT } from "../src/config.ts";

function productionSources(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const rel = relative(join(REPO_ROOT, "src"), path);
    if (rel === "bench" || rel.startsWith(`bench${process.platform === "win32" ? "\\" : "/"}`)) continue;
    if (statSync(path).isDirectory()) files.push(...productionSources(path));
    else if (/\.(?:ts|tsx)$/.test(name)) files.push(path);
  }
  return files;
}

describe("benchmark integrity boundary", () => {
  test("production runtime never imports benchmark scenarios or evaluation code", () => {
    for (const path of productionSources(join(REPO_ROOT, "src"))) {
      const source = readFileSync(path, "utf8");
      expect(source, relative(REPO_ROOT, path)).not.toMatch(/(?:from|import\s*)\s*[('"].*\/bench\//);
    }
  });

  test("production runtime does not recognize the benchmark wrapper", () => {
    for (const path of productionSources(join(REPO_ROOT, "src"))) {
      const source = readFileSync(path, "utf8");
      expect(source, relative(REPO_ROOT, path)).not.toContain("PERSONAL ASSISTANT BENCHMARK");
    }
  });
});
