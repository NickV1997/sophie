/**
 * Observable channel for MCP connection notices. The manager publishes one-line
 * status updates (connect/fail/budget) as servers come online in the background;
 * the TUI subscribes and renders them as system messages. Mirrors the mode/tasks
 * store pattern so status surfaces without the manager importing React.
 */
const listeners = new Set<(line: string) => void>();

export function publishMcpStatus(line: string): void {
  for (const l of listeners) l(line);
}

export function subscribeMcpStatus(fn: (line: string) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
