/**
 * Minimal fake MCP server for tests. Speaks newline-delimited JSON-RPC 2.0 on
 * stdin/stdout: initialize → tools/list → tools/call. No network, no deps.
 *
 * Exposes two tools so tests can exercise the readOnlyHint → risk mapping and
 * the tool budget:
 *   - echo  (readOnlyHint: true)  → returns the args back as text
 *   - shout (no hint)             → uppercases args.text
 */

function send(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function reply(id: number | string, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

const TOOLS = [
  {
    name: "echo",
    description: "Echo the arguments back.",
    inputSchema: { type: "object", properties: { value: { type: "string" } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "shout",
    description: "Uppercase the given text.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
];

function handle(msg: any): void {
  switch (msg.method) {
    case "initialize":
      reply(msg.id, {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "fake", version: "0.0.0" },
      });
      return;
    case "notifications/initialized":
      return; // notification, no reply
    case "tools/list":
      reply(msg.id, { tools: TOOLS });
      return;
    case "tools/call": {
      const { name, arguments: args } = msg.params ?? {};
      if (name === "echo") {
        reply(msg.id, { content: [{ type: "text", text: JSON.stringify(args ?? {}) }] });
      } else if (name === "shout") {
        reply(msg.id, { content: [{ type: "text", text: String(args?.text ?? "").toUpperCase() }] });
      } else {
        reply(msg.id, { content: [{ type: "text", text: `unknown tool ${name}` }], isError: true });
      }
      return;
    }
    default:
      if (msg.id !== undefined) {
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } });
      }
  }
}

let buf = "";
process.stdin.on("data", (chunk: Buffer) => {
  buf += chunk.toString("utf8");
  let nl: number;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch {
      /* ignore malformed line */
    }
  }
});
process.stdin.resume();
