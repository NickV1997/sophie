import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { expandHome, resolvePath } from "../src/system/paths.ts";

describe("home-relative path expansion", () => {
  test("expands a bare ~ and ~/ paths to the home directory", () => {
    expect(expandHome("~")).toBe(homedir());
    expect(expandHome("~/Desktop/test")).toBe(join(homedir(), "Desktop/test"));
  });

  test("leaves non-tilde paths untouched", () => {
    expect(expandHome("src/index.tsx")).toBe("src/index.tsx");
    expect(expandHome("/abs/path")).toBe("/abs/path");
    expect(expandHome("./rel")).toBe("./rel");
    expect(expandHome("file~name")).toBe("file~name"); // ~ not at the start
  });

  test("resolvePath: ~ no longer resolves to a literal ~ folder under cwd", () => {
    // This was the bug: resolve(cwd, '~/Desktop/test') => <cwd>/~/Desktop/test
    expect(resolvePath("/tmp/demo", "~/Desktop/test")).toBe(join(homedir(), "Desktop/test"));
  });

  test("resolvePath: relative paths resolve against cwd, absolute pass through", () => {
    expect(resolvePath("/tmp/demo/sophie", "src/index.tsx")).toBe("/tmp/demo/sophie/src/index.tsx");
    expect(resolvePath("/cwd", "/abs/elsewhere")).toBe("/abs/elsewhere");
  });
});
