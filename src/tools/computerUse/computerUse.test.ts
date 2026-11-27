import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import {
  computerKeyboardHandler,
  computerMouseHandler,
  computerScreenDefinition,
  computerScreenHandler,
  computerUseTools,
  setComputerUseServiceForTests,
} from "../builtin/computerUse.js";
import { TOOL_CATEGORIES, TOOL_CATEGORY_BY_NAME } from "../catalog.js";
import type { ToolExecuteContext } from "../types.js";
import { COMPUTER_USE_CACHE_DIR_NAME, configureComputerUseCache, computerUseCacheDir } from "./cache.js";
import { KeyResolutionError, parseMainKey, resolveModifiers } from "./keymap.js";
import { clampPoint, planMove, typingPauses, MOVE_MAX_FRAMES, PUNCTUATION_PAUSE_FACTOR } from "./motion.js";
import { findTextInLines, imageBoxToScreen } from "./ocrMatch.js";
import { normalizeRole } from "./roles.js";
import { ComputerUseService } from "./service.js";
import { configureComputerUseSoundPublisher, type ComputerUseSound } from "./sound.js";
import type { ComputerUsePlatform, Rect } from "./types.js";
import { WindowAvoidance, type ComputerUseWindowHost } from "./windowAvoidance.js";
import {
  ComputerUseError,
  computerUseNativeModulePath,
  createNativeComputerUseBackend,
  encodeRequestLine,
  type ComputerUseBackend,
} from "./worker.js";

type Call = { cmd: string; args: Record<string, unknown> };

function fakeBackend(platform: ComputerUsePlatform, overrides: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const backend: ComputerUseBackend = {
    platform,
    async request<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
      calls.push({ cmd, args });
      const canned: Record<string, unknown> = {
        screens: { screens: [{ id: 1, is_main: true, x: 0, y: 0, width: 1000, height: 800, scale: 1, pixels_wide: 1000, pixels_high: 800 }] },
        "mouse.position": { x: 10, y: 10 },
        "input.sequence": { x: 0, y: 0, held_buttons: [] },
        "key.char_vk": { vk: 0x53, shift_state: 0 },
        ...overrides,
      };
      return (canned[cmd] ?? {}) as T;
    },
  };
  const events = () => calls.filter((c) => c.cmd === "input.sequence").flatMap((c) => c.args.events as Array<Record<string, unknown>>);
  return { backend, calls, events };
}

function fakeHost(rects: Rect[], focused = false) {
  const log: string[] = [];
  let visible = true;
  const host: ComputerUseWindowHost = {
    visibleWindowRects: () => visible ? rects : [],
    isAppFocused: () => visible && focused,
    hideAll: () => {
      if (!visible || rects.length === 0) return 0;
      visible = false;
      log.push("hide");
      return rects.length;
    },
    restoreAll: ({ focus }) => {
      visible = true;
      log.push(focus ? "restore+focus" : "restore");
      return rects.length;
    },
  };
  return { host, log, showManually: () => { visible = true; } };
}

function windows(host: ComputerUseWindowHost | null): WindowAvoidance {
  const w = new WindowAvoidance({ settleMs: 0, idleRestoreMs: 60_000 });
  w.configure(host);
  return w;
}

it("emits click audio for delivered input and stays quiet on dry runs and rejected input", async () => {
  const sounds: ComputerUseSound[] = [];
  configureComputerUseSoundPublisher(sound => sounds.push(sound));
  try {
    for (const platform of ["macos", "windows"] as const) {
      const { backend } = fakeBackend(platform);
      const input = { button: "left", clicks: 2, holdS: 0.05 } as const;
      const service = new ComputerUseService(backend, windows(null));
      const count = sounds.length;
      await service.mouseClick({ ...input, dryRun: true });
      await assert.rejects(service.mouseClick(input, {
        beforeInput: async () => { throw new Error("Target changed"); },
      }), /Target changed/);
      assert.equal(sounds.length, count);
      await service.mouseClick(input);
      assert.deepEqual(sounds.slice(count), [{ kind: "click", count: 2 }]);
    }
  } finally {
    configureComputerUseSoundPublisher(null);
  }
});

const context = { workspacePath: "/tmp", fullPermissionsEnabled: true } as ToolExecuteContext;

