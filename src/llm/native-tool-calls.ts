/** Collect OpenAI-compatible streamed tool-call deltas and normalize them to
 * Sophie's canonical tagged JSON. Kept separate from the network client so
 * parser tests do not inherit suites that mock the client module. */
export class NativeToolCallAccumulator {
  private calls = new Map<number, { name: string; arguments: string | Record<string, unknown> }>();

  push(value: unknown): void {
    if (!Array.isArray(value)) return;
    for (let position = 0; position < value.length; position++) {
      const delta: any = value[position];
      if (!delta || typeof delta !== "object") continue;
      const index = Number.isInteger(delta.index) ? delta.index : position;
      const fn = delta.function && typeof delta.function === "object" ? delta.function : delta;
      const current = this.calls.get(index) ?? { name: "", arguments: "" };
      if (typeof fn.name === "string") current.name += fn.name;
      if (typeof fn.arguments === "string") {
        current.arguments = typeof current.arguments === "string" ? current.arguments + fn.arguments : fn.arguments;
      } else if (fn.arguments && typeof fn.arguments === "object") {
        current.arguments = fn.arguments;
      }
      this.calls.set(index, current);
    }
  }

  render(): string {
    return [...this.calls.entries()]
      .sort(([a], [b]) => a - b)
      .flatMap(([, call]) => {
        const name = call.name.trim();
        if (!name) return [];
        let args: Record<string, unknown> = {};
        if (typeof call.arguments === "string") {
          try {
            const parsed = JSON.parse(call.arguments || "{}");
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed;
          } catch {
            return [`<tool_call>${JSON.stringify({ name, arguments: call.arguments })}</tool_call>`];
          }
        } else {
          args = call.arguments;
        }
        return [`<tool_call>${JSON.stringify({ name, arguments: args })}</tool_call>`];
      })
      .join("\n");
  }
}
