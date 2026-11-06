export type CocoIconRole = "global" | "work" | "chat";
export const COCO_RESET_MS = 500;

/** Share the CSS animation frame's clock when restoring a replaced icon. */
export function cocoIconAnimationTime(): number {
  const time = typeof document === "undefined" ? undefined : document.timeline?.currentTime;
  return typeof time === "number" ? time : performance.now();
}

type Reset = { startedAt: number; frame?: { transform: string; opacities: string[] } };
type Phase = { running: boolean; elapsed: number; startedAt?: number; animation?: Animation; offset: number; reset?: Reset };
type Icon = { element: HTMLElement; role: CocoIconRole; shape: SVGElement; layers: SVGElement[]; returning: Animation[] };

/** Keep native animation progress across renders and ease stopped icons back home. */
export class CocoIconMotionClock {
  private phases = new Map<CocoIconRole, Phase>();
  private icons = new Map<HTMLElement, Icon>();

  private phase(role: CocoIconRole): Phase {
    let phase = this.phases.get(role);
    if (!phase) { phase = { running: false, elapsed: 0, offset: 0 }; this.phases.set(role, phase); }
    return phase;
  }

  track(element: HTMLElement, role: CocoIconRole, offset: number): void {
    this.prune();
    const shape = element.querySelector<SVGElement>(".coco-icon-shape");
    if (!shape) return;
    const icon: Icon = { element, role, shape, layers: [...element.querySelectorAll<SVGElement>(".coco-icon-palette")], returning: [] };
    this.icons.set(element, icon);
    const phase = this.phase(role);
    const animation = shape.getAnimations()[0];
    if (animation) phase.animation = animation;
    else delete phase.animation;
    phase.offset = offset;
    if (phase.reset) this.returnHome(icon, phase.reset);
    else if (!phase.running) { this.settle(icon); phase.elapsed = phase.offset = 0; }
  }

  setRunning(flags: Record<CocoIconRole, boolean>, now = cocoIconAnimationTime()): void {
    this.prune();
    for (const role of ["global", "work", "chat"] as const) {
      const phase = this.phase(role);
      // A poll must neither restart a return nor extend its duration.
      if (flags[role] === phase.running) continue;
      const elapsed = this.elapsed(role, now);
      phase.running = flags[role];
      if (phase.running) {
        if (!phase.reset) { phase.elapsed = elapsed; phase.startedAt = now; }
      } else {
        if (phase.reset) continue;
        phase.elapsed = elapsed;
        delete phase.startedAt;
        const reset: Reset = { startedAt: now };
        phase.reset = reset;
        for (const icon of this.icons.values()) if (icon.role === role) this.returnHome(icon, reset);
      }
    }
  }

  elapsed(role: CocoIconRole, now = cocoIconAnimationTime()): number {
    const phase = this.phase(role);
    if (phase.reset) {
      if (now < phase.reset.startedAt + COCO_RESET_MS) return phase.elapsed;
      this.finishReset(role, phase.reset);
    }
    const time = phase.animation?.currentTime;
    if (typeof time === "number") return phase.offset + time;
    return phase.elapsed + (phase.startedAt === undefined ? 0 : now - phase.startedAt);
  }

  private returnHome(icon: Icon, reset: Reset): void {
    // Capture before pausing, then animate the actual displayed shape and palette
    // layers directly to their defaults (0°, only the first emerald layer). A
    // restart finishes this short return first.
    reset.frame ??= { transform: getComputedStyle(icon.shape).transform,
      opacities: icon.layers.map(layer => getComputedStyle(layer).opacity) };
    icon.element.classList.add("coco-icon--resetting");
    const timing: KeyframeAnimationOptions = { duration: COCO_RESET_MS, easing: "cubic-bezier(.22,.61,.36,1)", fill: "both" };
    const shape = icon.shape.animate([{ transform: reset.frame.transform }, { transform: "rotate(0deg)" }], timing);
    icon.returning = [shape, ...icon.layers.map((layer, i) => layer.animate([
      { opacity: reset.frame!.opacities[i] ?? getComputedStyle(layer).opacity },
      { opacity: i === 0 ? "1" : "0" },
    ], timing))];
    // Replacements join the same return, even halfway through its 500ms duration.
    for (const animation of icon.returning) animation.startTime = reset.startedAt;
    shape.onfinish = () => this.finishReset(icon.role, reset);
  }

  private settle(icon: Icon): void {
    icon.element.style.setProperty("--coco-motion-delay", "0s");
    icon.element.style.setProperty("--coco-spin-delay", "0s");
    // Read live animations after flushing the delays: hiding or moving the
    // persistent sidebar can replace every CSS animation on the same icon.
    // Resetting cached objects would miss the new palette and revive old ones.
    for (const animation of icon.element.getAnimations({ subtree: true })) {
      if (!icon.returning.includes(animation)) animation.currentTime = 0;
    }
    for (const animation of icon.returning) animation.cancel();
    icon.returning = [];
    icon.element.classList.remove("coco-icon--resetting");
  }

  private finishReset(role: CocoIconRole, reset: Reset): void {
    const phase = this.phase(role);
    if (phase.reset !== reset) return;
    delete phase.reset;
    phase.elapsed = phase.offset = 0;
    delete phase.animation;
    if (phase.running) phase.startedAt = reset.startedAt + COCO_RESET_MS;
    else delete phase.startedAt;
    for (const icon of this.icons.values()) if (icon.role === role && icon.element.isConnected) {
      this.settle(icon);
      const animation = icon.shape.getAnimations()[0];
      if (animation) phase.animation = animation;
    }
  }

  private prune(): void {
    for (const element of this.icons.keys()) if (!element.isConnected) {
      // Keep a detached return's finish callback alive until a replacement joins.
      this.icons.delete(element);
    }
  }
}

export const cocoIconMotionClock = new CocoIconMotionClock();
