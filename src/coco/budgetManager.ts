import type { CocoSettings, CocoUsage } from "./types.js";
import type { CocoRepository } from "./repository.js";

export type CocoBudgetState = { hourly: number; daily: number; estimated: boolean; resumeAt?: number; cooling: boolean; unit?: "hour" | "day" };
export type CocoBudgetEvents = {
  /** Window totals or the ceiling changed. */
  changed: CocoBudgetState;
  /** An hourly or daily ceiling was reached; automation must stop admitting work until `resumeAt`. */
  exhausted: CocoBudgetState;
  /** The window rolled over (or the ceiling was raised); automation may continue. */
  reset: CocoBudgetState;
};
type Listener<K extends keyof CocoBudgetEvents> = (state: CocoBudgetEvents[K]) => void;

const USAGE_LOOKBACK_MS = 172800000;
/** Upper bound between self-checks, so sleep / clock jumps cannot strand a cooldown. */
const MAX_TIMER_MS = 60000;

const windowFormatters = new Map<string, Intl.DateTimeFormat>();
export function windowKeys(at: number, timezone: string): { hour: string; day: string } {
  let formatter = windowFormatters.get(timezone);
  if (!formatter) { formatter = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23", timeZoneName: "shortOffset" }); windowFormatters.set(timezone, formatter); }
  const parts = formatter.formatToParts(at);
  const p = Object.fromEntries(parts.map(v => [v.type, v.value]));
  const day = `${p.year}-${p.month}-${p.day}`;
  return { day, hour: `${day}-${p.hour}-${p.timeZoneName}` };
}
type WindowBounds = { dayStart: number; dayEnd: number; hourStart: number; hourEnd: number };
const MINUTE_MS = 60000;
const boundsCache = new Map<string, WindowBounds>();

/**
 * Minute-aligned edges of the local window containing `minute`. Window keys
 * are contiguous in time (hour keys carry the UTC offset, so DST repeats stay
 * distinct), which makes both edges binary-searchable within `spanMinutes`.
 */
function windowEdges(minute: number, timezone: string, unit: "hour" | "day", spanMinutes: number): { start: number; end: number } {
  const key = windowKeys(minute, timezone)[unit];
  const same = (m: number): boolean => windowKeys(minute + m * MINUTE_MS, timezone)[unit] === key;
  let lo = -spanMinutes, hi = 0; // same(lo) false, same(hi) true
  while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (same(mid)) hi = mid; else lo = mid; }
  const start = minute + hi * MINUTE_MS;
  lo = 0; hi = spanMinutes; // same(lo) true, same(hi) false
  while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (same(mid)) lo = mid; else hi = mid; }
  return { start, end: minute + hi * MINUTE_MS };
}

/** Current hour/day window edges; cached until `now` leaves the cached hour. */
function windowBounds(now: number, timezone: string): WindowBounds {
  const cached = boundsCache.get(timezone);
  if (cached && now >= cached.hourStart && now < cached.hourEnd) return cached;
  const minute = Math.floor(now / MINUTE_MS) * MINUTE_MS;
  const day = windowEdges(minute, timezone, "day", 48 * 60), hour = windowEdges(minute, timezone, "hour", 3 * 60);
  const bounds = { dayStart: day.start, dayEnd: day.end, hourStart: hour.start, hourEnd: hour.end };
  boundsCache.set(timezone, bounds);
  return bounds;
}

/** Window totals across every metered purpose (interactive Chat included); reaching either ceiling yields `resumeAt`. */
export function budgetState(usage: CocoUsage[], settings: CocoSettings, now: number): { hourly: number; daily: number; estimated: boolean; resumeAt?: number } {
  const bounds = windowBounds(now, settings.timezone);
  let daily = 0, hourly = 0, estimated = false;
  for (const u of usage) {
    if (u.at < bounds.dayStart || u.at >= bounds.dayEnd) continue;
    daily += u.tokens;
    if (u.estimated) estimated = true;
    if (u.at >= bounds.hourStart && u.at < bounds.hourEnd) hourly += u.tokens;
  }
  let resumeAt: number | undefined;
  if (hourly >= settings.hourlyTokens || daily >= settings.dailyTokens) {
    resumeAt = daily >= settings.dailyTokens ? bounds.dayEnd : bounds.hourEnd;
  }
  return { hourly, daily, estimated, ...(resumeAt ? { resumeAt } : {}) };
}

