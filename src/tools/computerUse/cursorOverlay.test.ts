import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_CURSOR_THEME,
  configureCursorOverlay,
  configureOverlayChannel,
  createCursorOverlay,
  cursorOverlay,
  cursorOverlayHelperPath,
  disposeCursorOverlay,
  disposeTipsOverlay,
  encodeCursorCommand,
  overlaySchedule,
  scheduleEndsAt,
  setCursorOverlayEnabled,
  setCursorOverlayTheme,
  tipsOverlay,
  type CursorOverlay,
  type OverlayChannelFactory,
  type OverlayChannelHandlers,
  type TipEvent,
} from "./cursorOverlay.js";

describe("cursor overlay protocol", () => {
  it("encodes one command per line so the helper can stream-parse it", () => {
    const line = encodeCursorCommand("move", { x: 12.5, y: 30 });
    assert.equal(line.endsWith("\n"), true);
    assert.equal(line.indexOf("\n"), line.length - 1);
    assert.deepEqual(JSON.parse(line), { cmd: "move", args: { x: 12.5, y: 30 } });
    assert.deepEqual(JSON.parse(encodeCursorCommand("end")), { cmd: "end" });
  });

  it("streams planned points on their own timing", () => {
    const schedule = overlaySchedule([{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 6 }], 12);
    assert.deepEqual(schedule.map((item) => item.at), [0, 12, 24]);
    assert.deepEqual(schedule.map((item) => item.cmd), ["move", "move", "move"]);
    assert.deepEqual(schedule[2]!.args, { x: 5, y: 6 });
  });

  it("fires the ripple after the pointer arrives", () => {
    const schedule = overlaySchedule([{ x: 1, y: 2 }, { x: 3, y: 4 }], 10, { click: true });
    assert.equal(schedule.length, 3);
    assert.equal(schedule[2]!.cmd, "click");
    assert.equal(schedule[2]!.at, 20);
    assert.deepEqual(schedule[2]!.args, { x: 3, y: 4 });
    assert.deepEqual(overlaySchedule([], 10, { click: true }), []);
  });

  it("offsets the whole schedule by the start delay", () => {
    const schedule = overlaySchedule([{ x: 1, y: 2 }, { x: 3, y: 4 }], 10, { click: true, delayMs: 50 });
    assert.deepEqual(schedule.map((item) => item.at), [50, 60, 70]);
  });

  it("releases only after the last planned point lands", () => {
    const schedule = overlaySchedule([{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 6 }], 16, { click: true });
    assert.equal(scheduleEndsAt(schedule), 48);
    assert.equal(scheduleEndsAt([]), 0);
  });

  it("resolves the packaged helper before the dev build", () => {
    const resolved = cursorOverlayHelperPath("darwin", "/workspace");
    assert.ok(resolved.endsWith("macos-virtual-cursor"));
    assert.equal(cursorOverlayHelperPath("win32", "/workspace").includes("helpers"), true);
  });
});

describe("cursor overlay fallback", () => {
  it("becomes a no-op outside macOS", () => {
    const overlay = createCursorOverlay("win32");
    assert.equal(overlay.available, false);
    overlay.point(1, 2);
    overlay.click(3, 4);
    overlay.play([{ x: 5, y: 6 }], 10, { click: true });
    overlay.theme(DEFAULT_CURSOR_THEME);
    overlay.release();
    overlay.dispose();
  });

  it("can be swapped and restored for tests", () => {
    const calls: string[] = [];
    configureCursorOverlay({
      available: true,
      theme: () => calls.push("theme"),
      point: (x, y) => calls.push(`point:${x},${y}`),
      click: (x, y) => calls.push(`click:${x},${y}`),
      play: (points) => calls.push(`play:${points.length}`),
      pause: () => undefined,
      resume: () => undefined,
      release: () => calls.push("release"),
      dispose: () => calls.push("dispose"),
    });
    cursorOverlay().theme(DEFAULT_CURSOR_THEME);
    cursorOverlay().point(7, 8);
    assert.deepEqual(calls, ["theme", "point:7,8"]);
    configureCursorOverlay(null);
    assert.equal(cursorOverlay().available, false);
  });
});

