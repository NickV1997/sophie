export function formatWorkingElapsed(totalSeconds: number): string | null {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds === 0) return null;
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m`;
}
