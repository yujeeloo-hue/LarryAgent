import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HandoffPasswordDestination } from "../../shared/askUser.js";
import { ensureComputerUseCacheDir } from "./cache.js";
import {
  KeyResolutionError,
  isModifierName,
  macKeycodeForChar,
  parseMainKey,
  resolveModifiers,
  resolveSpecialKey,
  type ResolvedModifier,
} from "./keymap.js";
import {
  KEY_TAP_HOLD_MS,
  MODIFIER_GAP_MS,
  clampPoint,
  planMove,
  round1,
  typingPauses,
  type Easing,
} from "./motion.js";
import { findTextInLines, imageBoxToScreen } from "./ocrMatch.js";
import { normalizeRole } from "./roles.js";
import { publishComputerUseSound } from "./sound.js";
import type {
  AppInfo,
  BatchDesktopState,
  CaptureResult,
  ComputerUsePlatform,
  FrontWindow,
  MouseButton,
  OcrLine,
  PermissionStatus,
  Point,
  Rect,
  ScreenInfo,
  ScreenLine,
  UiElement,
  WindowSummary,
} from "./types.js";
import { computerUseWindows, type AvoidTarget, type WindowAvoidance } from "./windowAvoidance.js";
import { cursorOverlay, type CursorOverlay } from "./cursorOverlay.js";
import { ComputerUseError, type ComputerUseBackend } from "./worker.js";

export const UI_MATCH_LIMIT = 50;
export const OCR_RECOGNIZED_PREVIEW = 30;
const TYPE_CHUNK_MS = 4_000;
const DRAG_SETTLE_MS = 50;
const SEQUENCE_SLACK_MS = 15_000;
const OVERLAY_SETTLE_MS = 80;
const OCR_TIMEOUT_MS = 90_000;

type InputEvent = Record<string, unknown> & { t: string };
type Opt<T> = T | undefined;
type SequenceResult = Point & { held_buttons?: string[] };
type DeliveredResult = { delivery?: Record<string, unknown>; held_buttons?: string[] };
export type InputActivity = { pointerIdleS: number; syntheticAgeS: number | null; cursor: Point };

const agentPointers = new WeakMap<ComputerUseBackend, Point>();

function deliveryOutcome(result: DeliveredResult): Outcome {
  return result.delivery ? { delivery: result.delivery } : {};
}

function deliveryArg(borrowPointer: boolean | undefined): "borrow" | "auto" {
  return borrowPointer ? "borrow" : "auto";
}

export type CallOptions = {
  signal?: AbortSignal;
  sessionId?: string;
  /** Hide JellyBot first when it would cover the target or receive the keystrokes. */
  avoidOcclusion?: boolean;
  beforeInput?: (point?: Point) => Promise<void>;
};

export type Outcome = Record<string, unknown>;

function sequenceDuration(events: readonly InputEvent[]): number {
  return events.reduce((sum, e) => sum + (e.t === "sleep" ? Number(e.ms) || 0 : e.t === "move" ? 2 : 1), 0);
}

function dryRun(planned: Record<string, unknown>): Outcome {
  return { dry_run: true, planned };
}

function sleepEvent(ms: number): InputEvent {
  return { t: "sleep", ms: Math.max(0, Math.round(ms)) };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("Cancelled");
  error.name = "AbortError";
  throw error;
}

export class ComputerUseService {
  constructor(
    private readonly backend: ComputerUseBackend,
    private readonly windows: WindowAvoidance = computerUseWindows(),
    private readonly overlay: CursorOverlay = cursorOverlay(),
  ) {}

  get platform(): ComputerUsePlatform {
    return this.backend.platform;
  }

  // ------------------------------------------------------------------ helpers

  private async run(events: InputEvent[], signal?: AbortSignal): Promise<SequenceResult> {
    return this.backend.request<SequenceResult>("input.sequence", { events }, {
      timeoutMs: sequenceDuration(events) + SEQUENCE_SLACK_MS,
      ...(signal ? { signal } : {}),
    });
  }

  private async avoid(target: AvoidTarget, options: CallOptions): Promise<Outcome> {
    if (options.avoidOcclusion === false) return {};
    const result = await this.windows.avoid(target, options.sessionId);
    return result.hidden
      ? { jellybot_hidden: true, jellybot_hidden_reason: result.reason, note: "JellyBot hid its windows to keep the desktop clear; they come back when the turn ends (or computer_system show_jellybot)." }
      : {};
  }