describe("cursor overlay toggle", () => {
  it("turns the helper off, disposes it, and turns it back on", () => {
    const calls: string[] = [];
    const factory = (): CursorOverlay => ({
      available: true,
      theme: (theme) => calls.push(`theme:${theme.accent}`),
      point: () => calls.push("point"),
      click: () => calls.push("click"),
      play: () => calls.push("play"),
      pause: () => undefined,
      resume: () => undefined,
      release: () => calls.push("release"),
      dispose: () => calls.push("dispose"),
    });

    disposeCursorOverlay();
    setCursorOverlayTheme({ dark: true, accent: "#abcdef", onAccent: "#111111" });
    setCursorOverlayEnabled(true, "darwin", factory);
    assert.deepEqual(calls, ["theme:#abcdef"]);
    assert.equal(cursorOverlay().available, true);

    setCursorOverlayEnabled(true, "darwin", factory);
    assert.deepEqual(calls, ["theme:#abcdef"]);

    setCursorOverlayEnabled(false);
    assert.deepEqual(calls, ["theme:#abcdef", "dispose"]);
    assert.equal(cursorOverlay().available, false);
    assert.equal(cursorOverlay().available === false, true);

    setCursorOverlayEnabled(true, "darwin", factory);
    assert.deepEqual(calls, ["theme:#abcdef", "dispose", "theme:#abcdef"]);
    disposeCursorOverlay();
  });

  it("replays the last reported theme onto a freshly enabled helper", () => {
    const seen: string[] = [];
    disposeCursorOverlay();
    setCursorOverlayTheme(DEFAULT_CURSOR_THEME);
    setCursorOverlayEnabled(true, "darwin", () => ({
      available: true,
      theme: (theme) => seen.push(theme.accent),
      point: () => undefined,
      click: () => undefined,
      play: () => undefined,
      pause: () => undefined,
      resume: () => undefined,
      release: () => undefined,
      dispose: () => undefined,
    }));
    setCursorOverlayTheme({ dark: false, accent: "#006bd6", onAccent: "#ffffff" });
    assert.deepEqual(seen, [DEFAULT_CURSOR_THEME.accent, "#006bd6"]);
    disposeCursorOverlay();
  });

  it("releases without spawning anything when the helper never started", () => {
    const spawned: string[] = [];
    const overlay = createCursorOverlay("win32");
    overlay.release();
    assert.deepEqual(spawned, []);
    assert.equal(overlay.available, false);
  });
});

describe("cursor overlay channels", () => {
  function recordingChannel() {
    const sent: string[] = [];
    let handlers: OverlayChannelHandlers | null = null;
    let opened = 0;
    let closed = 0;
    const factory: OverlayChannelFactory = (next) => {
      opened += 1;
      handlers = next;
      return {
        send: (cmd, args) => sent.push(args ? `${cmd}:${JSON.stringify(args)}` : cmd),
        close: () => {
          closed += 1;
        },
      };
    };
    return {
      factory,
      sent,
      emit: (event: TipEvent) => handlers?.onEvent(event),
      exit: (fatal: boolean) => handlers?.onExit(fatal),
      counts: () => ({ opened, closed }),
    };
  }

  it("drives the registered Windows channel lazily, theme first", () => {
    const channel = recordingChannel();
    configureOverlayChannel(channel.factory);
    try {
      const overlay = createCursorOverlay("win32");
      assert.equal(overlay.available, true);
      assert.deepEqual(channel.counts(), { opened: 0, closed: 0 });
      overlay.point(10, 20);
      assert.deepEqual(channel.counts(), { opened: 1, closed: 0 });
      assert.ok(channel.sent[0]!.startsWith("theme:"));
      assert.equal(channel.sent[1], 'move:{"x":10,"y":20}');
      assert.deepEqual(overlay.position?.(), { x: 10, y: 20 });
      overlay.release();
      assert.equal(channel.sent.at(-1), "end");
      overlay.dispose();
      assert.deepEqual(channel.counts(), { opened: 1, closed: 1 });
    } finally {
      configureOverlayChannel(null);
    }
    assert.equal(createCursorOverlay("win32").available, false);
  });

  it("routes tip answers back and reports a lost channel to the waiting tip", () => {
    const channel = recordingChannel();
    configureOverlayChannel(channel.factory);
    try {
      const tips = tipsOverlay("win32");
      assert.equal(tips.available, true);
      const seen: TipEvent[] = [];
      const stop = tips.onTipEvent((event) => seen.push(event));
      tips.showTip({ id: "t1", kind: "action", title: "Sign in", primary: "Done" });
      assert.ok(channel.sent.some((line) => line.startsWith('tip.show:{"id":"t1"')));
      channel.emit({ event: "tip.answer", id: "t1", action: "primary" });
      tips.showTip({ id: "t2", kind: "action", title: "Again", primary: "Done" });
      channel.exit(false);
      assert.deepEqual(seen, [
        { event: "tip.answer", id: "t1", action: "primary" },
        { event: "tip.lost", id: "t2" },
      ]);
      tips.showTip({ id: "t3", kind: "action", title: "Reopened", primary: "Done" });
      assert.equal(channel.counts().opened, 2);
      channel.exit(true);
      assert.equal(tips.available, false);
      stop();
    } finally {
      disposeTipsOverlay();
      configureOverlayChannel(null);
    }
  });
});
