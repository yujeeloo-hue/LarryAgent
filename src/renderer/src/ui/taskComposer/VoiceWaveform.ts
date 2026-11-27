
const BAR_COUNT = 28;
const IDLE_BASELINE = 0.1;
const ATTACK_EASING = 0.5;
const DECAY_EASING = 0.16;
const IDLE_TIMEOUT_MS = 280;
const WRITE_EPSILON = 0.0015;
const MIN_SCALE = 0.12;
const HUE_START = 268;
const HUE_SWEEP = 62;

export class VoiceWaveform {
  private readonly root: HTMLElement;
  private readonly bars: HTMLElement[] = [];
  private readonly levels: number[] = [];
  private readonly displayed: number[] = [];
  private head = 0;
  private rafId = 0;
  private active = false;
  private lastPushAt = 0;

  constructor(mount: HTMLElement) {
    this.root = document.createElement("div");
    this.root.className = "composer-voice-wave";
    this.root.setAttribute("aria-hidden", "true");
    for (let i = 0; i < BAR_COUNT; i++) {
      const bar = document.createElement("span");
      bar.className = "composer-voice-bar";
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

  pushLevel(value: number): void {
    const clamped = Math.min(1, Math.max(0, value));
    const expanded = Math.min(1, Math.pow(clamped, 0.6) * 1.7);
    this.levels[this.head] = expanded;
    this.head = (this.head + 1) % BAR_COUNT;
    this.lastPushAt = performance.now();
  }

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
      bar.style.opacity = (0.5 + next * 0.5).toFixed(3);
    }
  }
}
