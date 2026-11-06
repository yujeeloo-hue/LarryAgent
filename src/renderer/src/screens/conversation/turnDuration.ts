/** Estimate / format per-turn wall time from message `createdAt` values. */

export type MessageLikeForDuration = {
  createdAt?: number;
};

/**
 * Duration from the first timestamped message in the turn (user Send) to the
 * last timestamped message (assistant / tool / error system).
 */
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

/** English compact duration: `45s`, `1m 05s`, `1h 02m`. */
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

/**
 * Per-tool-call duration for the Thinking tool record: sub-10s calls keep
 * one decimal (tool calls are often fast), then the turn format takes over.
 * `0.4s`, `8.4s`, `12s`, `1m 05s`.
 */
export function formatToolRecordDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  return formatTurnDuration(ms);
}
