import type { Point, Rect } from "./types.js";

export type Easing = "linear" | "easeInCubic" | "easeOutCubic" | "easeInOutCubic";

export const EASINGS: Record<Easing, (t: number) => number> = {
  linear: (t) => t,
  easeInCubic: (t) => t * t * t,
  easeOutCubic: (t) => 1 - (1 - t) ** 3,
  easeInOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
};

export const EASING_NAMES = Object.keys(EASINGS) as Easing[];

export const MOVE_DEFAULT_SECONDS = 0.4;
/** Moves longer than this get sped up to AUTO_SPEED instead of the default duration. */
export const MOVE_AUTO_THRESHOLD = 800;
export const MOVE_AUTO_SPEED = 2400;
export const MOVE_FRAME_RATE = 60;
export const MOVE_MAX_FRAMES = 180;
export const MOVE_MIN_DISTANCE = 0.5;

export const CLICK_INTERVAL_MS = 90;
export const MODIFIER_GAP_MS = 20;
export const KEY_TAP_HOLD_MS = 12;
export const MIN_TYPING_PAUSE_MS = 15;
export const PUNCTUATION_PAUSE_FACTOR = 1.6;
export const PAUSE_AFTER = new Set(Array.from("，。；：、！？,.!?;:"));

export function autoDuration(distance: number, duration?: number | undefined): number {
  if (duration !== undefined) return Math.max(duration, 0.01);
  if (distance > MOVE_AUTO_THRESHOLD) return distance / MOVE_AUTO_SPEED;
  return MOVE_DEFAULT_SECONDS;
}

export function frameCount(durationS: number, steps?: number | undefined, minimum = 2): number {
  if (steps !== undefined && steps > 0) return Math.min(Math.round(steps), MOVE_MAX_FRAMES * 4);
  return Math.max(minimum, Math.min(Math.trunc(durationS * MOVE_FRAME_RATE), MOVE_MAX_FRAMES));
}

export type MovePlan = {
  from: Point;
  to: Point;
  distance: number;
  durationS: number;
  frames: number;
  easing: Easing;
  intervalMs: number;
  /** Intermediate frames, ending exactly on `to`; empty when already there. */
  points: Point[];
};

export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export function planMove(
  from: Point,
  to: Point,
  options: {
    durationS?: number | undefined;
    easing?: Easing | undefined;
    steps?: number | undefined;
    minFrames?: number | undefined;
  } = {},
): MovePlan {
  const easing = options.easing ?? "easeInOutCubic";
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const durationS = autoDuration(distance, options.durationS);
  const frames = frameCount(durationS, options.steps, options.minFrames ?? 2);
  const curve = EASINGS[easing] ?? EASINGS.easeInOutCubic;
  const points: Point[] = [];
  if (distance >= MOVE_MIN_DISTANCE) {
    for (let i = 1; i <= frames; i += 1) {
      const t = curve(i / frames);
      points.push({
        x: round1(from.x + (to.x - from.x) * t),
        y: round1(from.y + (to.y - from.y) * t),
      });
    }
    points[points.length - 1] = { x: to.x, y: to.y };
  }
  return {
    from,
    to,
    distance: round1(distance),
    durationS: Math.round(durationS * 100) / 100,
    frames,
    easing,
    intervalMs: Math.max(1, Math.round((durationS * 1000) / frames)),
    points,
  };
}

/** Pause after every character except the last, with jitter and a longer beat after punctuation. */
export function typingPauses(
  chars: readonly string[],
  intervalMs: number,
  jitterMs: number,
  random: () => number = Math.random,
): number[] {
  const pauses: number[] = [];
  for (let i = 0; i < chars.length - 1; i += 1) {
    let pause = intervalMs + (random() * 2 - 1) * jitterMs;
    if (PAUSE_AFTER.has(chars[i]!)) pause *= PUNCTUATION_PAUSE_FACTOR;
    pauses.push(Math.round(Math.max(MIN_TYPING_PAUSE_MS, pause)));
  }
  return pauses;
}

/** Keeps a target on a visible display: unchanged if inside one, else snapped to the nearest display edge. */
export function clampPoint(point: Point, screens: readonly Rect[]): Point {
  if (screens.length === 0) return point;
  for (const s of screens) {
    if (point.x >= s.x && point.x < s.x + s.width && point.y >= s.y && point.y < s.y + s.height) {
      return point;
    }
  }
  let best = point;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const s of screens) {
    const x = Math.min(Math.max(point.x, s.x), s.x + s.width - 1);
    const y = Math.min(Math.max(point.y, s.y), s.y + s.height - 1);
    const d = (x - point.x) ** 2 + (y - point.y) ** 2;
    if (d < bestDistance) {
      bestDistance = d;
      best = { x, y };
    }
  }
  return best;
}

export function rectCenter(rect: Rect): Point {
  return { x: round1(rect.x + rect.width / 2), y: round1(rect.y + rect.height / 2) };
}
