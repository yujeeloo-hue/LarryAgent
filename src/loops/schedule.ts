/**
 * Loops scheduling engine (pure functions) — docs/plans/20260823-loops-daemon-and-scheduled-sessions.md §3.
 *
 * Fixed enum cadence → next trigger time. Local-timezone semantics: Dates are
 * constructed in local time directly, with no UTC conversion (CN has no
 * daylight saving, so DST is a non-issue). All returned times have 0
 * milliseconds and are strictly later than `from` (millisecond-inclusive
 * comparison; a candidate exactly equal to `from` advances to the next
 * natural period).
 */

export type Cadence =
  /** Every n minutes (n ≥ 1), anchored to the last trigger time (or now). */
  | { kind: "minute"; n: number }
  /** Hourly at the given minute (0-59). */
  | { kind: "hour"; minute: number }
  /** Every day at the given time (`HH:MM`). */
  | { kind: "day"; time: string }
  /** Weekly on the given weekdays (0=Sun … 6=Sat, matching Date.getDay()); weekdays is non-empty, ascending, deduped. */
  | { kind: "week"; weekdays: number[]; time: string }
  /** Monthly on the given day (1-31); clamps to the month's last day when it is shorter (cron semantics). */
  | { kind: "month"; day: number; time: string }
  /**
   * Yearly on month/day (month 1-12; day follows the monthly clamp rule).
   * Sole exception: Feb 29 in a non-leap year rolls to Mar 1 at the same
   * time (birthday semantics) instead of clamping to 2/28.
   */
  | { kind: "year"; month: number; day: number; time: string };

