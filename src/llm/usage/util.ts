/** Shared lenient parsing / formatting helpers for usage adapters. */

/**
 * Lenient numeric read — these APIs drift between number and string
 * (Kimi limits[].detail is string in the wild). Returns null when unusable.
 */
export function lenientNumber(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim()) {
    const value = Number(raw.trim());
    return Number.isFinite(value) ? value : null;
  }
  return null;
}

export function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

/** Integer-ish counts without float noise (1234 → "1234", 12.34 → "12.3"). */
export function formatCount(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 10) / 10);
}

/** Money amounts: trim float noise to at most 2 decimals. */
export function formatMoney(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/** Compact reset timestamp, e.g. "Oct 13, 21:51". English-only UI. */
export function formatResetTime(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

/**
 * One-line reset stamp that fits the popup's fixed-height caption slot:
 * within today the clock is what you are waiting for ("21:05"); beyond today
 * the date is ("Nov 12") and the time is noise for a weekly / monthly window.
 * Every quota number stays in the line — only the timestamp is scoped.
 */
export function formatResetTimeSmart(date: Date, now: Date = new Date()): string {
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) {
    return new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  }
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(
    date,
  );
}

/**
 * ISO8601 with optional fractional seconds — Kimi reset_time can carry
 * microseconds ("2026-10-12T15:51:25.973986Z"); Date.parse only keeps ms.
 */
export function parseIsoDate(raw: unknown): Date | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const ms = Date.parse(raw.trim());
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/** Millisecond-epoch field (GLM nextResetTime). */
export function parseEpochMs(raw: unknown): Date | null {
  const ms = lenientNumber(raw);
  return ms !== null && ms > 0 ? new Date(ms) : null;
}
