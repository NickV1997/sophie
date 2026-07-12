import { describe, expect, test } from "bun:test";
import { DAEMON_LABEL } from "../src/daemon/launchd.ts";

describe("background service contract", () => {
  test("uses one stable launchd identity", () => {
    expect(DAEMON_LABEL).toBe("com.sophie.agent");
  });

  test("CLI exposes daemon lifecycle commands", async () => {
    const source = await Bun.file(new URL("../bin/sophie.ts", import.meta.url)).text();
    expect(source).toContain("daemon install|start|stop|status");
    expect(source).toContain('action === "run"');
    expect(source).toContain("launchctl");
  });
});