describe("computer use self-target guard", () => {
  it("refuses to read JellyBot's own accessibility tree", async () => {
    const fake = fakeBackend("macos", {
      "ui.find_app": { app: { pid: process.pid, name: "Larry Agent", bundle_id: "com.jellybot.app" } },
    });
    const service = new ComputerUseService(fake.backend, windows(null));
    await assert.rejects(
      service.findApp("Larry Agent"),
      (error: unknown) =>
        error instanceof ComputerUseError &&
        error.code === "self_target" &&
        /our own accessibility tree/.test(error.message),
    );
    assert.equal(fake.calls.some((c) => c.cmd === "ui.find"), false);
  });

  it("still resolves other apps", async () => {
    const fake = fakeBackend("macos", {
      "ui.find_app": { app: { pid: 4242, name: "Finder", bundle_id: "com.apple.finder" } },
    });
    const app = await new ComputerUseService(fake.backend, windows(null)).findApp("Finder");
    assert.equal(app.pid, 4242);
  });
});

describe("computer use detached pointer", () => {
  function detached(
    platform: ComputerUsePlatform = "macos",
    seed: { x: number; y: number } | null = null,
    overrides: Record<string, unknown> = {},
  ) {
    const calls: string[] = [];
    let current: { x: number; y: number } | null = seed;
    const overlay = {
      available: true,
      theme: () => undefined,
      point: (x: number, y: number) => {
        current = { x, y };
        calls.push(`point:${x},${y}`);
      },
      click: (x: number, y: number) => {
        current = { x, y };
        calls.push(`click:${x},${y}`);
      },
      play: (points: readonly { x: number; y: number }[], _interval: number, options?: { click?: boolean }) => {
        const last = points.at(-1);
        if (last) current = { x: last.x, y: last.y };
        calls.push(`play:${points.length}:${options?.click ? "click" : "move"}`);
      },
      position: () => (current ? { ...current } : null),
      pause: () => undefined,
      resume: () => undefined,
      release: () => {
        current = null;
      },
      dispose: () => undefined,
    };
    return { overlay, calls, fake: fakeBackend(platform, overrides) };
  }

  it("moves only the drawn pointer and hovers the target process", async () => {
    const { overlay, fake } = detached("macos", { x: 100, y: 100 });
    const result = await new ComputerUseService(fake.backend, windows(null), overlay).mouseMove({ x: 300, y: 200 });
    assert.equal(result.pointer, "virtual");
    assert.equal(fake.calls.some((c) => c.cmd === "input.sequence"), false);
    const hover = fake.calls.find((c) => c.cmd === "input.hover");
    assert.ok(hover);
    const points = hover.args.points as Array<{ x: number; y: number }>;
    assert.deepEqual(points.at(-1), { x: 300, y: 200 });
    assert.ok(points.length > 1);
  });

  it("clicks straight into the target window and reports the delivery", async () => {
    const delivery = { mode: "background", pid: 4242, window: 7, app: "Calculator", activated: true };
    const { overlay, fake } = detached("macos", { x: 10, y: 10 }, { "input.click_at": { delivery } });
    const result = await new ComputerUseService(fake.backend, windows(null), overlay).mouseClick({
      x: 40,
      y: 50,
      button: "left",
      clicks: 2,
      holdS: 0.05,
    });
    assert.equal(fake.calls.some((c) => c.cmd === "input.sequence"), false);
    const click = fake.calls.find((c) => c.cmd === "input.click_at");
    assert.ok(click);
    assert.equal(click.args.x, 40);
    assert.equal(click.args.y, 50);
    assert.equal(click.args.clicks, 2);
    assert.equal(click.args.hold_ms, 50);
    assert.deepEqual(click.args.modifiers, []);
    assert.equal(click.args.delivery, "auto");
    assert.deepEqual(result.delivery, delivery);
    assert.equal("cursor_restored" in result, false);
  });

  it("lands the drawn pointer on the target before pressing", async () => {
    const { overlay, calls, fake } = detached("macos", { x: 10, y: 10 });
    const service = new ComputerUseService(fake.backend, windows(null), overlay);
    await service.mouseClick({ x: 40, y: 50, button: "left", clicks: 1, holdS: 0.05 });
    await service.mouseHold({ x: 60, y: 70, button: "left" });
    const order = fake.calls.map((c) => c.cmd).filter((cmd) => cmd.startsWith("input."));
    assert.deepEqual(order, ["input.hover", "input.click_at", "input.hover", "input.button_at"]);
    assert.equal(calls.some((c) => c.endsWith(":click") && c.startsWith("play:")), false);
    const firstClick = calls.indexOf("click:40,50");
    assert.ok(firstClick > 0 && calls[firstClick - 1]!.startsWith("play:"));
    assert.ok(calls.indexOf("click:60,70") > firstClick);
  });

  it("presses the drag only after the approach arrives", async () => {
    const { overlay, calls, fake } = detached("macos", { x: 10, y: 10 });
    await new ComputerUseService(fake.backend, windows(null), overlay).mouseDrag({
      from: { x: 100, y: 100 },
      to: { x: 400, y: 300 },
      button: "left",
    });
    const order = fake.calls.map((c) => c.cmd).filter((cmd) => cmd.startsWith("input."));
    assert.deepEqual(order, ["input.hover", "input.drag_path"]);
    assert.deepEqual(calls.map((c) => c.replace(/^play:\d+/, "play")), ["play:move", "click:100,100", "play:move"]);
  });

  it("borrows the physical cursor only when asked", async () => {
    const { overlay, fake } = detached("macos", { x: 10, y: 10 }, {
      "input.click_at": { delivery: { mode: "borrowed", cursor_restored: true } },
    });
    const service = new ComputerUseService(fake.backend, windows(null), overlay);
    const result = await service.mouseClick({ x: 40, y: 50, button: "left", clicks: 1, holdS: 0.05, borrowPointer: true });
    await service.mouseScroll({ dx: 0, dy: 2, unit: "line", borrowPointer: true });
    await service.mouseHold({ x: 60, y: 70, button: "left" });
    assert.equal(fake.calls.find((c) => c.cmd === "input.click_at")!.args.delivery, "borrow");
    assert.equal(fake.calls.find((c) => c.cmd === "input.scroll_at")!.args.delivery, "borrow");
    assert.equal(fake.calls.find((c) => c.cmd === "input.button_at")!.args.delivery, "auto");
    assert.deepEqual(result.delivery, { mode: "borrowed", cursor_restored: true });
  });

  it("drags along the planned trail inside one borrowed window", async () => {
    const { overlay, fake } = detached("macos", { x: 10, y: 10 });
    await new ComputerUseService(fake.backend, windows(null), overlay).mouseDrag({
      from: { x: 100, y: 100 },
      to: { x: 400, y: 300 },
      button: "left",
    });
    const drag = fake.calls.find((c) => c.cmd === "input.drag_path");
    assert.ok(drag);
    const points = drag.args.points as Array<{ x: number; y: number }>;
    assert.deepEqual(points[0], { x: 100, y: 100 });
    assert.deepEqual(points.at(-1), { x: 400, y: 300 });
    assert.ok(points.length > 2);
    assert.equal(drag.args.delivery, "auto");
    assert.equal(fake.calls.some((c) => c.cmd === "input.sequence"), false);
  });

  it("scrolls at the drawn pointer position", async () => {
    const { overlay, fake } = detached("macos", { x: 640, y: 480 });
    const result = await new ComputerUseService(fake.backend, windows(null), overlay).mouseScroll({ dx: 0, dy: -3, unit: "line" });
    assert.deepEqual(result.at, { x: 640, y: 480 });
    const scroll = fake.calls.find((c) => c.cmd === "input.scroll_at");
    assert.ok(scroll);
    assert.equal(scroll.args.x, 640);
    assert.equal(scroll.args.dy, -3);
  });

  it("reports the drawn pointer as the position", async () => {
    const { overlay, fake } = detached("macos", { x: 222, y: 333 });
    const position = await new ComputerUseService(fake.backend, windows(null), overlay).position();
    assert.deepEqual(position, { x: 222, y: 333 });
    assert.equal(fake.calls.some((c) => c.cmd === "mouse.position"), false);
  });

  it("keeps its own pointer on macOS even without the drawn overlay", async () => {
    const overlay = {
      available: false,
      theme: () => undefined,
      point: () => undefined,
      click: () => undefined,
      play: () => undefined,
      position: () => null,
      pause: () => undefined,
      resume: () => undefined,
      release: () => undefined,
      dispose: () => undefined,
    };
    const fake = fakeBackend("macos");
    const service = new ComputerUseService(fake.backend, windows(null), overlay);
    const moved = await service.mouseMove({ x: 300, y: 200 });
    assert.equal(moved.pointer, "virtual");
    assert.ok(fake.calls.some((c) => c.cmd === "input.hover"));
    assert.equal(fake.calls.some((c) => c.cmd === "input.sequence"), false);
    const reads = fake.calls.filter((c) => c.cmd === "mouse.position").length;
    assert.deepEqual(await new ComputerUseService(fake.backend, windows(null), overlay).position(), { x: 300, y: 200 });
    await service.mouseClick({ x: 120, y: 80, button: "left", clicks: 1, holdS: 0.05 });
    assert.deepEqual(await service.position(), { x: 120, y: 80 });
    assert.equal(fake.calls.filter((c) => c.cmd === "mouse.position").length, reads);
  });

  it("drives its own pointer on Windows too", async () => {
    const delivery = { mode: "background", pid: 77, window: 9, app: "notepad.exe", activated: true };
    const { overlay, fake } = detached("windows", { x: 100, y: 100 }, { "input.click_at": { delivery } });
    const service = new ComputerUseService(fake.backend, windows(null), overlay);
    const result = await service.mouseMove({ x: 300, y: 200 });
    assert.equal(result.pointer, "virtual");
    assert.ok(fake.calls.some((c) => c.cmd === "input.hover"));
    const clicked = await service.mouseClick({ x: 320, y: 210, button: "left", clicks: 1, holdS: 0.05 });
    assert.deepEqual(clicked.delivery, delivery);
    await service.mouseDrag({ from: { x: 10, y: 10 }, to: { x: 60, y: 60 }, button: "left" });
    await service.mouseScroll({ dx: 0, dy: -1, unit: "line" });
    await service.mouseHold({ button: "left" });
    await service.mouseRelease({ button: "left" });
    const order = fake.calls.map((c) => c.cmd).filter((cmd) => cmd.startsWith("input.") && cmd !== "input.hover");
    assert.deepEqual(order, ["input.click_at", "input.drag_path", "input.scroll_at", "input.button_at", "input.button_at"]);
    assert.equal(fake.calls.some((c) => c.cmd === "input.sequence"), false);
    assert.equal(fake.calls.some((c) => c.cmd === "mouse.position"), false);
  });
});

