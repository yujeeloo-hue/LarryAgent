
export const MAX_IN_FLIGHT_MS = 600_000;

export type TimelineTrackId = "user" | "llm" | "tools" | "aux";

export const TIMELINE_TRACKS: ReadonlyArray<{
  id: TimelineTrackId;
  label: string;
}> = [
  { id: "user", label: "User" },
  { id: "llm", label: "LLM" },
  { id: "tools", label: "Tools" },
  { id: "aux", label: "Aux" },
];

export type TimelineRecordLike = {
  id: string;
  startedAt: number;
  endedAt: number | null;
};

export type TrackableTimelineRecord = TimelineRecordLike & {
  kind: "llm" | "tool" | "user";
  purpose?: string;
  error?: string;
  doneReason?: string;
  returnCode?: number;
  status?: string;
};

export function isTimelineRecordError(
  record: TrackableTimelineRecord,
): boolean {
  if (record.error) return true;
  if (record.kind === "llm" && record.doneReason === "error") return true;
  if (record.kind === "tool") {
    if (record.status === "error") return true;
    if (
      typeof record.returnCode === "number" &&
      record.returnCode !== 0 &&
      record.returnCode !== 6
    ) {
      return true;
    }
  }
  return false;
}

export function trackOf(record: TrackableTimelineRecord): TimelineTrackId {
  if (record.kind === "user") return "user";
  if (record.kind === "tool") return "tools";
  return record.purpose === "chat" || !record.purpose ? "llm" : "aux";
}

export type TimelineBar<T extends TimelineRecordLike> = {
  record: T;
  start: number;
  end: number;
  lane: number;
};

export function assignLanes<T extends TimelineRecordLike>(
  records: readonly T[],
  now: number,
  maxInFlightMs: number = MAX_IN_FLIGHT_MS,
): { bars: TimelineBar<T>[]; laneCount: number } {
  const sorted = [...records].sort((a, b) => a.startedAt - b.startedAt);
  const laneEnds: number[] = [];
  const bars: TimelineBar<T>[] = [];
  for (const record of sorted) {
    const start = record.startedAt;
    const rawEnd = record.endedAt ?? Math.min(now, start + maxInFlightMs);
    const end = Math.max(rawEnd, start);
    let lane = laneEnds.findIndex((lastEnd) => lastEnd <= start);
    if (lane === -1) {
      laneEnds.push(end);
      lane = laneEnds.length - 1;
    } else {
      laneEnds[lane] = end;
    }
    bars.push({ record, start, end, lane });
  }
  return { bars, laneCount: laneEnds.length };
}

export const RULER_STEPS_MS: readonly number[] = [
  100, 250, 500, 1_000, 2_000, 5_000, 10_000, 15_000, 30_000, 60_000,
  120_000, 300_000, 600_000, 1_800_000, 3_600_000, 7_200_000, 14_400_000,
  28_800_000, 86_400_000,
];

export function chooseRulerStep(
  spanMs: number,
  widthPx: number,
  minTickPx = 64,
): number {
  const last = RULER_STEPS_MS[RULER_STEPS_MS.length - 1] ?? 86_400_000;
  if (spanMs <= 0 || widthPx <= 0) return last;
  for (const step of RULER_STEPS_MS) {
    if ((step / spanMs) * widthPx >= minTickPx) return step;
  }
  return last;
}

export function firstTickAtOrAfter(from: number, step: number): number {
  return Math.ceil(from / step) * step;
}

export function computeTimeSpan<T extends TimelineRecordLike>(
  records: readonly T[],
  now: number,
  minSpanMs = 1_000,
  maxInFlightMs: number = MAX_IN_FLIGHT_MS,
): { start: number; end: number } | null {
  if (records.length === 0) return null;
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const record of records) {
    start = Math.min(start, record.startedAt);
    const rawEnd =
      record.endedAt ?? Math.min(now, record.startedAt + maxInFlightMs);
    end = Math.max(end, rawEnd, record.startedAt);
  }
  if (end - start < minSpanMs) end = start + minSpanMs;
  return { start, end };
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  const clamped = Math.max(0, ms);
  if (clamped < 1_000) return `${Math.round(clamped)}ms`;
  if (clamped < 60_000) return `${(clamped / 1_000).toFixed(1)}s`;
  const totalSeconds = Math.floor(clamped / 1_000);
  const h = Math.floor(totalSeconds / 3_600);
  const m = Math.floor((totalSeconds % 3_600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
  return `${m}m${String(s).padStart(2, "0")}s`;
}

export function formatClock(ts: number): string {
  const d = new Date(ts);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
}

export function formatRulerLabel(
  ts: number,
  stepMs: number,
  zero: number,
): string {
  const elapsed = ts - zero;
  const sign = elapsed < 0 ? "-" : "";
  const abs = Math.abs(elapsed);
  if (stepMs < 1_000) {
    return `${sign}${(abs / 1_000).toFixed(1)}s`;
  }
  const totalSec = Math.round(abs / 1_000);
  const mm = Math.floor(totalSec / 60);
  const ss = String(totalSec % 60).padStart(2, "0");
  return `${sign}${mm}:${ss}`;
}