const TIME_OF_DAY_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Parse `HH:MM` (strict two-digit 24-hour); returns null for invalid input. */
export function parseTimeOfDay(time: string): { hour: number; minute: number } | null {
  const match = TIME_OF_DAY_RE.exec(time);
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

function requireTimeOfDay(time: string): { hour: number; minute: number } {
  const parsed = parseTimeOfDay(time);
  if (!parsed) throw new Error(`Invalid time of day: ${JSON.stringify(time)}`);
  return parsed;
}

function isIntInRange(value: unknown, min: number, max: number): boolean {
  return (
    typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
  );
}

function isValidTimeOfDay(value: unknown): boolean {
  return typeof value === "string" && parseTimeOfDay(value) !== null;
}

/** weekdays must be a non-empty integer array, 0-6, strictly ascending (i.e. deduped and sorted). */
function isValidWeekdays(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  let previous = -1;
  for (const weekday of value) {
    if (!isIntInRange(weekday, 0, 6)) return false;
    const day = weekday as number;
    if (day <= previous) return false;
    previous = day;
  }
  return true;
}

/** Field-level cadence validation (loops.db JSON passes through here after deserialization, before storage/use). */
export function isValidCadence(value: unknown): value is Cadence {
  if (typeof value !== "object" || value === null) return false;
  const cadence = value as Record<string, unknown>;
  switch (cadence.kind) {
    case "minute":
      return isIntInRange(cadence.n, 1, Number.MAX_SAFE_INTEGER);
    case "hour":
      return isIntInRange(cadence.minute, 0, 59);
    case "day":
      return isValidTimeOfDay(cadence.time);
    case "week":
      return isValidWeekdays(cadence.weekdays) && isValidTimeOfDay(cadence.time);
    case "month":
      return isIntInRange(cadence.day, 1, 31) && isValidTimeOfDay(cadence.time);
    case "year":
      return (
        isIntInRange(cadence.month, 1, 12) &&
        isIntInRange(cadence.day, 1, 31) &&
        isValidTimeOfDay(cadence.time)
      );
    default:
      return false;
  }
}

/**
 * Validate and canonicalize model-submitted cadence: week weekdays are
 * accepted in any order and deduplicated (stored sorted ascending); all
 * other kinds are returned as canonical copies. Returns null when the shape
 * is invalid. Storage-side `isValidCadence` stays strict (sorted, deduped).
 */
export function normalizeCadence(value: unknown): Cadence | null {
  if (typeof value !== "object" || value === null) return null;
  const cadence = value as Record<string, unknown>;
  switch (cadence.kind) {
    case "minute":
      return isIntInRange(cadence.n, 1, Number.MAX_SAFE_INTEGER)
        ? { kind: "minute", n: cadence.n as number }
        : null;
    case "hour":
      return isIntInRange(cadence.minute, 0, 59) ? { kind: "hour", minute: cadence.minute as number } : null;
    case "day":
      return isValidTimeOfDay(cadence.time) ? { kind: "day", time: cadence.time as string } : null;
    case "week": {
      if (!Array.isArray(cadence.weekdays) || cadence.weekdays.length === 0) return null;
      const weekdays = new Set<number>();
      for (const weekday of cadence.weekdays) {
        if (!isIntInRange(weekday, 0, 6)) return null;
        weekdays.add(weekday);
      }
      return isValidTimeOfDay(cadence.time)
        ? { kind: "week", weekdays: [...weekdays].sort((a, b) => a - b), time: cadence.time as string }
        : null;
    }
    case "month":
      return isIntInRange(cadence.day, 1, 31) && isValidTimeOfDay(cadence.time)
        ? { kind: "month", day: cadence.day as number, time: cadence.time as string }
        : null;
    case "year":
      return (
        isIntInRange(cadence.month, 1, 12) &&
        isIntInRange(cadence.day, 1, 31) &&
        isValidTimeOfDay(cadence.time)
      )
        ? { kind: "year", month: cadence.month as number, day: cadence.day as number, time: cadence.time as string }
        : null;
    default:
      return null;
  }
}

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(year, monthIndex + 1, 0).getDate();
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * Next trigger time: strictly later than `from`, milliseconds 0, local timezone.
 * Pure function; does not mutate its inputs.
 */
export function nextRunAt(cadence: Cadence, from: Date): Date {
  switch (cadence.kind) {
    case "minute":
      return nextMinuteRun(cadence.n, from);
    case "hour":
      return nextHourlyRun(cadence.minute, from);
    case "day":
      return nextDailyRun(cadence.time, from);
    case "week":
      return nextWeeklyRun(cadence.weekdays, cadence.time, from);
    case "month":
      return nextMonthlyRun(cadence.day, cadence.time, from);
    case "year":
      return nextYearlyRun(cadence.month, cadence.day, cadence.time, from);
  }
}

/** From (truncated to seconds) + n minutes; the first step is already strictly in the future, no search needed. */
function nextMinuteRun(n: number, from: Date): Date {
  const fromSeconds = Math.floor(from.getTime() / 1000);
  return new Date((fromSeconds + n * 60) * 1000);
}

function nextHourlyRun(minute: number, from: Date): Date {
  const fromMs = from.getTime();
  const year = from.getFullYear();
  const monthIndex = from.getMonth();
  const date = from.getDate();
  const hour = from.getHours();
  let candidate = new Date(year, monthIndex, date, hour, minute);
  if (candidate.getTime() <= fromMs) {
    // Date construction handles the day rollover automatically (24:00 → next day 00:00).
    candidate = new Date(year, monthIndex, date, hour + 1, minute);
  }
  return candidate;
}

function nextDailyRun(time: string, from: Date): Date {
  const { hour, minute } = requireTimeOfDay(time);
  const fromMs = from.getTime();
  const year = from.getFullYear();
  const monthIndex = from.getMonth();
  const date = from.getDate();
  let candidate = new Date(year, monthIndex, date, hour, minute);
  if (candidate.getTime() <= fromMs) {
    candidate = new Date(year, monthIndex, date + 1, hour, minute);
  }
  return candidate;
}

function nextWeeklyRun(weekdays: number[], time: string, from: Date): Date {
  if (weekdays.length === 0) throw new Error("weekdays must be non-empty");
  const { hour, minute } = requireTimeOfDay(time);
  const fromMs = from.getTime();
  const year = from.getFullYear();
  const monthIndex = from.getMonth();
  const date = from.getDate();
  const fromDay = from.getDay();
  let best: Date | null = null;
  for (const weekday of weekdays) {
    const delta = (weekday - fromDay + 7) % 7;
    let candidate = new Date(year, monthIndex, date + delta, hour, minute);
    if (candidate.getTime() <= fromMs) {
      // This weekday's slot already passed this week → same day next week (cross-week).
      candidate = new Date(year, monthIndex, date + delta + 7, hour, minute);
    }
    if (best === null || candidate.getTime() < best.getTime()) {
      best = candidate;
    }
  }
  if (best === null) throw new Error("unreachable: weekdays checked non-empty above");
  return best;
}

function nextMonthlyRun(day: number, time: string, from: Date): Date {
  const { hour, minute } = requireTimeOfDay(time);
  const fromMs = from.getTime();
  let year = from.getFullYear();
  let monthIndex = from.getMonth();
  for (let step = 0; step < 3; step += 1) {
    // Clamp to the month's last day when it is shorter (cron semantics).
    const clampedDay = Math.min(day, daysInMonth(year, monthIndex));
    const candidate = new Date(year, monthIndex, clampedDay, hour, minute);
    if (candidate.getTime() > fromMs) return candidate;
    monthIndex += 1;
    if (monthIndex > 11) {
      monthIndex = 0;
      year += 1;
    }
  }
  throw new Error("unreachable: monthly cadence resolves within one month advance");
}

function nextYearlyRun(month: number, day: number, time: string, from: Date): Date {
  const { hour, minute } = requireTimeOfDay(time);
  const fromMs = from.getTime();
  let year = from.getFullYear();
  for (let step = 0; step < 3; step += 1) {
    const candidate = yearlyCandidate(year, month, day, hour, minute);
    if (candidate.getTime() > fromMs) return candidate;
    year += 1;
  }
  throw new Error("unreachable: yearly cadence resolves within one year advance");
}

function yearlyCandidate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): Date {
  const monthIndex = month - 1;
  if (monthIndex === 1 && day === 29 && !isLeapYear(year)) {
    // Feb 29 in a non-leap year rolls to Mar 1 at the same time (birthday semantics), not clamped to 2/28.
    return new Date(year, 2, 1, hour, minute);
  }
  return new Date(year, monthIndex, Math.min(day, daysInMonth(year, monthIndex)), hour, minute);
}

const WEEKDAY_NAMES = [
  "Sun",
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
] as const;

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

function weekdayName(weekday: number): string {
  return WEEKDAY_NAMES[weekday] ?? String(weekday);
}

/** English summary shown on Loops UI cards. Assumes a valid cadence. */
export function describeCadence(cadence: Cadence): string {
  switch (cadence.kind) {
    case "minute":
      return cadence.n === 1 ? "Every minute" : `Every ${cadence.n} minutes`;
    case "hour":
      return `Hourly at :${String(cadence.minute).padStart(2, "0")}`;
    case "day":
      return `Daily at ${cadence.time}`;
    case "week":
      return `Weekly on ${cadence.weekdays.map(weekdayName).join(", ")} at ${cadence.time}`;
    case "month":
      return `Monthly on day ${cadence.day} at ${cadence.time}`;
    case "year":
      return `Yearly on ${MONTH_NAMES[cadence.month - 1] ?? cadence.month} ${cadence.day} at ${cadence.time}`;
  }
}