describe("computer use motion", () => {
  it("glides with eased frames and lands exactly on the target", () => {
    const plan = planMove({ x: 0, y: 0 }, { x: 101.3, y: 50 }, {});
    assert.equal(plan.durationS, 0.4);
    assert.equal(plan.frames, 24);
    assert.deepEqual(plan.points.at(-1), { x: 101.3, y: 50 });
    assert.ok(plan.points[0]!.x < plan.points[12]!.x - plan.points[11]!.x, "ease-in starts slow");
  });

  it("speeds up long moves and caps frames", () => {
    const plan = planMove({ x: 0, y: 0 }, { x: 4800, y: 0 }, {});
    assert.equal(plan.durationS, 2);
    assert.equal(plan.frames, Math.min(120, MOVE_MAX_FRAMES));
  });

  it("skips frames when already at the target", () => {
    assert.deepEqual(planMove({ x: 5, y: 5 }, { x: 5.2, y: 5 }, {}).points, []);
  });

  it("pauses longer after punctuation and never below the floor", () => {
    const pauses = typingPauses(["a", "。", "b", "c"], 80, 0, () => 0.5);
    assert.deepEqual(pauses, [80, 80 * PUNCTUATION_PAUSE_FACTOR, 80]);
    assert.deepEqual(typingPauses(["a", "b"], 0, 0), [15]);
  });

  it("clamps off-screen targets to the nearest display", () => {
    const screens = [{ x: 0, y: 0, width: 100, height: 100 }, { x: -50, y: 0, width: 50, height: 100 }];
    assert.deepEqual(clampPoint({ x: -20, y: 30 }, screens), { x: -20, y: 30 });
    assert.deepEqual(clampPoint({ x: 500, y: 30 }, screens), { x: 99, y: 30 });
  });
});

