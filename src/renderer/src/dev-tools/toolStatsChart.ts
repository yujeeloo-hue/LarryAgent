
export type ToolStatsDayRow = {
  day: string;
  revision?: number;
  calls: number;
  success: number;
  failure: number;
};

export type ToolStatsChartPoint = {
  day: string;
  label: string;
  calls: number;
  success: number;
  failure: number;
  rate: number | null;
};

export type ToolStatsChartTotals = {
  calls: number;
  success: number;
  failure: number;
  rate: number | null;
};

export type ToolStatsChartSeries = {
  revision: number;
  label: string;
  points: ToolStatsChartPoint[];
  totals: ToolStatsChartTotals;
};

export type ToolStatsChartModel = {
  days: string[];
  labels: string[];
  series: ToolStatsChartSeries[];
  totals: ToolStatsChartTotals;
};

type Counts = { calls: number; success: number; failure: number };

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_SPAN_DAYS = 731;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function parseDay(day: string): Date | null {
  const match = DAY_PATTERN.exec(day.trim());
  if (!match) return null;
  const [year, month, date] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const parsed = new Date(year, month - 1, date);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.getFullYear() !== year ||
    parsed.getMonth() + 1 !== month ||
    parsed.getDate() !== date
  ) {
    return null;
  }
  return parsed;
}

export function dayKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function dayLabel(day: string): string {
  const parsed = parseDay(day);
  if (!parsed) return day;
  return `${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`;
}

export function revisionLabel(revision: number): string {
  return `r${Number.isFinite(revision) ? Math.max(0, Math.trunc(revision)) : 0}`;
}

function revisionOf(row: ToolStatsDayRow): number {
  const value = Number(row.revision);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function normalizeRows(
  rows: ToolStatsDayRow[],
): Array<{ day: string; revision: number } & Counts> {
  const out: Array<{ day: string; revision: number } & Counts> = [];
  for (const row of rows) {
    if (!parseDay(row.day)) continue;
    const calls = Number(row.calls);
    if (!Number.isFinite(calls) || calls <= 0) continue;
    out.push({
      day: row.day.trim(),
      revision: revisionOf(row),
      calls,
      success: Number.isFinite(Number(row.success)) ? Number(row.success) : 0,
      failure: Number.isFinite(Number(row.failure)) ? Number(row.failure) : 0,
    });
  }
  return out;
}

function buildDayAxis(days: string[]): string[] {
  if (days.length === 0) return [];
  const sorted = [...days].sort();
  const first = parseDay(sorted[0]!)!;
  const last = parseDay(sorted[sorted.length - 1]!)!;
  const spanDays =
    Math.round((last.getTime() - first.getTime()) / 86_400_000) + 1;
  const start = spanDays > MAX_SPAN_DAYS
    ? new Date(
        last.getFullYear(),
        last.getMonth(),
        last.getDate() - (MAX_SPAN_DAYS - 1),
      )
    : first;
  const axis: string[] = [];
  const cursor = new Date(start.getTime());
  while (cursor.getTime() <= last.getTime()) {
    axis.push(dayKey(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return axis;
}

function addCounts(target: Counts, source: Counts): void {
  target.calls += source.calls;
  target.success += source.success;
  target.failure += source.failure;
}

function pointsFor(
  axis: string[],
  buckets: Map<string, Counts>,
): ToolStatsChartPoint[] {
  return axis.map((day) => {
    const bucket = buckets.get(day);
    const calls = bucket?.calls ?? 0;
    return {
      day,
      label: dayLabel(day),
      calls,
      success: bucket?.success ?? 0,
      failure: bucket?.failure ?? 0,
      rate: calls > 0 ? bucket!.success / calls : null,
    };
  });
}

function totalsOf(buckets: Map<string, Counts>): ToolStatsChartTotals {
  const totals: Counts = { calls: 0, success: 0, failure: 0 };
  for (const bucket of buckets.values()) addCounts(totals, bucket);
  return {
    ...totals,
    rate: totals.calls > 0 ? totals.success / totals.calls : null,
  };
}

export function buildChartModel(rows: ToolStatsDayRow[]): ToolStatsChartModel {
  const normalized = normalizeRows(rows);
  if (normalized.length === 0) {
    return {
      days: [],
      labels: [],
      series: [],
      totals: { calls: 0, success: 0, failure: 0, rate: null },
    };
  }
  const axis = buildDayAxis(normalized.map((row) => row.day));
  const byRevision = new Map<number, Map<string, Counts>>();
  const everything = new Map<string, Counts>();
  for (const row of normalized) {
    let buckets = byRevision.get(row.revision);
    if (!buckets) {
      buckets = new Map<string, Counts>();
      byRevision.set(row.revision, buckets);
    }
    for (const target of [buckets, everything]) {
      const current = target.get(row.day);
      if (current) addCounts(current, row);
      else target.set(row.day, { calls: row.calls, success: row.success, failure: row.failure });
    }
  }
  const series = [...byRevision.keys()]
    .sort((a, b) => a - b)
    .map((revision) => {
      const buckets = byRevision.get(revision)!;
      return {
        revision,
        label: revisionLabel(revision),
        points: pointsFor(axis, buckets),
        totals: totalsOf(buckets),
      };
    });
  return {
    days: axis,
    labels: axis.map(dayLabel),
    series,
    totals: totalsOf(everything),
  };
}

export function buildDaySeries(rows: ToolStatsDayRow[]): ToolStatsChartPoint[] {
  const buckets = new Map<string, Counts>();
  const days: string[] = [];
  for (const row of normalizeRows(rows)) {
    days.push(row.day);
    const current = buckets.get(row.day);
    if (current) addCounts(current, row);
    else buckets.set(row.day, { calls: row.calls, success: row.success, failure: row.failure });
  }
  if (buckets.size === 0) return [];
  return pointsFor(buildDayAxis(days), buckets);
}

export function chartTotals(points: ToolStatsChartPoint[]): ToolStatsChartTotals {
  let calls = 0;
  let success = 0;
  let failure = 0;
  for (const point of points) {
    calls += point.calls;
    success += point.success;
    failure += point.failure;
  }
  return {
    calls,
    success,
    failure,
    rate: calls > 0 ? success / calls : null,
  };
}
