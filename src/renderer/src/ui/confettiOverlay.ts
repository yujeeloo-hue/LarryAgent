/**
 * Celebration confetti overlay — full-window canvas, pointer-transparent.
 *
 * Plays when a long-running Auto / Plan task finishes in the foreground
 * (`NodeActionNotifyTaskDone` + `celebrate`; the OS toast fires regardless of
 * focus), and on F12 as a manual test hook (immediate rain + chime; the main
 * process fires the OS toast after 5s). Physics: terminal-velocity fall,
 * per-piece flutter sway, two-axis tumble (yaw spin + out-of-plane flip with
 * face swap and sheen).
 */

import { playCompletionChime } from "./completionChime.js";

const PALETTE = [
  "#ff2d55", // vivid red-pink
  "#ff9500", // vivid orange
  "#ffd60a", // vivid yellow
  "#34d759", // vivid green
  "#00e5ff", // vivid cyan
  "#7ec8c8", // teal (app accent)
  "#bf5af2", // vivid purple
  "#ff375f", // vivid pink
] as const;

/** Darker "back face" of a piece (paper flips over mid-air). */
function backFace(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.round(((n >> 16) & 255) * 0.52);
  const g = Math.round(((n >> 8) & 255) * 0.52);
  const b = Math.round((n & 255) * 0.52);
  return `rgb(${r},${g},${b})`;
}

const rand = (min: number, max: number): number =>
  min + Math.random() * (max - min);
const pick = (arr: readonly string[]): string => {
  const item = arr[(Math.random() * arr.length) | 0];
  return item ?? arr[0] ?? "#7ec8c8";
};

class Piece {
  x = 0;
  y = 0;
  vx = 0;
  vy = 0;
  private terminal = 0;
  private dragK = 0;
  private phase = 0;
  private phaseSpeed = 0;
  private swayAmp = 0;
  private yaw = 0;
  private yawSpeed = 0;
  private tilt = 0;
  tiltSpeed = 0;
  // Fast secondary flutter — irregular turbulence layered on the sway.
  private turbPhase = 0;
  private turbSpeed = 0;
  private turbAmp = 0;
  private w = 0;
  private h = 0;
  private front = "";
  private back = "";
  private alpha = 1;
  dead = false;

  constructor(
    private readonly W: () => number,
    private readonly H: () => number,
    opts: {
      x?: number;
      y?: number;
      vy?: number;
      spread?: number;
    } = {},
  ) {
    this.reset(opts);
  }

  reset(opts: { x?: number; y?: number; vy?: number; spread?: number } = {}): void {
    const W = this.W();
    const H = this.H();
    this.x = opts.x ?? rand(-20, W + 20);
    this.y = opts.y ?? rand(-H * 0.35, -10);
    this.vx = opts.spread ?? rand(-60, 60);
    this.vy = opts.vy ?? rand(10, 40);
    // Terminal fall speed 120–270 px/s — real paper doesn't accelerate long.
    this.terminal = rand(120, 270);
    this.dragK = rand(2.8, 4.0);
    this.phase = rand(0, Math.PI * 2);
    this.phaseSpeed = rand(2.4, 5.2);
    this.swayAmp = rand(28, 70);
    this.yaw = rand(0, Math.PI * 2);
    this.yawSpeed = rand(-6.5, 6.5);
    this.tilt = rand(0, Math.PI * 2);
    this.tiltSpeed = rand(-8.5, 8.5);
    this.turbPhase = rand(0, Math.PI * 2);
    this.turbSpeed = rand(6, 11);
    this.turbAmp = rand(80, 180);
    this.w = rand(7, 13);
    this.h = rand(10, 18);
    const ribbon = Math.random() < 0.16;
    if (ribbon) {
      this.w = rand(3.5, 5);
      this.h = rand(22, 34);
    }
    this.front = pick(PALETTE);
    this.back = backFace(this.front);
    this.alpha = 1;
    this.dead = false;
  }

