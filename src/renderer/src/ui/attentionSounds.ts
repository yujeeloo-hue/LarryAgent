/**
 * Attention sounds — short synthesized cues for the moments the agent stops
 * and waits for the user: a question card (ask_user / request_full_permissions),
 * a level-2 permission approval, and the plan Approve bar. Same philosophy as
 * attention sounds: no asset files, one lazily created shared AudioContext
 * (autoplay-gated), best-effort — silently no-ops when WebAudio is unavailable.
 *
 * Register map (kept distinct from the completion chime's C6→G6):
 * - ask       A4→D5 glide  spoken "?" contour — one pitch rising like "hm↗?"
 * - permission knock-knock thump ×2     — "may I come in"
 * - plan      A5→C#6→E6 rising triad     — "plan is ready to approve"
 * - notify    E6→C6 descending pair      — "a message arrived" (the mirror
 *   contour of the completion rise; the toast/popup arrival cue)
 * - demo      D5→A5 quick rising pair    — "demo params confirmed" (user
 *   action feedback, not an attention request)
 */

import { getSharedAudioContext } from "./completionChime.js";

type AttentionKind = "ask" | "permission" | "plan" | "notify" | "demo";

/** Min ms between two plays of the same kind (batched events stack easily). */
const MIN_INTERVAL_MS = 250;
const lastPlayedAt: Partial<Record<AttentionKind, number>> = {};

/** One tone: oscillator + exponential attack/decay envelope. A glideTo
 * bends the pitch continuously (exponentialRamp ≈ linear in pitch space),
 * which reads as spoken intonation instead of discrete bells. */
function tone(
  ctx: AudioContext,
  opts: {
    type?: OscillatorType;
    freq: number;
    delay: number;
    duration: number;
    peak: number;
    glideTo?: number;
    glideDur?: number;
  },
): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = opts.type ?? "sine";
  const t = ctx.currentTime + opts.delay;
  if (opts.glideTo !== undefined && opts.glideDur !== undefined) {
    osc.frequency.setValueAtTime(opts.freq, t);
    osc.frequency.exponentialRampToValueAtTime(opts.glideTo, t + opts.glideDur);
  } else {
    osc.frequency.value = opts.freq;
  }
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(opts.peak, t + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + opts.duration);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + opts.duration + 0.05);
}

/**
 * Muted percussive thump — sine tap plus a quieter triangle an octave down
 * for body. Fast decay keeps it knock-like instead of ringing.
 */
function knock(ctx: AudioContext, delay: number): void {
  tone(ctx, { freq: 466.16, delay, duration: 0.11, peak: 0.12 });
  tone(ctx, {
    type: "triangle",
    freq: 233.08,
    delay,
    duration: 0.14,
    peak: 0.05,
  });
}

function play(kind: AttentionKind, schedule: (ctx: AudioContext) => void): void {
  const now = Date.now();
  if (now - (lastPlayedAt[kind] ?? 0) < MIN_INTERVAL_MS) return;
  const ctx = getSharedAudioContext();
  if (!ctx) return;
  try {
    if (ctx.state === "suspended") void ctx.resume();
    schedule(ctx);
    lastPlayedAt[kind] = now;
  } catch {
    // Swallow: sound is best-effort.
  }
}

/** ask_user / request_full_permissions card appeared — spoken question
 * intonation: one soft sine gliding up a perfect fourth (A4→D5), the audio
 * form of "hm↗?". Rise spans most of the note, like a question's tail. */
export function playAskUserChime(): void {
  play("ask", (ctx) => {
    tone(ctx, {
      freq: 440.0,
      glideTo: 587.33,
      glideDur: 0.3,
      delay: 0,
      duration: 0.5,
      peak: 0.1,
    });
  });
}

/** Level-2 permission approval card appeared — knock-knock at the door. */
export function playPermissionKnock(): void {
  play("permission", (ctx) => {
    knock(ctx, 0);
    knock(ctx, 0.17);
  });
}

/** Plan Approve bar appeared — quick rising major arpeggio. */
export function playPlanReviewChime(): void {
  play("plan", (ctx) => {
    // A5 → C#6 → E6 (880 / 1108.73 / 1318.51 Hz) ≈ 0.6s tail.
    tone(ctx, { freq: 880.0, delay: 0, duration: 0.25, peak: 0.08 });
    tone(ctx, { freq: 1108.73, delay: 0.09, duration: 0.28, peak: 0.08 });
    tone(ctx, { freq: 1318.51, delay: 0.18, duration: 0.48, peak: 0.1 });
  });
}

/**
 * Notification arrived (in-app toast or background popup) — a soft
 * descending bell pair E6→C6, the mirror of the completion chime's rise:
 * "something came in", not "something finished".
 */
export function playNotifyChime(): void {
  play("notify", (ctx) => {
    tone(ctx, { freq: 1318.51, delay: 0, duration: 0.22, peak: 0.09 });
    tone(ctx, { freq: 1046.5, delay: 0.1, duration: 0.38, peak: 0.1 });
  });
}

/** Demo params confirmed — quick rising pair D5→A5: "got it, sent". */
export function playDemoConfirmChime(): void {
  play("demo", (ctx) => {
    tone(ctx, { freq: 587.33, delay: 0, duration: 0.12, peak: 0.08 });
    tone(ctx, { freq: 880.0, delay: 0.09, duration: 0.26, peak: 0.09 });
  });
}
