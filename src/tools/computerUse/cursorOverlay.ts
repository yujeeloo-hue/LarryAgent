import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Point, Rect } from "./types.js";

export type CursorOverlayTheme = { dark: boolean; accent: string; onAccent: string };

export const DEFAULT_CURSOR_THEME: CursorOverlayTheme = { dark: true, accent: "#00e5ff", onAccent: "#111111" };

const SAFETY_RELEASE_MS = 10 * 60_000;
const QUIT_GRACE_MS = 600;

export interface CursorOverlay {
  readonly available: boolean;
  theme(next: CursorOverlayTheme): void;
  point(x: number, y: number): void;
  click(x: number, y: number): void;
  play(points: readonly Point[], intervalMs: number, options?: OverlayPlayOptions): void;
  position?(): Point | null;
  pause(): void;
  resume(): void;
  release(): void;
  dispose(): void;
}

export type TipKind = "action" | "choice" | "confirm" | "takeover";
export type TipSpec = {
  id: string;
  kind: TipKind;
  title: string;
  body?: string;
  options?: { label: string; sub?: string }[];
  primary: string;
  secondary?: string;
  danger?: boolean;
  watching?: boolean;
  countdown?: number;
  anchor?: Rect | null;
  place?: "anchored" | "corner";
  spotlight?: boolean;
};
export type TipSettled = { tone: "done" | "neutral"; title: string };
export type TipEvent =
  | { event: "tip.answer"; id: string; action: "primary" | "secondary"; choice?: number }
  | { event: "tip.lost"; id?: string };

export interface TipsOverlay {
  readonly available: boolean;
  showTip(spec: TipSpec): void;
  settleTip(id: string, view: TipSettled): void;
  hideTip(id: string): void;
  pause(): void;
  resume(): void;
  onTipEvent(listener: (event: TipEvent) => void): () => void;
}

export function parseTipEvent(line: string): TipEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.event === "tip.answer" && typeof record.id === "string") {
    const action = record.action === "secondary" ? "secondary" : "primary";
    const choice = typeof record.choice === "number" && Number.isInteger(record.choice) ? record.choice : undefined;
    return { event: "tip.answer", id: record.id, action, ...(choice !== undefined ? { choice } : {}) };
  }
  if (record.event === "tip.lost" || record.event === "closed") {
    return typeof record.id === "string" ? { event: "tip.lost", id: record.id } : { event: "tip.lost" };
  }
  return null;
}

export type OverlayCommand = { at: number; cmd: string; args?: Record<string, unknown> };
export type OverlayPlayOptions = { click?: boolean; delayMs?: number };

export function encodeCursorCommand(cmd: string, args?: Record<string, unknown>): string {
  const payload = args ? { cmd, args } : { cmd };
  return `${JSON.stringify(payload)}\n`;
}

export function overlaySchedule(
  points: readonly Point[],
  intervalMs: number,
  options: OverlayPlayOptions = {},
): OverlayCommand[] {
  if (points.length === 0) return [];
  const step = Math.max(0, intervalMs);
  const start = Math.max(0, options.delayMs ?? 0);
  const schedule: OverlayCommand[] = points.map((point, index) => ({
    at: start + index * step,
    cmd: "move",
    args: { x: point.x, y: point.y },
  }));
  if (options.click) {
    const last = points[points.length - 1]!;
    schedule.push({ at: start + points.length * step, cmd: "click", args: { x: last.x, y: last.y } });
  }
  return schedule;
}

export function scheduleEndsAt(schedule: readonly OverlayCommand[]): number {
  return schedule.reduce((last, item) => Math.max(last, item.at), 0);
}

