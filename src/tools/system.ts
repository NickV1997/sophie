import { systemReport } from "../system/info.ts";
import type { Tool } from "./types.ts";

/**
 * Reports the machine Sophie is running on. The OS and architecture are also in
 * her always-on context, but this gives the full picture (CPU, RAM, runtime) and
 * is the canonical thing to call before downloading or installing software so the
 * right build is fetched for the platform.
 */
export const systemInfo: Tool = {
  name: "system_info",
  description:
    "Get this machine's specs: OS and version, architecture (e.g. arm64 vs " +
    "x64), CPU, RAM, shell, and runtime. Call this before downloading or " +
    "installing anything so you fetch the correct build for the OS/arch, or " +
    "whenever a task depends on the hardware or environment.",
  parameters: { type: "object", properties: {}, required: [] },
  summarize: () => "this machine",
  risk: () => "safe",
  async execute() {
    return { content: await systemReport(), display: "reported" };
  },
};
