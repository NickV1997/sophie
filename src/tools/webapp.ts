import { stopWebAppServer } from "../webapp/server.ts";
import type { Tool } from "./types.ts";

export const stopWebApp: Tool = {
  name: "stop_webapp",
  description:
    "Stop Sophie's local web app started by /webapp or `sophie webapp`. Use this when the user asks to kill, stop, close, or shut down the web app.",
  parameters: {
    type: "object",
    properties: {},
  },
  summarize: () => "stop Sophie web app",
  risk: () => "safe",
  async execute() {
    const result = await stopWebAppServer();
    return {
      content: result.detail,
      display: result.stopped ? "web app stopped" : "web app not running",
    };
  },
};
