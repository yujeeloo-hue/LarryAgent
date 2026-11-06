/**
 * Completion chime — short synthesized two-note flourish (C6→G6) with a
 * fast decay, played via WebAudio when a long-running task finishes.
 * No asset files; the AudioContext is created lazily on first play
 * (autoplay policy requires a prior user gesture in the renderer).
 */

/** Lazily created shared AudioContext (autoplay-gated), app-wide. */
let audioCtx: AudioContext | null = null;

export function getSharedAudioContext(): AudioContext | null {
  if (audioCtx) return audioCtx;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Ctor) return null;
  try {
    audioCtx = new Ctor();
  } catch {
    audioCtx = null;
  }
  return audioCtx;
}

/** One soft-sine note with exponential decay. */
function playNote(
  ctx: AudioContext,
  opts: { freq: number; startAt: number; duration: number; peak: number },
): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.value = opts.freq;
  const t = opts.startAt;
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(opts.peak, t + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + opts.duration);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + opts.duration + 0.05);
}

/**
 * Play the completion chime once. Safe to call anywhere; silently no-ops
 * when WebAudio is unavailable or still autoplay-gated.
 */
export function playCompletionChime(): void {
  const ctx = getSharedAudioContext();
  if (!ctx) return;
  try {
    if (ctx.state === "suspended") void ctx.resume();
    const now = ctx.currentTime;
    // C6 → G6 (1046.5 / 1568 Hz), overlapping soft sines ≈ 0.7s tail.
    playNote(ctx, { freq: 1046.5, startAt: now, duration: 0.35, peak: 0.12 });
    playNote(ctx, {
      freq: 1568.0,
      startAt: now + 0.12,
      duration: 0.45,
      peak: 0.1,
    });
  } catch {
    // Swallow: sound is best-effort.
  }
}