  async screens(): Promise<ScreenInfo[]> {
    const { screens } = await this.backend.request<{ screens: ScreenInfo[] }>("screens");
    return screens;
  }

  async inputActivity(): Promise<InputActivity | null> {
    try {
      const result = await this.backend.request<{ pointer_idle_s?: number; synthetic_age_s?: number; cursor?: Point }>(
        "input.activity",
        {},
        { timeoutMs: 2_000 },
      );
      if (typeof result.pointer_idle_s !== "number" || !result.cursor) return null;
      return {
        pointerIdleS: result.pointer_idle_s,
        syntheticAgeS: typeof result.synthetic_age_s === "number" ? result.synthetic_age_s : null,
        cursor: result.cursor,
      };
    } catch {
      return null;
    }
  }

  coversJellyBot(point: Point): boolean {
    return this.windows.covers(point);
  }

  private async clamp(point: Point): Promise<Point> {
    const clamped = clampPoint(point, await this.screens());
    return { x: round1(clamped.x), y: round1(clamped.y) };
  }

  async position(): Promise<Point> {
    const virtual = this.overlay.position?.();
    if (virtual) return { x: round1(virtual.x), y: round1(virtual.y) };
    const parked = agentPointers.get(this.backend);
    if (parked) return { ...parked };
    const p = await this.backend.request<Point>("mouse.position");
    return { x: p.x, y: p.y };
  }

  private park(point: Point): void {
    agentPointers.set(this.backend, { x: point.x, y: point.y });
  }

  private async hover(points: readonly Point[], intervalMs: number): Promise<void> {
    await this.backend.request(
      "input.hover",
      { points: points.map((p) => ({ x: p.x, y: p.y })), interval_ms: intervalMs },
      { timeoutMs: points.length * intervalMs + SEQUENCE_SLACK_MS },
    );
  }