/**
 * Single owner of the automation token budget. Records usage, re-evaluates on
 * its own clock and emits edge events. Consumers gate synchronously with
 * `state()` / `cooling()` and drive side effects from `exhausted` / `reset`.
 */
export class CocoBudgetManager {
  private listeners: { [K in keyof CocoBudgetEvents]: Set<Listener<K>> } = { changed: new Set(), exhausted: new Set(), reset: new Set() };
  private current: CocoBudgetState | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;

  constructor(private repository: CocoRepository, private settings: () => CocoSettings, private now: () => number = Date.now) {}

  on<K extends keyof CocoBudgetEvents>(event: K, listener: Listener<K>): () => void {
    this.listeners[event].add(listener);
    return () => { this.listeners[event].delete(listener); };
  }
  start(): void {
    if (this.running) return;
    this.running = true;
    this.refresh();
  }
  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
  /** Latest evaluated state; evaluates lazily before the first refresh. */
  state(): CocoBudgetState { return this.current ?? this.compute(); }
  cooling(): boolean { return this.state().cooling; }

  /** Upsert one usage sample (same id = same request, keeps the best token count) and re-evaluate. */
  record(input: Omit<CocoUsage, "at"> & { at?: number }): void {
    const previous = this.repository.get<CocoUsage>("usage", input.id);
    this.repository.put("usage", {
      ...input,
      at: previous?.at ?? input.at ?? this.now(),
      tokens: !input.estimated && previous?.estimated ? Math.ceil(input.tokens) : Math.max(previous?.tokens ?? 0, Math.ceil(input.tokens)),
      estimated: previous?.estimated === false ? false : input.estimated,
    });
    this.refresh();
  }

  /**
   * Zero the current hour and day totals — Chat usage included — so queued
   * work can continue. Emits `reset` when this lifts an active cooldown.
   */
  clearCurrentWindow(): CocoBudgetState {
    const now = this.now();
    const bounds = windowBounds(now, this.settings().timezone);
    for (const usage of this.repository.since<CocoUsage>("usage", now - USAGE_LOOKBACK_MS)) {
      if (usage.at < bounds.dayStart || usage.at >= bounds.dayEnd) continue;
      this.repository.remove("usage", usage.id);
    }
    return this.refresh();
  }

  /** Re-evaluate against the clock and settings; emits edges. Safe to call often. */
  refresh(): CocoBudgetState {
    const previous = this.current, next = this.compute();
    this.current = next;
    if (!previous || previous.hourly !== next.hourly || previous.daily !== next.daily || previous.resumeAt !== next.resumeAt) this.dispatch("changed", next);
    if (next.cooling && !previous?.cooling) this.dispatch("exhausted", next);
    else if (!next.cooling && previous?.cooling) this.dispatch("reset", next);
    this.schedule(next);
    return next;
  }

  private compute(): CocoBudgetState {
    const now = this.now(), settings = this.settings();
    const base = budgetState(this.repository.since("usage", now - USAGE_LOOKBACK_MS), settings, now);
    if (!base.resumeAt) return { ...base, cooling: false };
    return { ...base, cooling: true, unit: base.daily >= settings.dailyTokens ? "day" : "hour" };
  }
  private schedule(state: CocoBudgetState): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.running || !state.resumeAt) return;
    const delay = Math.min(MAX_TIMER_MS, Math.max(0, state.resumeAt - this.now()));
    this.timer = setTimeout(() => { this.timer = undefined; this.refresh(); }, delay);
    this.timer.unref?.();
  }
  private dispatch<K extends keyof CocoBudgetEvents>(event: K, state: CocoBudgetEvents[K]): void {
    for (const listener of [...this.listeners[event]]) {
      try { listener(state); } catch { /* one consumer must not break the budget clock */ }
    }
  }
}
