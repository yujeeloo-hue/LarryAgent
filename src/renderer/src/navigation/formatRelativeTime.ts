/** Format a timestamp as relative English time for SESSIONS rows (UI helper only). */
export function formatRelativeTime(fromMs: number, nowMs = Date.now()): string {
  const deltaSec = Math.round((nowMs - fromMs) / 1000);
  if (deltaSec < 60) return "just now";
  const deltaMin = Math.round(deltaSec / 60);
  if (deltaMin < 60) return `${deltaMin}m ago`;
  const deltaHr = Math.round(deltaMin / 60);
  if (deltaHr < 24) return `${deltaHr}h ago`;
  const deltaDay = Math.round(deltaHr / 24);
  if (deltaDay === 1) return "yesterday";
  if (deltaDay < 30) return `${deltaDay}d ago`;
  const deltaMonth = Math.round(deltaDay / 30);
  if (deltaMonth < 12) return `${deltaMonth}mo ago`;
  const deltaYear = Math.round(deltaMonth / 12);
  return `${deltaYear}y ago`;
}
