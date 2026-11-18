import type { DeviceSummary, SessionSummary } from "./types.js";

export function pickDefaultDevice(list: DeviceSummary[]): DeviceSummary | null {
  return (
    list.find((d) => d.online && (d.runningSessions ?? 0) > 0) ??
    list.find((d) => d.online) ??
    null
  );
}

function latestRunningAt(list: SessionSummary[]): number {
  let at = 0;
  for (const s of list) {
    if (s.archived) continue;
    if (s.status === "running" && s.updatedAt > at) at = s.updatedAt;
  }
  return at;
}

export function pickRecentRunningDevice(
  candidates: Array<{ deviceId: string; sessions: SessionSummary[] }>,
): string | null {
  let best: string | null = null;
  let bestAt = 0;
  for (const c of candidates) {
    const at = latestRunningAt(c.sessions);
    if (at > bestAt) {
      best = c.deviceId;
      bestAt = at;
    }
  }
  return best;
}

function latestActivityAt(list: SessionSummary[]): number {
  let at = 0;
  for (const s of list) {
    if (s.archived) continue;
    if (s.updatedAt > at) at = s.updatedAt;
  }
  return at;
}

export function pickRecentActivityDevice(
  candidates: Array<{ deviceId: string; sessions: SessionSummary[] }>,
): string | null {
  let best: string | null = null;
  let bestAt = 0;
  for (const c of candidates) {
    const at = latestActivityAt(c.sessions);
    if (at > bestAt) {
      best = c.deviceId;
      bestAt = at;
    }
  }
  return best;
}