  private async glide(plan: { points: readonly Point[]; intervalMs: number } | null): Promise<void> {
    if (!plan || plan.points.length === 0 || !this.overlay.available) return;
    this.overlay.play(plan.points, plan.intervalMs);
    await this.hover(plan.points, plan.intervalMs);
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, OVERLAY_SETTLE_MS));
  }

  private modifierDown(mods: readonly ResolvedModifier[]): InputEvent[] {
    const events: InputEvent[] = [];
    mods.forEach((m, i) => {
      events.push({ t: "vk", code: m.code, extended: m.extended, down: true, modifiers: mods.slice(0, i + 1).map((x) => x.name) });
      events.push(sleepEvent(MODIFIER_GAP_MS));
    });
    return events;
  }

  private modifierUp(mods: readonly ResolvedModifier[]): InputEvent[] {
    const events: InputEvent[] = [];
    for (let i = mods.length - 1; i >= 0; i -= 1) {
      const m = mods[i]!;
      events.push(sleepEvent(MODIFIER_GAP_MS));
      events.push({ t: "vk", code: m.code, extended: m.extended, down: false, modifiers: mods.slice(0, i).map((x) => x.name) });
    }
    return events;
  }

  // ------------------------------------------------------------------ system

  async systemInfo(): Promise<Outcome> {
    const info = await this.backend.request<{
      version: string;
      screens: ScreenInfo[];
      permissions: PermissionStatus;
      frontmost_pid?: number;
    }>("system.info", {}, { timeoutMs: 15_000 });
    return {
      ok: info.permissions.accessibility && info.permissions.screen_capture,
      platform: this.platform,
      helper_version: info.version,
      permissions: info.permissions,
      screens: info.screens,
      frontmost_pid: info.frontmost_pid,
      jellybot_hidden: this.windows.hidden,
    };
  }

  async batchDesktopState(pid: number, point?: Point, signal?: AbortSignal): Promise<BatchDesktopState> {
    return this.backend.request<BatchDesktopState>(
      "ui.batch_state",
      { pid, ...point },
      { timeoutMs: 3_000, ...(signal ? { signal } : {}) },
    );
  }

  async prepareBatchInput(options: CallOptions): Promise<void> {
    await this.avoid({ kind: "focus" }, options);
  }

  async requestPermissions(): Promise<Outcome> {
    const result = await this.backend.request<PermissionStatus>("permissions.request", {}, { timeoutMs: 15_000 });
    return { permissions: result };
  }

  async hideJellyBot(sessionId?: string): Promise<Outcome> {
    if (!this.windows.available) return { ok: false, error: "Window control is unavailable in this host." };
    const hidden = await this.windows.hide(sessionId);
    return { jellybot_hidden: this.windows.hidden, windows: hidden };
  }

  showJellyBot(focus: boolean): Outcome {
    const restored = this.windows.restore({ focus });
    return { jellybot_hidden: false, windows_restored: restored };
  }

  // ------------------------------------------------------------------ mouse

  async mouseMove(
    input: { x: number; y: number; durationS?: Opt<number>; easing?: Opt<Easing>; steps?: Opt<number>; dryRun?: boolean },
    options: CallOptions = {},
  ): Promise<Outcome> {
    const to = await this.clamp({ x: input.x, y: input.y });
    const from = await this.position();
    const plan = planMove(from, to, { durationS: input.durationS, easing: input.easing, steps: input.steps });
    const planned = { from, to, distance: plan.distance, duration_s: plan.durationS, frames: plan.frames, easing: plan.easing };
    if (input.dryRun) return dryRun(planned);
    const hidden = await this.avoid({ kind: "points", points: [to] }, options);
    this.overlay.play(plan.points, plan.intervalMs);
    await this.hover(plan.points, plan.intervalMs);
    this.park(to);
    return { moved_to: to, from, distance: plan.distance, duration_s: plan.durationS, pointer: "virtual", ...hidden };
  }

  async mouseClick(
    input: {
      x?: Opt<number>;
      y?: Opt<number>;
      button: MouseButton;
      clicks: number;
      modifiers?: Opt<string[]>;
      holdS: number;
      durationS?: Opt<number>;
      borrowPointer?: boolean;
      dryRun?: boolean;
    },
    options: CallOptions = {},
  ): Promise<Outcome> {
    const mods = resolveModifiers(input.modifiers, this.platform);
    const current = await this.position();
    const moving = input.x !== undefined && input.y !== undefined;
    const target = moving ? await this.clamp({ x: input.x!, y: input.y! }) : current;
    const planned = { target, button: input.button, clicks: input.clicks, modifiers: mods.map((m) => m.name), hold_s: input.holdS };
    if (input.dryRun) return dryRun(planned);

    const hidden = await this.avoid({ kind: "points", points: [target] }, options);
    const approach = moving ? planMove(await this.position(), target, { durationS: input.durationS }) : null;
    const flags = mods.map((m) => m.name);
    await this.glide(approach);
    await options.beforeInput?.(target);
    this.overlay.click(target.x, target.y);
    const result = await this.backend.request<DeliveredResult>("input.click_at", {
      x: target.x,
      y: target.y,
      button: input.button,
      clicks: input.clicks,
      hold_ms: Math.max(0, input.holdS * 1000),
      modifiers: flags,
      delivery: deliveryArg(input.borrowPointer),
    });
    this.park(target);
    if (!options.signal?.aborted) publishComputerUseSound({ kind: "click", count: input.clicks });
    return {
      clicked: target,
      button: input.button,
      clicks: input.clicks,
      modifiers: flags,
      ...deliveryOutcome(result),
      ...hidden,
    };
  }

  async mouseDrag(
    input: {
      from: Point;
      to: Point;
      button: MouseButton;
      durationS?: Opt<number>;
      steps?: Opt<number>;
      borrowPointer?: boolean;
      dryRun?: boolean;
    },
    options: CallOptions = {},
  ): Promise<Outcome> {
    const from = await this.clamp(input.from);
    const to = await this.clamp(input.to);
    if (input.dryRun) return dryRun({ from, to, button: input.button });
    const hidden = await this.avoid({ kind: "points", points: [from, to] }, options);
    const approach = planMove(await this.position(), from, {});
    const drag = planMove(from, to, { durationS: input.durationS, steps: input.steps, minFrames: 4 });
    await this.glide(approach);
    this.overlay.click(from.x, from.y);
    this.overlay.play(drag.points, drag.intervalMs, { delayMs: DRAG_SETTLE_MS });
    const result = await this.backend.request<DeliveredResult>(
      "input.drag_path",
      {
        points: [from, ...drag.points].map((p) => ({ x: p.x, y: p.y })),
        button: input.button,
        interval_ms: drag.intervalMs,
        settle_ms: DRAG_SETTLE_MS,
        delivery: deliveryArg(input.borrowPointer),
      },
      { timeoutMs: drag.durationS * 1000 + SEQUENCE_SLACK_MS },
    );
    this.park(to);
    return {
      dragged: { from, to },
      button: input.button,
      duration_s: drag.durationS,
      ...deliveryOutcome(result),
      ...hidden,
    };
  }

  async mouseScroll(
    input: { dx: number; dy: number; unit: "line" | "pixel"; borrowPointer?: boolean; dryRun?: boolean },
    options: CallOptions = {},
  ): Promise<Outcome> {
    const planned = { delta_x: input.dx, delta_y: input.dy, unit: input.unit };
    if (input.dryRun) return dryRun(planned);
    const at = await this.position();
    const hidden = await this.avoid({ kind: "points", points: [at] }, options);
    this.overlay.point(at.x, at.y);
    const result = await this.backend.request<DeliveredResult>("input.scroll_at", {
      x: at.x,
      y: at.y,
      dx: Math.round(input.dx),
      dy: Math.round(input.dy),
      unit: input.unit,
      delivery: deliveryArg(input.borrowPointer),
    });
    return { scrolled: planned, at, ...deliveryOutcome(result), ...hidden };
  }

  async mouseHold(
    input: { x?: Opt<number>; y?: Opt<number>; button: MouseButton; borrowPointer?: boolean; dryRun?: boolean },
    options: CallOptions = {},
  ): Promise<Outcome> {
    const current = await this.position();
    const moving = input.x !== undefined && input.y !== undefined;
    const target = moving ? await this.clamp({ x: input.x!, y: input.y! }) : current;
    if (input.dryRun) return dryRun({ will_move_to: target, button: input.button });
    const hidden = await this.avoid({ kind: "points", points: [target] }, options);
    await this.glide(moving ? planMove(current, target, {}) : null);
    this.overlay.click(target.x, target.y);
    const result = await this.backend.request<DeliveredResult>("input.button_at", {
      x: target.x,
      y: target.y,
      button: input.button,
      down: true,
      delivery: deliveryArg(input.borrowPointer),
    });
    this.park(target);
    return {
      holding: target,
      button: input.button,
      held_buttons: result.held_buttons ?? [input.button],
      ...deliveryOutcome(result),
      ...hidden,
    };
  }

  async mouseRelease(input: { button: MouseButton; dryRun?: boolean }, _options: CallOptions = {}): Promise<Outcome> {
    if (input.dryRun) return dryRun({ button: input.button });
    const at = await this.position();
    const result = await this.backend.request<DeliveredResult>("input.button_at", {
      button: input.button,
      down: false,
    });
    return { released: at, button: input.button, held_buttons: result.held_buttons ?? [], ...deliveryOutcome(result) };
  }

  // ------------------------------------------------------------------ keyboard

  private async mainKeyEvents(
    key: string,
    mods: readonly ResolvedModifier[],
    holdMs: number,
  ): Promise<{ events: InputEvent[]; resolved: Record<string, unknown> }> {
    const flags = mods.map((m) => m.name);
    const main = parseMainKey(key, this.platform);
    let vk: { code: number; extended: boolean } | null = main.kind === "special" ? main.key : null;
    const char = main.kind === "char" ? main.char : null;
    if (char !== null && mods.length > 0) {
      // Shortcuts need a virtual key: a Unicode event under Ctrl turns into a control character.
      if (this.platform === "macos") {
        const code = macKeycodeForChar(char);
        if (code !== null) vk = { code, extended: false };
      } else {
        const found = await this.backend.request<{ vk: number | null; shift_state?: number }>("key.char_vk", { char });
        if (typeof found.vk === "number" && !found.shift_state) vk = { code: found.vk, extended: false };
      }
    }
    const down: InputEvent = vk
      ? { t: "vk", code: vk.code, extended: vk.extended, down: true, modifiers: flags }
      : { t: "char", text: char, down: true, modifiers: flags };
    const up: InputEvent = { ...down, down: false };
    return {
      events: [down, sleepEvent(holdMs), up],
      resolved: { char, keycode: vk?.code ?? null },
    };
  }

  async keyPress(
    input: { key: string; modifiers?: Opt<string[]>; holdS: number; dryRun?: boolean },
    options: CallOptions = {},
  ): Promise<Outcome> {
    const mods = resolveModifiers(input.modifiers, this.platform);
    const { events, resolved } = await this.mainKeyEvents(input.key, mods, input.holdS * 1000);
    if (input.dryRun) return dryRun({ key: input.key, modifiers: mods.map((m) => m.name), ...resolved });
    const hidden = await this.avoid({ kind: "focus" }, options);
    await options.beforeInput?.();
    await this.run([...this.modifierDown(mods), ...events, ...this.modifierUp(mods)], options.signal);
    return { pressed: input.key, modifiers: mods.map((m) => m.name), ...resolved, ...hidden };
  }

  async keyCombo(input: { keys: string[]; dryRun?: boolean }, options: CallOptions = {}): Promise<Outcome> {
    if (input.keys.length === 0) throw new KeyResolutionError("keys needs at least one key (the last one is the main key).");
    const leading = input.keys.slice(0, -1);
    for (const name of leading) {
      if (!isModifierName(name, this.platform)) {
        throw new KeyResolutionError(`Leading combo keys must be modifiers; "${name}" is not.`);
      }
    }
    const mods = resolveModifiers(leading, this.platform);
    const mainKey = input.keys[input.keys.length - 1]!;
    const { events, resolved } = await this.mainKeyEvents(mainKey, mods, 30);
    if (input.dryRun) return dryRun({ keys: input.keys, modifiers: mods.map((m) => m.name), main: { key: mainKey, ...resolved } });
    const hidden = await this.avoid({ kind: "focus" }, options);
    await options.beforeInput?.();
    await this.run([...this.modifierDown(mods), ...events, ...this.modifierUp(mods)], options.signal);
    return { combo: input.keys, ...hidden };
  }

  private charEvents(char: string, holdMs = KEY_TAP_HOLD_MS): InputEvent[] {
    const special = char === "\n" ? "return" : char === "\t" ? "tab" : null;
    if (special) {
      const key = resolveSpecialKey(special, this.platform)!;
      return [
        { t: "vk", code: key.code, extended: key.extended, down: true },
        sleepEvent(KEY_TAP_HOLD_MS),
        { t: "vk", code: key.code, extended: key.extended, down: false },
      ];
    }
    return [
      { t: "char", text: char, down: true },
      sleepEvent(holdMs),
      { t: "char", text: char, down: false },
    ];
  }

  async typeText(
    input: { text: string; intervalMs: number; jitterMs: number; holdMs?: number; dryRun?: boolean },
    options: CallOptions = {},
  ): Promise<Outcome> {
    const chars = Array.from(input.text.replace(/\r\n?/g, "\n"));
    if (chars.length === 0) return { typed: "", chars: 0, note: "empty text" };
    if (input.dryRun) {
      return dryRun({ chars: chars.length, estimated_duration_s: Math.round((chars.length * input.intervalMs) / 100) / 10 });
    }
    const hidden = await this.avoid({ kind: "focus" }, options);
    const pauses = typingPauses(chars, input.intervalMs, input.jitterMs);
    const chunkLimit = options.beforeInput ? 220 : TYPE_CHUNK_MS;
    const started = Date.now();
    let chunk: InputEvent[] = [];
    let chunkMs = 0;
    for (let i = 0; i < chars.length; i += 1) {
      chunk.push(...this.charEvents(chars[i]!, input.holdMs));
      const pause = pauses[i];
      if (pause !== undefined) {
        chunk.push(sleepEvent(pause));
        chunkMs += pause;
      }
      if (chunkMs >= chunkLimit || i === chars.length - 1) {
        throwIfAborted(options.signal);
        await options.beforeInput?.();
        await this.run(chunk, options.signal);
        chunk = [];
        chunkMs = 0;
      }
    }
    const totalPause = pauses.reduce((a, b) => a + b, 0);
    return {
      typed: input.text,
      chars: chars.length,
      duration_s: Math.round((Date.now() - started) / 100) / 10,
      avg_interval_ms: round1(totalPause / Math.max(1, chars.length - 1)),
      ...hidden,
    };
  }

  // ------------------------------------------------------------------ UI

  async findApp(target: string | number): Promise<AppInfo> {
    const { app } = await this.backend.request<{ app: AppInfo | null }>("ui.find_app", { target });
    if (!app) {
      throw new ComputerUseError(
        `App not found: ${target}. It may not be running — check with computer_screen capture, or click its icon from computer_ui dock.`,
        "not_found",
      );
    }
    if (app.pid === process.pid) {
      throw new ComputerUseError(
        "That is JellyBot's own window. Reading our own accessibility tree in-process traps the app — use computer_screen to look at our UI, and target the other app you want to drive.",
        "self_target",
      );
    }
    return app;
  }

  async uiWindows(app: string | number): Promise<Outcome> {
    const info = await this.findApp(app);
    const [{ windows }, system] = await Promise.all([
      this.backend.request<{ windows: WindowSummary[] }>("ui.windows", { pid: info.pid }),
      this.backend.request<{ frontmost_pid?: number }>("system.info", {}, { timeoutMs: 15_000 }),
    ]);
    return { app: info, windows, count: windows.length, frontmost: system.frontmost_pid === info.pid };
  }

  async preparePasswordFill(app: string | number, signal?: AbortSignal, region?: Rect | null, signInFailed = false) {
    if (signal?.aborted) return null;
    try {
      const info = await this.findApp(app);
      const target = await this.backend.request<{
        token?: string;
        frame?: Rect;
        destination?: HandoffPasswordDestination;
        login?: import("../types.js").DesktopPasswordTarget["login"];
        password_present?: boolean;
      }>("ui.prepare_password", {
        pid: info.pid,
        ...(region ? { x: region.x + region.width / 2, y: region.y + region.height / 2 } : {}),
        ...(signInFailed ? { sign_in_failed: true } : {}),
      }, { timeoutMs: 5_000, ...(signal ? { signal } : {}) });
      if (target.password_present === true) return { status: "already_filled" } as const;
      if (!target.token || !target.destination?.app) return null;
      const { token, destination, frame } = target;
      return {
        status: "ready" as const,
        destination,
        frame,
        ...(target.login ? { login: target.login } : {}),
        fill: async (password: string, fillSignal?: AbortSignal, login?: { account: string; requireAccountField?: boolean }): Promise<boolean> => {
          try {
            const result = await this.backend.request<{ filled: boolean }>(
              "ui.fill_password", {
                token,
                password,
                ...(login ? { account: login.account, require_account_field: login.requireAccountField === true } : {}),
              }, { timeoutMs: 5_000, ...(fillSignal ? { signal: fillSignal } : {}) },
            );
            return result.filled === true;
          } catch {
            return false;
          }
        },
        discard: (): void => {
          void this.backend.request("ui.discard_password", { token }, { timeoutMs: 5_000 }).catch(() => {});
        },
      };
    } catch {
      return null;
    }
  }

  async uiFind(input: {
    app: string | number;
    role?: Opt<string>;
    name?: Opt<string>;
    windowTitle?: Opt<string>;
    timeoutS: number;
  }): Promise<Outcome & { matches: UiElement[] }> {
    const info = await this.findApp(input.app);
    const role = normalizeRole(input.role, this.platform);
    const found = await this.backend.request<{ matches: UiElement[]; visited: number; truncated: boolean }>(
      "ui.find",
      {
        pid: info.pid,
        ...(role ? { role } : {}),
        ...(input.name ? { name: input.name } : {}),
        ...(input.windowTitle ? { window_title: input.windowTitle } : {}),
        timeout: input.timeoutS,
      },
      { timeoutMs: input.timeoutS * 1000 + SEQUENCE_SLACK_MS },
    );
    const matches = found.matches;
    return {
      app: info,
      ...(role ? { role } : {}),
      matches: matches.slice(0, UI_MATCH_LIMIT),
      count: matches.length,
      ...(matches.length > UI_MATCH_LIMIT ? { shown: UI_MATCH_LIMIT } : {}),
      visited: found.visited,
      ...(found.truncated ? { truncated: true, hint: "Search stopped early (timeout or node budget); narrow it with role, name or window_title." } : {}),
    };
  }

  async uiClick(
    input: {
      app: string | number;
      role?: Opt<string>;
      name?: Opt<string>;
      windowTitle?: Opt<string>;
      index: number;
      button: MouseButton;
      clicks: number;
      timeoutS: number;
      borrowPointer?: boolean;
      dryRun?: boolean;
    },
    options: CallOptions = {},
  ): Promise<Outcome> {
    const found = await this.uiFind(input);
    const matches = found.matches;
    if (matches.length === 0) {
      throw new ComputerUseError(`No matching element (role=${input.role ?? "*"}, name=${input.name ?? "*"}) in ${String(input.app)}.`, "not_found");
    }
    if (input.index >= matches.length) {
      throw new ComputerUseError(`index=${input.index} is out of range (${matches.length} matches: ${matches.slice(0, 10).map((m) => m.name).join(", ")}).`, "invalid_arguments");
    }
    const target = matches[input.index]!;
    if (!target.center) throw new ComputerUseError("The matched element has no on-screen frame.", "not_found");
    if (input.dryRun) return dryRun({ target, button: input.button, clicks: input.clicks });
    const result = await this.mouseClick(
      {
        x: target.center.x,
        y: target.center.y,
        button: input.button,
        clicks: input.clicks,
        holdS: 0.05,
        ...(input.borrowPointer ? { borrowPointer: true } : {}),
      },
      options,
    );
    return { ...result, target };
  }

  async uiDock(name?: string): Promise<Outcome> {
    const { icons } = await this.backend.request<{ icons: UiElement[] }>("ui.dock", name ? { name } : {}, { timeoutMs: 20_000 });
    return { icons, count: icons.length };
  }

  async uiMenubar(menu: string | undefined, options: CallOptions = {}): Promise<Outcome> {
    const hidden = await this.avoid({ kind: "focus" }, options);
    const result = await this.backend.request<{ app_pid: number; items: unknown[] }>("ui.menubar", menu ? { menu } : {}, { timeoutMs: 20_000 });
    return { ...result, count: result.items.length, ...hidden };
  }

  async uiHitTest(point: Point, options: CallOptions = {}): Promise<Outcome> {
    const hidden = await this.avoid({ kind: "points", points: [point] }, options);
    const result = await this.backend.request<Record<string, unknown>>("ui.hit_test", { x: point.x, y: point.y });
    return { at: point, ...result, ...hidden };
  }

  // ------------------------------------------------------------------ screen

  async capture(input: { region?: Rect; path: string }, options: CallOptions = {}): Promise<CaptureResult & Outcome> {
    const hidden = await this.avoid({ kind: "area", rect: input.region ?? null }, options);
    const result = await this.backend.request<CaptureResult>(
      "screen.capture",
      { path: input.path, ...(input.region ? { region: [input.region.x, input.region.y, input.region.width, input.region.height] } : {}) },
      { timeoutMs: 30_000 },
    );
    return { ...result, ...hidden };
  }

  async captureHandoffQr(region: Rect, options: CallOptions): Promise<string | undefined> {
    if (region.width > 800 || region.height > 800 || options.signal?.aborted) return;
    const dir = await mkdtemp(join(tmpdir(), "larry-handoff-"));
    const path = join(dir, "code.png");
    try {
      // Wait for the capture writer before removing its temporary file, even if the turn stops.
      await this.capture({ path, region }, options.sessionId ? { sessionId: options.sessionId } : {});
      if (options.signal?.aborted || (await stat(path)).size > 256 * 1024) return;
      const png = await readFile(path);
      if (png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        return png.toString("base64");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private ocrLanguages(lang: "zh-Hans" | "en"): string[] {
    if (this.platform === "windows") return lang === "zh-Hans" ? ["zh-Hans-CN", "zh-Hans", "en-US"] : ["en-US", "en"];
    return lang === "zh-Hans" ? ["zh-Hans", "en-US"] : ["en-US"];
  }

  private async ocrImage(path: string, lang: "zh-Hans" | "en", signal?: AbortSignal): Promise<OcrLine[]> {
    const ocr = await this.backend.request<{ lines: OcrLine[] }>(
      "screen.ocr",
      { path, languages: this.ocrLanguages(lang) },
      { timeoutMs: OCR_TIMEOUT_MS, ...(signal ? { signal } : {}) },
    );
    return ocr.lines;
  }

  private async recognize(
    input: { region?: Rect; lang: "zh-Hans" | "en" },
    options: CallOptions,
  ): Promise<{ lines: OcrLine[]; capture: CaptureResult; hidden: Outcome }> {
    const dir = await ensureComputerUseCacheDir();
    const path = join(dir, `ocr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
    try {
      const { jellybot_hidden, jellybot_hidden_reason, note, ...capture } = await this.capture(
        { path, ...(input.region ? { region: input.region } : {}) },
        options,
      );
      throwIfAborted(options.signal);
      const lines = await this.ocrImage(path, input.lang, options.signal);
      const hidden = jellybot_hidden ? { jellybot_hidden, jellybot_hidden_reason, note } : {};
      return { lines, capture: capture as CaptureResult, hidden };
    } finally {
      await rm(path, { force: true });
    }
  }

  async ocrScreen(
    input: { region?: Rect; lang: "zh-Hans" | "en" },
    options: CallOptions = {},
  ): Promise<{ lines: ScreenLine[]; area: Rect; hidden: Outcome }> {
    const { lines, capture, hidden } = await this.recognize(input, options);
    return { lines: toScreenLines(lines, capture), area: capture.rect, hidden };
  }

  async ocrCapturedFile(capture: CaptureResult, lang: "zh-Hans" | "en", signal?: AbortSignal): Promise<ScreenLine[]> {
    return toScreenLines(await this.ocrImage(capture.path, lang, signal), capture);
  }

  async frontWindow(app?: string | number, signal?: AbortSignal): Promise<FrontWindow | null> {
    try {
      const pid = app !== undefined
        ? (await this.findApp(app)).pid
        : (await this.backend.request<{ frontmost_pid?: number }>("system.info", {}, { timeoutMs: 15_000 })).frontmost_pid;
      if (!pid || pid === process.pid) return null;
      const state = await this.batchDesktopState(pid, undefined, signal);
      const frame = state.window?.frame;
      return state.window && frame && frame.width > 0 && frame.height > 0
        ? { pid, title: state.window.title, frame }
        : null;
    } catch (error) {
      if (signal?.aborted) throw error;
      return null;
    }
  }

  async findText(
    input: {
      text: string;
      region?: Rect;
      index: number;
      lang: "zh-Hans" | "en";
      onMiss?: (lines: ScreenLine[], area: Rect) => Promise<Outcome | null>;
    },
    options: CallOptions = {},
  ): Promise<Outcome> {
    const { lines, capture, hidden } = await this.recognize(input, options);
    const matches = findTextInLines(lines, input.text).map((m) => {
      const box = imageBoxToScreen(m.box, capture);
      return { text: m.text, frame: box, center: { x: round1(box.x + box.width / 2), y: round1(box.y + box.height / 2) } };
    });
    if (matches.length === 0 && input.onMiss) {
      const rescued = await input.onMiss(toScreenLines(lines, capture), capture.rect);
      if (rescued) return { ...rescued, ...hidden };
    }
    if (matches.length === 0) {
      throw new ComputerUseError(
        `Text not found: ${JSON.stringify(input.text)}. Recognized: ${JSON.stringify(lines.slice(0, OCR_RECOGNIZED_PREVIEW).map((l) => l.text))}. Try a smaller region or capture to check.`,
        "not_found",
      );
    }
    if (input.index >= matches.length) {
      throw new ComputerUseError(`index=${input.index} is out of range (${matches.length} matches).`, "invalid_arguments");
    }
    const hit = matches[input.index]!;
    return {
      text: hit.text,
      center: hit.center,
      frame: hit.frame,
      match_index: input.index,
      total_matches: matches.length,
      all_matches: matches.map((m) => m.text),
      ...hidden,
    };
  }

  async readText(input: { region?: Rect; lang: "zh-Hans" | "en" }, options: CallOptions = {}): Promise<Outcome> {
    const { lines, area, hidden } = await this.ocrScreen(input, options);
    const shown = lines.map((line) => ({ text: line.text, center: line.center, frame: line.frame }));
    return { lines: shown, count: shown.length, area, ...hidden };
  }
}

function toScreenLines(lines: readonly OcrLine[], capture: { rect: Rect; width: number; height: number }): ScreenLine[] {
  return lines.map((line) => {
    const frame = imageBoxToScreen(line, capture);
    return { text: line.text, frame, center: { x: round1(frame.x + frame.width / 2), y: round1(frame.y + frame.height / 2) } };
  });
}