describe("computer use keymap and roles", () => {
  it("maps cmd to Ctrl on Windows and dedupes", () => {
    assert.deepEqual(resolveModifiers(["cmd", "ctrl", "shift"], "windows").map((m) => m.name), ["ctrl", "shift"]);
    assert.deepEqual(resolveModifiers(["alt"], "macos").map((m) => m.name), ["option"]);
    assert.throws(() => resolveModifiers(["hyper"], "macos"), KeyResolutionError);
    assert.throws(() => resolveModifiers(["fn"], "windows"), KeyResolutionError);
  });

  it("accepts special keys and single characters of any script", () => {
    assert.deepEqual(parseMainKey("Return", "macos"), { kind: "special", key: { code: 36, extended: false } });
    assert.deepEqual(parseMainKey("up", "windows"), { kind: "special", key: { code: 0x26, extended: true } });
    assert.deepEqual(parseMainKey("你", "windows"), { kind: "char", char: "你" });
    assert.deepEqual(parseMainKey("😀", "macos"), { kind: "char", char: "😀" });
    assert.throws(() => parseMainKey("hello", "macos"), KeyResolutionError);
  });

  it("translates roles between AX and UI Automation", () => {
    assert.equal(normalizeRole("AXButton", "windows"), "ButtonControl");
    assert.equal(normalizeRole("Edit", "windows"), "EditControl");
    assert.equal(normalizeRole("ButtonControl", "macos"), "AXButton");
    assert.equal(normalizeRole("AXMenuItem", "macos"), "AXMenuItem");
    assert.equal(normalizeRole("  ", "macos"), undefined);
  });
});

