
export type MessageLikeForDuration = {
  createdAt?: number;
};

export function estimateTurnDurationMs(
  turn: MessageLikeForDuration[],
): number | null {
  let start: number | null = null;
  let end: number | null = null;
  for (const message of turn) {
    const at = message.createdAt;
    if (typeof at !== "number" || !Number.isFinite(at) || at <= 0) continue;
    if (start === null || at < start) start = at;
    if (end === null || at > end) end = at;
  }
  if (start === null || end === null) return null;
  return Math.max(0, end - start);
}

export function formatTurnDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  }
  return `${seconds}s`;
}

export function formatToolRecordDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  return formatTurnDuration(ms);
}
