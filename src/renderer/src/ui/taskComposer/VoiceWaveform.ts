/**
 * Live recording meter for voice input — a fixed row of vertical bars
 * driven by a ring buffer of recent level events (newest at right) and
 * rendered on a RAF loop with exponential attack/decay easing. The loop
 * runs only while active; bars decay to a low baseline when no recent
 * level events arrive. No external dependencies.
 */

const BAR_COUNT = 28;
/** Resting amplitude (0..1 of full bar height) when input goes idle. */
const IDLE_BASELINE = 0.1;
/** Per-frame easing toward rising targets — fast attack. */
const ATTACK_EASING = 0.5;
/** Per-frame easing toward falling targets — slower release. */
const DECAY_EASING = 0.16;
/** Levels older than this drop the meter back to the idle baseline. */
const IDLE_TIMEOUT_MS = 280;
/** Skip DOM writes below this per-bar scale delta. */
const WRITE_EPSILON = 0.0015;
/** Resting scaleY so silent bars stay visible as a thin baseline row. */
const MIN_SCALE = 0.12;
/** Hue sweep across the bar row (neon violet → neon pink). */
const HUE_START = 268;
const HUE_SWEEP = 62;

export class VoiceWaveform {
  private readonly root: HTMLElement;
  private readonly bars: HTMLElement[] = [];
  /** Ring buffer of recent levels; `head` is the next slot to write. */
  private readonly levels: number[] = [];
  /** Eased per-bar values currently painted (or converging) on screen. */
  private readonly displayed: number[] = [];
  private head = 0;
  private rafId = 0;
  private active = false;
  private lastPushAt = 0;

  /** Builds the bar row and appends it to `mount`. */
  constructor(mount: HTMLElement) {
    this.root = document.createElement("div");
    this.root.className = "composer-voice-wave";
    this.root.setAttribute("aria-hidden", "true");
    for (let i = 0; i < BAR_COUNT; i++) {
      const bar = document.createElement("span");
      bar.className = "composer-voice-bar";
      // Per-bar neon hue; color + glow live in CSS via this custom property.
      bar.style.setProperty(
        "--bar-hue",
        (HUE_START + (HUE_SWEEP * i) / (BAR_COUNT - 1)).toFixed(1),
      );
      this.bars.push(bar);
      this.levels.push(0);
      this.displayed.push(IDLE_BASELINE);
      this.root.append(bar);
    }
    mount.append(this.root);
    this.render(true);
  }

  /** Start / stop the RAF render loop. */
  setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    if (active) {
      this.lastPushAt = performance.now();
      this.rafId = requestAnimationFrame(this.tick);
    } else {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

  /**
   * Feed one level sample (0..1); arrives ~15Hz while recording.
   * Raw speech peaks sit around 0.05–0.35 and barely move the bars, so the
   * value goes through a perceptual expansion (power curve + gain) first:
   * ambient hiss stays near the baseline while normal speech reads clearly
   * and loud peaks clamp at full height.
   */
  pushLevel(value: number): void {
    const clamped = Math.min(1, Math.max(0, value));
    const expanded = Math.min(1, Math.pow(clamped, 0.6) * 1.7);
    this.levels[this.head] = expanded;
    this.head = (this.head + 1) % BAR_COUNT;
    this.lastPushAt = performance.now();
  }

  /** Stop the loop and detach the bar row from the DOM. */
  destroy(): void {
    this.setActive(false);
    this.root.remove();
    this.bars.length = 0;
  }

  private readonly tick = (): void => {
    if (!this.active) return;
    this.render(false);
    this.rafId = requestAnimationFrame(this.tick);
  };

  /**
   * Ease each bar toward its ring-buffer target (newest at right) and
   * write transforms only for bars that visibly moved. `force` repaints
   * every bar (initial paint).
   */
  private render(force: boolean): void {
    const idle = performance.now() - this.lastPushAt > IDLE_TIMEOUT_MS;
    for (let i = 0; i < BAR_COUNT; i++) {
      const target = idle
        ? IDLE_BASELINE
        : (this.levels[(this.head + i) % BAR_COUNT] ?? 0);
      const previous = this.displayed[i] ?? 0;
      const easing = target > previous ? ATTACK_EASING : DECAY_EASING;
      const next = previous + (target - previous) * easing;
      this.displayed[i] = next;
      const bar = this.bars[i];
      if (!bar) continue;
      if (!force && Math.abs(next - previous) <= WRITE_EPSILON) continue;
      const scale = MIN_SCALE + next * (1 - MIN_SCALE);
      bar.style.transform = `scaleY(${scale.toFixed(4)})`;
      // Louder bars glow brighter — element opacity fades background and
      // box-shadow together, so this drives the neon halo intensity too.
      bar.style.opacity = (0.5 + next * 0.5).toFixed(3);
    }
  }
}