  update(dt: number, wind: number): void {
    const H = this.H();
    this.vy += (this.terminal - this.vy) * Math.min(1, this.dragK * dt);
    this.phase += this.phaseSpeed * dt;
    this.turbPhase += this.turbSpeed * dt;
    this.vx +=
      (Math.sin(this.phase) * this.swayAmp - this.vx) * Math.min(1, 1.8 * dt);
    // Turbulence: fast small-scale lateral kicks + descent-speed wobble,
    // so no two pieces trace the same path down.
    this.vx += Math.sin(this.turbPhase) * this.turbAmp * dt;
    this.vy += Math.cos(this.turbPhase * 1.3 + 1.7) * 60 * dt;
    this.vx += wind * dt;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.yaw += this.yawSpeed * dt;
    this.tilt += this.tiltSpeed * dt;
    if (this.y > H - 70) this.alpha = Math.max(0, (H - this.y) / 70);
    if (this.y > H + 30 || this.x < -60 || this.x > this.W() + 60) {
      this.dead = true;
    }
  }

  draw(ctx: CanvasRenderingContext2D): void {
    const tiltCos = Math.cos(this.tilt);
    const face = tiltCos >= 0 ? this.front : this.back;
    const scaleY = Math.max(0.12, Math.abs(tiltCos));
    ctx.globalAlpha = this.alpha;
    ctx.fillStyle = face;
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.rotate(this.yaw);
    ctx.scale(1, scaleY);
    // Edge-on pieces catch the light while flipping.
    if (Math.abs(tiltCos) < 0.28) {
      ctx.fillStyle = "rgba(255,255,255,0.92)";
    }
    ctx.fillRect(-this.w / 2, -this.h / 2, this.w, this.h);
    ctx.restore();
    ctx.globalAlpha = 1;
  }
}

export class ConfettiOverlay {
  private readonly canvas = document.createElement("canvas");
  private ctx: CanvasRenderingContext2D | null = null;
  private pieces: Piece[] = [];
  private rainUntil = 0;
  private rafId = 0;
  private lastFrame = 0;
  private unsubscribe: (() => void) | null = null;
  private readonly onResize = (): void => this.resize();
  private static readonly MAX_PIECES = 320;

  constructor() {
    // Hidden + no rAF loop between celebrations: an idle full-window canvas
    // still forces a full-screen layer composite every vsync.
    this.canvas.style.cssText =
      "position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:9999;display:none;";
  }

  /** Append the overlay and wire the IPC trigger. Idempotent. */
  mount(): void {
    if (this.ctx) return;
    document.body.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d");
    this.resize();
    window.addEventListener("resize", this.onResize);
    const bridge = window.jellybot;
    if (bridge?.onCelebration) {
      this.unsubscribe = bridge.onCelebration(() => this.celebrate());
    }
  }

  dispose(): void {
    cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    window.removeEventListener("resize", this.onResize);
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.canvas.remove();
    this.ctx = null;
    this.pieces = [];
  }

  /** Sustained confetti rain from the top + completion chime. */
  celebrate(): void {
    if (!this.ctx) return;
    playCompletionChime();
    this.rainUntil = performance.now() + 1500;
    if (this.rafId !== 0) return;
    this.canvas.style.display = "block";
    this.lastFrame = performance.now();
    this.rafId = requestAnimationFrame(this.frame);
  }

  private resize(): void {
    if (!this.ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.floor(window.innerWidth * dpr);
    this.canvas.height = Math.floor(window.innerHeight * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private readonly frame = (now: number): void => {
    const ctx = this.ctx;
    if (!ctx) return;
    const dt = Math.min(0.033, (now - this.lastFrame) / 1000);
    this.lastFrame = now;

    const W = window.innerWidth;
    const H = window.innerHeight;
    if (now < this.rainUntil && this.pieces.length < ConfettiOverlay.MAX_PIECES) {
      for (let i = 0; i < 3; i++) {
        if (this.pieces.length >= ConfettiOverlay.MAX_PIECES) break;
        this.pieces.push(
          new Piece(() => W, () => H),
        );
      }
    }

    const wind = Math.sin(now / 2400) * 14;
    ctx.clearRect(0, 0, W, H);
    for (let i = this.pieces.length - 1; i >= 0; i--) {
      const p = this.pieces[i];
      if (!p) continue;
      p.update(dt, wind);
      if (p.dead) {
        this.pieces.splice(i, 1);
        continue;
      }
      p.draw(ctx);
    }
    if (this.pieces.length === 0 && now >= this.rainUntil) {
      this.rafId = 0;
      this.canvas.style.display = "none";
      return;
    }
    this.rafId = requestAnimationFrame(this.frame);
  };
}
