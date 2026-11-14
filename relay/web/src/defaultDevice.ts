/**
 * First-load device auto-pick for the home session list.
 *
 * Land on the device that currently has a session running — that's almost
 * always why the console was opened — then fall back to the first online
 * device, else nothing. Shared by desktop and mobile home; extracted from
 * main.ts so the rule is unit-testable without booting the whole console.
 */
import type { DeviceSummary, SessionSummary } from "./types.js";

export function pickDefaultDevice(list: DeviceSummary[]): DeviceSummary | null {
  return (
    list.find((d) => d.online && (d.runningSessions ?? 0) > 0) ??
    list.find((d) => d.online) ??
    null
  );
}

/** Most recent `updatedAt` among a device's running sessions; 0 when none. */
function latestRunningAt(list: SessionSummary[]): number {
  let at = 0;
  for (const s of list) {
    if (s.archived) continue;
    if (s.status === "running" && s.updatedAt > at) at = s.updatedAt;
  }
  return at;
}

/**
 * Refinement for the first-load auto-pick: several devices can be busy at
 * once, and plain list order then lands on an arbitrary one. Given each
 * busy device's session list (in device list order), pick the device whose
 * running session is most recently active. Ties keep the earlier device;
 * null when no candidate actually has a running session.
 */
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

/** Most recent `updatedAt` across a device's non-archived sessions; 0 when none. */
function latestActivityAt(list: SessionSummary[]): number {
  let at = 0;
  for (const s of list) {
    if (s.archived) continue;
    if (s.updatedAt > at) at = s.updatedAt;
  }
  return at;
}

/**
 * Idle fallback for the first-load auto-pick: nobody has a session in
 * flight, so list order is meaningless (registration order). Land on the
 * device that most recently had session activity of any kind — that's
 * almost always where the user last was. Ties keep the earlier device;
 * null when no candidate has any non-archived session (caller keeps its
 * sync pick — usually the first online device).
 */
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
