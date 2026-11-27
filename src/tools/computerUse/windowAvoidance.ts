import type { Point, Rect } from "./types.js";

/** Electron-side window operations; implemented in main (src/main/computerUseWindowHost.ts). */
export type ComputerUseWindowHost = {
  /** Bounds of JellyBot's visible windows, in computer-use coordinates (macOS points / Windows physical pixels). */
  visibleWindowRects(): Rect[];
  /** True when a JellyBot window holds keyboard focus. */
  isAppFocused(): boolean;
  /** Hides every visible JellyBot window and hands focus to the previously active app; returns how many were hidden. */
  hideAll(): number;
  /** Shows the windows hidden by hideAll; `focus` re-activates JellyBot, otherwise they come back inactive. */
  restoreAll(options: { focus: boolean }): number;
  focusMainWindow?(): void;
};

export type AvoidTarget =
  | { kind: "points"; points: readonly Point[] }
  | { kind: "area"; rect: Rect | null }
  | { kind: "focus" };

export type AvoidResult = { hidden: boolean; reason?: string };

export const WINDOW_SETTLE_MS = 250;
export const WINDOW_IDLE_RESTORE_MS = 120_000;

export function pointInRect(point: Point, rect: Rect): boolean {
  return point.x >= rect.x && point.x < rect.x + rect.width && point.y >= rect.y && point.y < rect.y + rect.height;
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class WindowAvoidance {
  private host: ComputerUseWindowHost | null = null;
  private hiddenBySession: string | null = null;
  private hiddenCount = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private idleRestoreHolds = 0;
  private readonly foregroundOnTurnEnd = new Set<string>();

  constructor(
    private readonly options: { settleMs: number; idleRestoreMs: number } = {
      settleMs: WINDOW_SETTLE_MS,
      idleRestoreMs: WINDOW_IDLE_RESTORE_MS,
    },
  ) {}

  configure(host: ComputerUseWindowHost | null): void {
    this.host = host;
  }

  get available(): boolean {
    return this.host !== null;
  }

  get hidden(): boolean {
    return this.hiddenCount > 0;
  }

  covers(point: Point): boolean {
    return this.host?.visibleWindowRects().some((rect) => pointInRect(point, rect)) ?? false;
  }

  /** Hides JellyBot when it would cover the target (or steal keystrokes); no-op when already clear. */
  async avoid(target: AvoidTarget, sessionId?: string): Promise<AvoidResult> {
    const host = this.host;
    if (!host) return { hidden: false };
    this.touch();
    const reason = this.blockingReason(host, target);
    if (!reason) return { hidden: false };
    await this.hide(sessionId);
    return { hidden: this.hidden, reason };
  }

  async hide(sessionId?: string): Promise<number> {
    const host = this.host;
    if (!host) return 0;
    this.touch();
    const count = host.hideAll();
    if (count > 0) {
      this.hiddenCount = Math.max(this.hiddenCount, count);
      this.hiddenBySession = sessionId ?? null;
      if (sessionId) this.foregroundOnTurnEnd.add(sessionId);
      this.touch();
      await sleep(this.options.settleMs);
    }
    return this.hiddenCount;
  }

  restore(options: { focus?: boolean } = {}): number {
    this.clearIdleTimer();
    const host = this.host;
    if (!host || !this.hidden) return 0;
    this.hiddenCount = 0;
    this.hiddenBySession = null;
    return host.restoreAll({ focus: options.focus === true });
  }

  /** Return to the app once the owning turn ends, including after a passive restore. */
  restoreForSession(sessionId: string, { focus = true }: { focus?: boolean } = {}): number {
    const bringForward = this.foregroundOnTurnEnd.delete(sessionId) && focus;
    if (this.hiddenBySession !== null && this.hiddenBySession !== sessionId) return 0;
    const count = this.restore({ focus: bringForward && !this.host?.focusMainWindow });
    if (bringForward) this.host?.focusMainWindow?.();
    return count;
  }

  async keepDesktop<T>(wait: () => Promise<T>, sessionId?: string): Promise<T> {
    if (sessionId) this.foregroundOnTurnEnd.add(sessionId);
    this.idleRestoreHolds += 1;
    this.clearIdleTimer();
    try {
      return await wait();
    } finally {
      this.idleRestoreHolds -= 1;
      this.touch();
    }
  }

  private blockingReason(host: ComputerUseWindowHost, target: AvoidTarget): string | null {
    if (target.kind === "focus") {
      return host.isAppFocused() ? "JellyBot had keyboard focus" : null;
    }
    const rects = host.visibleWindowRects();
    if (rects.length === 0) return null;
    if (target.kind === "points") {
      return target.points.some((p) => rects.some((r) => pointInRect(p, r)))
        ? "JellyBot covered the target point"
        : null;
    }
    const area = target.rect;
    return area === null || rects.some((r) => rectsIntersect(area, r))
      ? "JellyBot covered the capture area"
      : null;
  }

  private touch(): void {
    if (this.idleRestoreHolds > 0) return;
    if (!this.hidden && this.idleTimer === null) return;
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => this.restore({ focus: false }), this.options.idleRestoreMs);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}

const shared = new WindowAvoidance();

export function computerUseWindows(): WindowAvoidance {
  return shared;
}

export function configureComputerUseWindows(host: ComputerUseWindowHost | null): void {
  shared.configure(host);
}