export function cursorOverlayHelperPath(
  platform: NodeJS.Platform = process.platform,
  cwd: string = process.cwd(),
): string {
  const override = process.env.JELLYBOT_CURSOR_OVERLAY_HELPER?.trim();
  if (override) return resolve(override);
  const candidates = [
    ...(typeof process.resourcesPath === "string" && process.resourcesPath
      ? [join(process.resourcesPath, "helpers", "macos-virtual-cursor")]
      : []),
    join(cwd, "build", "helpers", "macos-virtual-cursor"),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  return found ?? candidates[candidates.length - 1]!;
}

export type OverlayChannelHandlers = {
  onEvent: (event: TipEvent) => void;
  onExit: (fatal: boolean) => void;
};

export interface OverlayChannel {
  send(cmd: string, args?: Record<string, unknown>): void;
  close(): void;
}

export type OverlayChannelFactory = (handlers: OverlayChannelHandlers) => OverlayChannel | null;

export function processOverlayChannel(helperPath: string): OverlayChannelFactory {
  return (handlers) => {
    if (!existsSync(helperPath)) return null;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(helperPath, [], { stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      return null;
    }
    let closed = false;
    let buffer = "";
    const logPath = process.env.JELLYBOT_CURSOR_OVERLAY_LOG;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (logPath) {
        try {
          appendFileSync(logPath, chunk);
        } catch {
          undefined;
        }
      }
      if (closed) return;
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        const event = line ? parseTipEvent(line) : null;
        if (event) handlers.onEvent(event);
        index = buffer.indexOf("\n");
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", () => undefined);
    const gone = (fatal: boolean): void => {
      if (closed) return;
      closed = true;
      handlers.onExit(fatal);
    };
    child.on("error", () => gone(true));
    child.on("exit", () => gone(false));
    return {
      send: (cmd, args) => {
        child.stdin.write(encodeCursorCommand(cmd, args));
      },
      close: () => {
        closed = true;
        try {
          child.stdin.write(encodeCursorCommand("quit"));
          child.stdin.end();
        } catch {
          child.kill();
          return;
        }
        const timer = setTimeout(() => child.kill(), QUIT_GRACE_MS);
        timer.unref?.();
      },
    };
  };
}

class ChannelCursorOverlay implements CursorOverlay, TipsOverlay {
  available = true;
  private channel: OverlayChannel | null = null;
  private timers = new Set<NodeJS.Timeout>();
  private releaseTimer: NodeJS.Timeout | null = null;
  private themeValue: CursorOverlayTheme = DEFAULT_CURSOR_THEME;
  private lastPoint: Point | null = null;
  private listeners = new Set<(event: TipEvent) => void>();
  private activeTip: string | null = null;
  private paused = false;

  constructor(
    private readonly openChannel: OverlayChannelFactory,
    private readonly safetyMs: number = SAFETY_RELEASE_MS,
  ) {}

  theme(next: CursorOverlayTheme): void {
    this.themeValue = next;
    this.send("theme", { dark: next.dark, accent: next.accent, onAccent: next.onAccent });
  }

  point(x: number, y: number): void {
    this.lastPoint = { x, y };
    this.send("move", { x, y });
    this.scheduleRelease();
  }

  click(x: number, y: number): void {
    this.lastPoint = { x, y };
    this.send("click", { x, y });
    this.scheduleRelease();
  }

  play(points: readonly Point[], intervalMs: number, options: OverlayPlayOptions = {}): void {
    this.clearTimers();
    if (points.length > 0) this.lastPoint = points[points.length - 1]!;
    const schedule = overlaySchedule(points, intervalMs, options);
    for (const item of schedule) {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        this.send(item.cmd, item.args);
      }, item.at);
      timer.unref?.();
      this.timers.add(timer);
    }
    this.scheduleRelease(scheduleEndsAt(schedule) + this.safetyMs);
  }

  release(): void {
    this.clearTimers();
    if (this.releaseTimer) {
      clearTimeout(this.releaseTimer);
      this.releaseTimer = null;
    }
    if (!this.channel) {
      this.lastPoint = null;
      return;
    }
    this.paused = false;
    this.send("end");
    this.lastPoint = null;
  }

  position(): Point | null {
    return this.lastPoint ? { ...this.lastPoint } : null;
  }

  showTip(spec: TipSpec): void {
    this.activeTip = spec.id;
    this.send("tip.show", { ...spec, anchor: spec.anchor ?? null, owner_pid: process.pid });
  }

  settleTip(id: string, view: TipSettled): void {
    if (this.activeTip === id) this.activeTip = null;
    this.send("tip.settle", { id, ...view });
  }

  hideTip(id: string): void {
    if (this.activeTip === id) this.activeTip = null;
    this.send("tip.hide", { id });
  }

  pause(): void {
    this.paused = true;
    if (this.releaseTimer) {
      clearTimeout(this.releaseTimer);
      this.releaseTimer = null;
    }
    if (this.lastPoint) this.send("pause");
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.send("resume");
    if (this.lastPoint) this.scheduleRelease();
  }

  onTipEvent(listener: (event: TipEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private dispatch(event: TipEvent): void {
    if (event.event === "tip.lost") {
      if (event.id && event.id !== this.activeTip) return;
      this.activeTip = null;
    }
    for (const listener of [...this.listeners]) listener(event);
  }

  private lost(): void {
    this.paused = false;
    if (this.activeTip) this.dispatch({ event: "tip.lost", id: this.activeTip });
  }

  dispose(): void {
    this.clearTimers();
    if (this.releaseTimer) {
      clearTimeout(this.releaseTimer);
      this.releaseTimer = null;
    }
    const channel = this.channel;
    this.channel = null;
    channel?.close();
  }

  private scheduleRelease(delayMs: number = this.safetyMs): void {
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    if (this.paused) {
      this.releaseTimer = null;
      return;
    }
    const timer = setTimeout(() => {
      this.releaseTimer = null;
      this.lastPoint = null;
      this.send("end");
    }, Math.max(0, delayMs));
    timer.unref?.();
    this.releaseTimer = timer;
  }

  private clearTimers(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  private ensureChannel(): OverlayChannel | null {
    if (this.channel) return this.channel;
    if (!this.available) return null;
    let channel: OverlayChannel | null = null;
    try {
      channel = this.openChannel({
        onEvent: (event) => {
          if (channel && this.channel === channel) this.dispatch(event);
        },
        onExit: (fatal) => {
          if (fatal) this.available = false;
          if (channel && this.channel === channel) {
            this.channel = null;
            this.lost();
          }
        },
      });
    } catch {
      channel = null;
    }
    if (!channel) {
      this.available = false;
      return null;
    }
    this.channel = channel;
    this.write(channel, "theme", {
      dark: this.themeValue.dark,
      accent: this.themeValue.accent,
      onAccent: this.themeValue.onAccent,
    });
    return this.channel;
  }

  private write(channel: OverlayChannel, cmd: string, args?: Record<string, unknown>): void {
    try {
      channel.send(cmd, args);
    } catch {
      this.available = false;
      if (this.channel === channel) {
        this.channel = null;
        this.lost();
      }
    }
  }

  private send(cmd: string, args?: Record<string, unknown>): void {
    const channel = this.ensureChannel();
    if (channel) this.write(channel, cmd, args);
  }
}

const nullOverlay: CursorOverlay = {
  available: false,
  theme: () => undefined,
  point: () => undefined,
  click: () => undefined,
  play: () => undefined,
  pause: () => undefined,
  resume: () => undefined,
  release: () => undefined,
  dispose: () => undefined,
};

export function createNullCursorOverlay(): CursorOverlay {
  return nullOverlay;
}

const nullTips: TipsOverlay = {
  available: false,
  showTip: () => undefined,
  settleTip: () => undefined,
  hideTip: () => undefined,
  pause: () => undefined,
  resume: () => undefined,
  onTipEvent: () => () => undefined,
};

function isTipsOverlay(value: unknown): value is TipsOverlay {
  return typeof (value as Partial<TipsOverlay> | null)?.showTip === "function";
}

let platformChannel: OverlayChannelFactory | null = null;

export function configureOverlayChannel(factory: OverlayChannelFactory | null): void {
  platformChannel = factory;
}

function overlayChannelFor(platform: NodeJS.Platform): OverlayChannelFactory | null {
  if (platform === "darwin") return processOverlayChannel(cursorOverlayHelperPath(platform));
  return platformChannel;
}

export function createCursorOverlay(platform: NodeJS.Platform = process.platform): CursorOverlay {
  const open = overlayChannelFor(platform);
  return open ? new ChannelCursorOverlay(open) : nullOverlay;
}

let shared: CursorOverlay = nullOverlay;
let managed: CursorOverlay | null = null;
let standaloneTips: ChannelCursorOverlay | null = null;
let tipsOverride: TipsOverlay | null = null;
let sharedTheme: CursorOverlayTheme = DEFAULT_CURSOR_THEME;

export function setCursorOverlayTheme(theme: CursorOverlayTheme): void {
  sharedTheme = theme;
  shared.theme(theme);
  standaloneTips?.theme(theme);
}

export function configureTipsOverlay(overlay: TipsOverlay | null): void {
  tipsOverride = overlay;
}

export function tipsOverlay(platform: NodeJS.Platform = process.platform): TipsOverlay {
  if (tipsOverride) return tipsOverride;
  if (managed?.available && isTipsOverlay(managed)) return managed;
  if (!standaloneTips) {
    const open = overlayChannelFor(platform);
    if (!open) return nullTips;
    standaloneTips = new ChannelCursorOverlay(open);
    standaloneTips.theme(sharedTheme);
  }
  return standaloneTips.available ? standaloneTips : nullTips;
}

export function disposeTipsOverlay(): void {
  standaloneTips?.dispose();
  standaloneTips = null;
}

export function configureCursorOverlay(overlay: CursorOverlay | null): void {
  shared = overlay ?? nullOverlay;
}

export function cursorOverlay(): CursorOverlay {
  return shared;
}

export function setCursorOverlayEnabled(
  value: boolean,
  platform: NodeJS.Platform = process.platform,
  factory: (target: NodeJS.Platform) => CursorOverlay = createCursorOverlay,
): void {
  if (!value) {
    disposeCursorOverlay();
    return;
  }
  if (managed) return;
  disposeTipsOverlay();
  managed = factory(platform);
  shared = managed;
  if (managed.available) managed.theme(sharedTheme);
}

export function disposeCursorOverlay(): void {
  managed?.dispose();
  managed = null;
  shared = nullOverlay;
}
