import { setMode } from "../agent/mode.ts";
import type { Tool } from "./types.ts";

/**
 * Lets Sophie switch her own mode. Plan reasons at medium effort (read-only) to
 * find an efficient approach and break it into tasks; build executes
 * coding work at low reasoning effort with verifier discipline; normal executes
 * non-coding tasks quickly.
 */
export const setModeTool: Tool = {
  name: "set_mode",
  description:
    "Switch your operating mode. 'build' = low-reasoning coding execution with verifier discipline; the runtime seeds/maintains the task list and exits build when the objective is verified. " +
    "'plan' = standalone medium-reasoning planning that STOPS for the user's review (use only when they want a plan, not a build). " +
    "'normal' = execute non-coding tasks quickly. " +
    "Use build for anything that means coding an app/feature; use plan only when asked to just plan.",
  parameters: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["plan", "normal", "build"],
        description: "The mode to switch to.",
      },
    },
    required: ["mode"],
  },
  summarize: (a) => `${a.mode} mode`,
  risk: () => "safe",
  async execute(args) {
    const mode = args.mode === "plan" ? "plan" : args.mode === "normal" ? "normal" : args.mode === "build" ? "build" : null;
    if (!mode) {
      return { content: `Invalid mode "${args.mode}". Use "plan", "normal", or "build".`, isError: true };
    }
    setMode(mode);
    const msg =
      mode === "plan"
        ? "Now in PLAN mode: medium reasoning, read-only. Lay out the plan with update_tasks, then present it and STOP for the user's review (they asked to plan, not build)."
        : mode === "build"
          ? "Now in BUILD mode: low reasoning, execute the task list one step at a time and verify before completion."
        : "Now in NORMAL mode: execute non-coding tasks one item at a time, marking each completed as you finish.";
    return { content: msg, display: `${mode} mode` };
  },
};
