
import { getSharedAudioContext } from "./completionChime.js";
import type { ComputerUseSound } from "../../../tools/computerUse/sound.js";

type AttentionKind = "ask" | "permission" | "plan" | "notify" | "demo" | "computer-click" | "computer-handoff";

const MIN_INTERVAL_MS = 250;
const lastPlayedAt: Partial<Record<AttentionKind, number>> = {};

function tone(
  ctx: AudioContext,
  opts: {
    type?: OscillatorType;
    freq: number;
    delay: number;
    duration: number;
    peak: number;
    attack?: number;
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
  gain.gain.exponentialRampToValueAtTime(opts.peak, t + (opts.attack ?? 0.01));
  gain.gain.exponentialRampToValueAtTime(0.0001, t + opts.duration);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + opts.duration + 0.05);
}

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

function play(kind: AttentionKind, schedule: (ctx: AudioContext) => void, minInterval = MIN_INTERVAL_MS): void {
  const now = Date.now();
  if (now - (lastPlayedAt[kind] ?? 0) < minInterval) return;
  const ctx = getSharedAudioContext();
  if (!ctx) return;
  try {
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});
    schedule(ctx);
    lastPlayedAt[kind] = now;
  } catch {
  }
}

export function playComputerUseSound(sound: ComputerUseSound): void {
  if (sound.kind === "click") {
    play("computer-click", (ctx) => {
      for (let i = 0; i < Math.min(sound.count, 3); i += 1) {
        tone(ctx, {
          type: "triangle", freq: 950, glideTo: 510, glideDur: 0.018,
          delay: i * 0.065, duration: 0.043, attack: 0.002, peak: 0.055,
        });
      }
    }, 45);
  } else {
    play("computer-handoff", (ctx) => {
      tone(ctx, { freq: 523.25, delay: 0, duration: 0.15, peak: 0.073 });
      tone(ctx, { freq: 698.46, delay: 0.1, duration: 0.27, peak: 0.085 });
    });
  }
}

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

export function playPermissionKnock(): void {
  play("permission", (ctx) => {
    knock(ctx, 0);
    knock(ctx, 0.17);
  });
}

export function playPlanReviewChime(): void {
  play("plan", (ctx) => {
    tone(ctx, { freq: 880.0, delay: 0, duration: 0.25, peak: 0.08 });
    tone(ctx, { freq: 1108.73, delay: 0.09, duration: 0.28, peak: 0.08 });
    tone(ctx, { freq: 1318.51, delay: 0.18, duration: 0.48, peak: 0.1 });
  });
}

export function playNotifyChime(): void {
  play("notify", (ctx) => {
    tone(ctx, { freq: 1318.51, delay: 0, duration: 0.22, peak: 0.09 });
    tone(ctx, { freq: 1046.5, delay: 0.1, duration: 0.38, peak: 0.1 });
  });
}

export function playDemoConfirmChime(): void {
  play("demo", (ctx) => {
    tone(ctx, { freq: 587.33, delay: 0, duration: 0.12, peak: 0.08 });
    tone(ctx, { freq: 880.0, delay: 0.09, duration: 0.26, peak: 0.09 });
  });
}