describe("computer use OCR matching", () => {
  it("matches across per-character CJK words and unions their boxes", () => {
    const line = {
      text: "打 开 文 件", x: 0, y: 0, width: 80, height: 20,
      words: ["打", "开", "文", "件"].map((t, i) => ({ text: t, x: i * 20, y: 0, width: 18, height: 20 })),
    };
    const [hit] = findTextInLines([line], "文件");
    assert.deepEqual(hit!.box, { x: 40, y: 0, width: 38, height: 20 });
  });

  it("estimates the substring slice when there are no word boxes", () => {
    const [hit] = findTextInLines([{ text: "File Edit View", x: 0, y: 0, width: 140, height: 10 }], "edit");
    assert.equal(Math.round(hit!.box.x), 50);
    assert.equal(findTextInLines([{ text: "abc", x: 0, y: 0, width: 1, height: 1 }], "zzz").length, 0);
  });

  it("maps Retina image pixels back to screen points", () => {
    const box = imageBoxToScreen({ x: 200, y: 100, width: 40, height: 20 }, { rect: { x: 10, y: 20, width: 500, height: 400 }, width: 1000, height: 800 });
    assert.deepEqual(box, { x: 110, y: 70, width: 20, height: 10 });
  });
});

describe("computer use window avoidance", () => {
  it("hides only when JellyBot covers the target, then restores at the owning session's turn end", async () => {
    const { host, log } = fakeHost([{ x: 0, y: 0, width: 100, height: 100 }]);
    const w = windows(host);
    assert.deepEqual(await w.avoid({ kind: "points", points: [{ x: 500, y: 500 }] }, "s1"), { hidden: false });
    assert.equal((await w.avoid({ kind: "points", points: [{ x: 50, y: 50 }] }, "s1")).hidden, true);
    assert.equal((await w.avoid({ kind: "area", rect: null }, "s1")).hidden, false, "already hidden");
    assert.equal(w.restoreForSession("other"), 0);
    assert.equal(w.restoreForSession("s1"), 1);
    assert.deepEqual(log, ["hide", "restore+focus"]);
  });

  it("hides for keystrokes only while JellyBot has focus, and is inert without a host", async () => {
    assert.equal((await windows(fakeHost([], true).host).avoid({ kind: "focus" })).hidden, false, "nothing visible to hide");
    assert.equal((await windows(fakeHost([{ x: 0, y: 0, width: 1, height: 1 }], true).host).avoid({ kind: "focus" })).hidden, true);
    assert.equal((await windows(fakeHost([{ x: 0, y: 0, width: 1, height: 1 }], false).host).avoid({ kind: "focus" })).hidden, false);
    assert.equal((await windows(null).avoid({ kind: "area", rect: null })).hidden, false);
  });

  it("keeps the target uncovered during a handoff and can continue after the user reopens Larry Agent", async () => {
    const { host, log, showManually } = fakeHost([{ x: 0, y: 0, width: 100, height: 100 }]);
    const w = new WindowAvoidance({ settleMs: 0, idleRestoreMs: 15 });
    w.configure(host);
    const point = { x: 50, y: 50 };
    const target = { kind: "points", points: [point] } as const;
    await w.avoid(target, "s1");
    await w.keepDesktop(async () => {
      await new Promise(resolve => setTimeout(resolve, 40));
      assert.deepEqual(log, ["hide"]);
      showManually();
      assert.equal(w.covers(point), true);
    });
    assert.equal((await w.avoid(target, "s1")).hidden, true);
    assert.equal(w.restoreForSession("s1"), 1);
    assert.deepEqual(log, ["hide", "hide", "restore+focus"]);
  });

  it("returns focus once at turn end even if the window was restored passively", async () => {
    const { host, log } = fakeHost([{ x: 0, y: 0, width: 100, height: 100 }]);
    host.focusMainWindow = () => { log.push("focus main"); };
    const w = windows(host);
    await w.hide("s1");
    assert.equal(w.restore({ focus: false }), 1);
    assert.equal(w.restoreForSession("other"), 0);
    assert.deepEqual(log, ["hide", "restore"]);
    assert.equal(w.restoreForSession("s1"), 0);
    assert.equal(w.restoreForSession("s1"), 0);
    await w.keepDesktop(async () => {}, "background");
    assert.equal(w.restoreForSession("background", { focus: false }), 0);
    assert.deepEqual(log, ["hide", "restore", "focus main"]);
  });
});

