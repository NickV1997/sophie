import { platform } from "node:os";

const MAC_ONLY = new Set(["apple", "capture_screen"]);
export function toolSupportedOnPlatform(name: string, os = platform()): boolean {
  return os === "darwin" || !MAC_ONLY.has(name);
}
export function platformCapabilitySummary(os = platform()): string {
  return os === "darwin"
    ? "macOS native: Apple Calendar, Messages, Notes, Reminders, Contacts, screen capture, notifications"
    : "portable fallback: built-in calendar/tasks/memory/files/web; Apple-only tools hidden";
}