describe("computer use service", () => {
  it("passes resolved modifiers to the click delivery on both platforms", async () => {
    const win = fakeBackend("windows");
    await new ComputerUseService(win.backend, windows(null)).mouseClick({ x: 50, y: 60, button: "left", clicks: 2, modifiers: ["cmd"], holdS: 0.05 });
    assert.equal(win.events().length, 0);
    const winClick = win.calls.find((c) => c.cmd === "input.click_at")!;
    assert.deepEqual(winClick.args.modifiers, ["ctrl"]);
    assert.equal(winClick.args.clicks, 2);

    const mac = fakeBackend("macos");
    await new ComputerUseService(mac.backend, windows(null)).mouseClick({ button: "right", clicks: 1, modifiers: ["cmd"], holdS: 0.05 });
    assert.equal(mac.events().length, 0);
    const macClick = mac.calls.find((c) => c.cmd === "input.click_at")!;
    assert.equal(macClick.args.button, "right");
    assert.deepEqual(macClick.args.modifiers, ["cmd"]);
  });

  it("prepares and fills a verified password field on Windows", async () => {
    const fake = fakeBackend("windows", {
      "ui.find_app": { app: { pid: 9, name: "Chrome", bundle_id: "" } },
      "ui.prepare_password": {
        token: "win-token",
        destination: { app: "Google Chrome", origin: "https://example.test" },
        frame: { x: 1, y: 2, width: 3, height: 4 },
        login: { origin: "https://example.test", account: "ada" },
      },
      "ui.fill_password": { filled: true },
    });
    const prepared = await new ComputerUseService(fake.backend, windows(null)).preparePasswordFill("Chrome");
    assert.equal(prepared && prepared.status, "ready");
    if (!prepared || prepared.status !== "ready") return;
    assert.equal(prepared.destination.app, "Google Chrome");
    assert.deepEqual(prepared.login, { origin: "https://example.test", account: "ada" });
    assert.equal(await prepared.fill("synthetic-secret", undefined, { account: "ada", requireAccountField: true }), true);
    assert.deepEqual(fake.calls.find((call) => call.cmd === "ui.prepare_password")?.args, { pid: 9 });
    assert.deepEqual(fake.calls.find((call) => call.cmd === "ui.fill_password")?.args, {
      token: "win-token",
      password: "synthetic-secret",
      account: "ada",
      require_account_field: true,
    });
  });

  it("reports a populated Windows password without asking for another one", async () => {
    const fake = fakeBackend("windows", {
      "ui.find_app": { app: { pid: 9, name: "Chrome", bundle_id: "" } },
      "ui.prepare_password": { password_present: true },
    });
    const prepared = await new ComputerUseService(fake.backend, windows(null)).preparePasswordFill(9, undefined, undefined, false);
    assert.equal(prepared && prepared.status, "already_filled");
    assert.equal(fake.calls.some((call) => call.cmd === "ui.fill_password"), false);
  });

  it("sends shortcuts as virtual keys, not Unicode", async () => {
    const win = fakeBackend("windows");
    await new ComputerUseService(win.backend, windows(null)).keyCombo({ keys: ["cmd", "s"] });
    assert.ok(win.calls.some((c) => c.cmd === "key.char_vk"));
    assert.deepEqual(win.events().filter((e) => e.t === "vk").map((e) => e.code), [0x11, 0x53, 0x53, 0x11]);

    const mac = fakeBackend("macos");
    await new ComputerUseService(mac.backend, windows(null)).keyCombo({ keys: ["cmd", "shift", "4"] });
    const main = mac.events().filter((e) => e.t === "vk" && e.code === 21);
    assert.deepEqual(main[0]!.modifiers, ["cmd", "shift"]);
    await assert.rejects(new ComputerUseService(mac.backend, windows(null)).keyCombo({ keys: ["a", "b"] }), KeyResolutionError);
  });

  it("types Unicode text, turns newlines into Return and hides a focused JellyBot first", async () => {
    const { host, log } = fakeHost([{ x: 0, y: 0, width: 10, height: 10 }], true);
    const fake = fakeBackend("windows");
    const result = await new ComputerUseService(fake.backend, windows(host)).typeText({ text: "你\nb", intervalMs: 0, jitterMs: 0 });
    const typed = fake.events().filter((e) => e.t !== "sleep" && e.down === true);
    assert.deepEqual(typed.map((e) => e.t === "char" ? e.text : `vk${e.code}`), ["你", "vk13", "b"]);
    assert.equal(result.jellybot_hidden, true);
    assert.deepEqual(log, ["hide"]);
  });

  it("finds OCR text in screen coordinates and cleans up", async () => {
    const root = await mkdtemp(join(tmpdir(), "jellybot-ocr-test-"));
    configureComputerUseCache(root);
    try {
      const fake = fakeBackend("macos", {
        "screen.capture": { path: "x.png", width: 200, height: 100, rect: { x: 100, y: 0, width: 100, height: 50 } },
        "screen.ocr": { lines: [{ text: "Save", x: 20, y: 20, width: 40, height: 20 }] },
      });
      const result = await new ComputerUseService(fake.backend, windows(null)).findText({ text: "save", index: 0, lang: "en" });
      assert.deepEqual(result.center, { x: 120, y: 15 });
      assert.deepEqual(fake.calls.find((c) => c.cmd === "screen.ocr")!.args.languages, ["en-US"]);
      const captured = fake.calls.find((c) => c.cmd === "screen.capture")!.args.path as string;
      assert.equal(dirname(captured), computerUseCacheDir());
      assert.match(basename(captured), /^ocr-.*\.png$/);
    } finally {
      configureComputerUseCache(null);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("mirrors planned pointer motion into the cursor overlay", async () => {
    const calls: string[] = [];
    const overlay = {
      available: true,
      theme: () => undefined,
      point: (x: number, y: number) => calls.push(`point:${x},${y}`),
      click: (x: number, y: number) => calls.push(`click:${x},${y}`),
      play: (points: readonly { x: number; y: number }[], _interval: number, options?: { click?: boolean }) =>
        calls.push(`play:${points.length}:${options?.click ? "click" : "move"}`),
      pause: () => undefined,
      resume: () => undefined,
      release: () => undefined,
      dispose: () => undefined,
    };

    const moving = fakeBackend("macos");
    await new ComputerUseService(moving.backend, windows(null), overlay).mouseClick({
      x: 40,
      y: 50,
      button: "left",
      clicks: 1,
      holdS: 0.05,
    });
    assert.equal(calls.length, 2);
    assert.ok(calls[0]!.startsWith("play:") && calls[0]!.endsWith(":move"));
    assert.equal(calls[1], "click:40,50");

    calls.length = 0;
    const still = fakeBackend("macos");
    await new ComputerUseService(still.backend, windows(null), overlay).mouseClick({ button: "left", clicks: 1, holdS: 0.05 });
    assert.equal(calls.length, 1);
    assert.ok(calls[0]!.startsWith("click:"));
  });
});

describe("computer use tools", () => {
  it("stores default screenshots in the app cache directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "jellybot-capture-test-"));
    configureComputerUseCache(root);
    const backend: ComputerUseBackend = {
      platform: "macos",
      async request<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
        if (cmd !== "screen.capture") return {} as T;
        const path = String(args.path);
        writeFileSync(path, Buffer.from("png-bytes"));
        return { path, width: 4, height: 4, rect: { x: 0, y: 0, width: 4, height: 4 } } as T;
      },
    };
    setComputerUseServiceForTests(new ComputerUseService(backend, windows(null)));
    try {
      const result = await computerScreenHandler({ action: "capture" }, context);
      assert.equal(result.returnCode, 0);
      const text = (result.content[0] as { text?: string }).text ?? "";
      const written = JSON.parse(text).path as string;
      assert.equal(computerUseCacheDir(), join(root, COMPUTER_USE_CACHE_DIR_NAME));
      assert.equal(resolve(dirname(written)), computerUseCacheDir());
    } finally {
      setComputerUseServiceForTests(null);
      configureComputerUseCache(null);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("validates arguments before touching the desktop", async () => {
    const fake = fakeBackend("windows");
    setComputerUseServiceForTests(new ComputerUseService(fake.backend, windows(null)));
    try {
      assert.equal((await computerMouseHandler({ action: "move", x: 1 }, context)).returnCode, 5);
      assert.equal((await computerMouseHandler({ action: "click", x: 1 }, context)).returnCode, 5);
      assert.equal((await computerKeyboardHandler({ action: "press", key: "abc" }, context)).returnCode, 5);
      const dry = await computerMouseHandler({ action: "click", x: 3, y: 4, dry_run: true }, context);
      assert.equal(dry.returnCode, 0);
      assert.equal(fake.calls.some((c) => c.cmd === "input.sequence"), false);
    } finally {
      setComputerUseServiceForTests(null);
    }
  });

  it("escapes non-ASCII request payloads", () => {
    assert.equal(encodeRequestLine({ text: "你" }), '{"text":"\\u4f60"}\n');
  });

  it("is wired into the registration points", () => {
    const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
    assert.ok(TOOL_CATEGORIES.some((c) => c.id === "computer-use"));
    assert.deepEqual(computerScreenDefinition.parameters.required, ["action"]);
    for (const { definition } of computerUseTools) {
      const name = definition.name;
      assert.equal(TOOL_CATEGORY_BY_NAME[name as keyof typeof TOOL_CATEGORY_BY_NAME], "computer-use");
      assert.match(read("../types.ts"), new RegExp(`\\| "${name}"`));
      assert.match(read("../displayMeta.ts"), new RegExp(`${name}: \\{`));
      assert.match(read("../executionSummaries.ts"), new RegExp(`${name}: (\\(|summarize)`));
      assert.match(read("../uiDescriptions.ts"), new RegExp(`${name}:`));
      assert.match(read("../../shared/icons/toolIconCatalog.ts"), new RegExp(`"${name}": \\{`));
    }
    assert.match(read("../index.ts"), /computerUseTools\) registerBuiltin\(definition, handler\)/);
    assert.match(read("../../main/index.ts"), /configureComputerUseWindows\(createComputerUseWindowHost\(/);
    assert.match(read("../../main/sessionRuntime.ts"), /computerUseWindows\(\)\.restoreForSession\(sessionId,/);
  });
});

describe("macOS in-process computer use backend", () => {
  it("resolves the native module from an override", () => {
    const key = "JELLYBOT_COMPUTER_USE_NATIVE_MODULE";
    const previous = process.env[key];
    process.env[key] = "/tmp/jellybot-test.node";
    try {
      assert.equal(computerUseNativeModulePath(), resolve("/tmp/jellybot-test.node"));
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });

  it("sends the command envelope and resolves the native result", async () => {
    const sent: string[] = [];
    const result = { ok: true, permissions: { accessibility: true, screen_capture: true } };
    const backend = createNativeComputerUseBackend({
      dispatch: async (request) => {
        sent.push(request);
        return JSON.stringify({ id: 1, ok: true, result });
      },
    });
    assert.deepEqual(await backend.request("system.info"), result);
    assert.deepEqual(JSON.parse(sent[0]!), { id: 1, cmd: "system.info", args: {} });
  });

  it("maps native errors to ComputerUseError codes", async () => {
    const denied = createNativeComputerUseBackend({
      dispatch: async () => JSON.stringify({ ok: false, code: "permission_required", error: "Accessibility is off" }),
    });
    await assert.rejects(
      denied.request("input.sequence", { events: [] }),
      (error: unknown) => error instanceof ComputerUseError && error.code === "permission_required",
    );
    const broken = createNativeComputerUseBackend({ dispatch: async () => "not json" });
    await assert.rejects(
      broken.request("screens"),
      (error: unknown) => error instanceof ComputerUseError && error.code === "helper_failed",
    );
  });

  it("keeps the Windows worker dispatch path separate", () => {
    const source = readFileSync(new URL("./worker.ts", import.meta.url), "utf8");
    assert.match(source, /if \(platform === "macos"\) return macosBackendForApp\(\);/);
    assert.match(source, /new ComputerUseWorker\(platform\)/);
  });
});
