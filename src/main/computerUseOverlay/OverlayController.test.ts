import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TipEvent } from "../../tools/computerUse/cursorOverlay.js";
import type { Point, Rect } from "../../tools/computerUse/types.js";
import { CURSOR_FADE_OUT_MS, CURSOR_TICK_MS, OverlayController } from "./OverlayController.js";
import type { OverlayClock, OverlayScreen, OverlayViews, SpotStyle, TipsPageMessage, TipsViewHandlers } from "./overlayTypes.js";

function fakeClock() {
  let now = 1_000;
  let nextId = 1;
  const timers = new Map<number, { at: number; every: number | null; fn: () => void }>();
  const clock: OverlayClock = {
    now: () => now,
    setInterval: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, every: ms, fn });
      return id;
    },
    clearInterval: (handle) => void timers.delete(handle as number),
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, every: null, fn });
      return id;
    },
    clearTimeout: (handle) => void timers.delete(handle as number),
  };
  const advance = (ms: number): void => {
    const end = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, timer] = due;
      now = timer.at;
      if (timer.every === null) timers.delete(id);
      else timer.at += timer.every;
      timer.fn();
    }
    now = end;
  };
  return { clock, advance, active: () => timers.size };
}

function fakeViews() {
  const log: string[] = [];
  const frames: Rect[] = [];
  const places: Point[] = [];
  const spotStyles: SpotStyle[] = [];
  let tipsHandlers: TipsViewHandlers | null = null;
  const views: OverlayViews = {
    cursor: () => ({
      place: (origin) => places.push(origin),
      show: () => log.push("cursor.window.show"),
      hide: () => log.push("cursor.window.hide"),
      call: (fn, arg) => log.push(arg === undefined ? `cursor.${fn}` : `cursor.${fn}:${JSON.stringify(arg)}`),
      destroy: () => log.push("cursor.destroy"),
    }),
    tips: (handlers) => {
      tipsHandlers = handlers;
      log.push("tips.create");
      return {
        call: (fn) => log.push(`tips.call.${fn}`),
        setFrame: (frame) => frames.push(frame),
        show: () => log.push("tips.show"),
        hide: () => log.push("tips.hide"),
        raise: () => log.push("tips.raise"),
        destroy: () => log.push("tips.destroy"),
      };
    },
    spot: () => ({
      setFrame: (frame) => log.push(`spot.frame:${frame.x},${frame.y},${frame.width},${frame.height}`),
      configure: (style) => spotStyles.push(style),
      show: () => log.push("spot.show"),
      hide: () => log.push("spot.hide"),
      destroy: () => log.push("spot.destroy"),
    }),
  };
  const page = (message: TipsPageMessage): void => tipsHandlers?.onMessage(message);
  const crash = (): void => tipsHandlers?.onCrash();
  return { views, log, frames, places, spotStyles, page, crash };
}

const halfScale: OverlayScreen = {
  toDipPoint: (p) => ({ x: p.x / 2, y: p.y / 2 }),
  toDipRect: (r) => ({ x: r.x / 2, y: r.y / 2, width: r.width / 2, height: r.height / 2 }),
  workArea: () => ({ x: 0, y: 25, width: 1440, height: 850 }),
};

function setup() {
  const events: TipEvent[] = [];
  const time = fakeClock();
  const fake = fakeViews();
  const controller = new OverlayController({ onEvent: (event) => events.push(event), onExit: () => undefined }, fake.views, halfScale, time.clock);
  return { controller, events, time, ...fake };
}

describe("windows overlay cursor", () => {
  it("creates nothing until something is drawn", () => {
    const { controller, log } = setup();
    controller.send("theme", { dark: true, accent: "#123456", onAccent: "#ffffff" });
    controller.send("resume");
    controller.send("end");
    assert.deepEqual(log, []);
  });

  it("appears at the first point in DIPs, then glides toward later points", () => {
    const { controller, log, places, time } = setup();
    controller.send("theme", { dark: true, accent: "#123456", onAccent: "#ffffff" });
    controller.send("move", { x: 1000, y: 600 });
    assert.deepEqual(places[0], { x: 460, y: 266 });
    assert.ok(log.includes('cursor.theme:{"dark":true,"accent":"#123456","onAccent":"#ffffff"}'));
    assert.ok(log.indexOf("cursor.show") > log.indexOf("cursor.theme:" + JSON.stringify({ dark: true, accent: "#123456", onAccent: "#ffffff" })));
    controller.send("move", { x: 1200, y: 600 });
    time.advance(CURSOR_TICK_MS);
    const mid = places.at(-1)!;
    assert.ok(mid.x > 460 && mid.x < 560);
    time.advance(1_000);
    assert.deepEqual(places.at(-1), { x: 560, y: 266 });
  });

  it("jumps to a click point and ripples there", () => {
    const { controller, log, places } = setup();
    controller.send("move", { x: 0, y: 0 });
    controller.send("click", { x: 400, y: 400 });
    assert.deepEqual(places.at(-1), { x: 160, y: 166 });
    assert.equal(log.at(-1), "cursor.ripple");
  });

  it("fades out on end, hides the window after the fade and stops ticking", () => {
    const { controller, log, time } = setup();
    controller.send("move", { x: 10, y: 10 });
    controller.send("end");
    assert.equal(log.at(-1), "cursor.hide");
    assert.equal(log.includes("cursor.window.hide"), false);
    time.advance(CURSOR_FADE_OUT_MS + 50);
    assert.equal(log.at(-1), "cursor.window.hide");
    assert.equal(time.active(), 0);
  });

  it("brings a fading cursor back when paused for the user", () => {
    const { controller, log, time } = setup();
    controller.send("move", { x: 10, y: 10 });
    controller.send("end");
    controller.send("pause");
    time.advance(CURSOR_FADE_OUT_MS + 50);
    assert.ok(log.includes("cursor.pause:true"));
    assert.equal(log.filter((entry) => entry === "cursor.show").length, 2);
    assert.equal(log.includes("cursor.window.hide"), false);
    controller.send("end");
    assert.ok(log.includes("cursor.pause:false"));
  });

  it("tears every window down on quit and ignores later commands", () => {
    const { controller, log } = setup();
    controller.send("move", { x: 10, y: 10 });
    controller.send("tip.show", { id: "t1", title: "Hi", primary: "Done" });
    controller.send("quit");
    assert.ok(log.includes("cursor.destroy"));
    assert.ok(log.includes("tips.destroy"));
    const before = log.length;
    controller.send("move", { x: 20, y: 20 });
    assert.equal(log.length, before);
  });
});

describe("windows overlay tips", () => {
  const anchor = { x: 400, y: 600, width: 600, height: 120 };

  it("lays the card out beside the anchor once the page reports its size", () => {
    const { controller, log, frames, spotStyles, page } = setup();
    controller.send("theme", { dark: true, accent: "#ff8800", onAccent: "#111111" });
    controller.send("tip.show", { id: "t1", kind: "action", title: "Sign in", primary: "Done", anchor, place: "anchored" });
    assert.ok(log.includes("tips.create"));
    assert.ok(log.includes("spot.frame:168,268,364,124"));
    assert.deepEqual(spotStyles.at(-1), { color: "#ff8800", dim: false });
    assert.equal(log.includes("tips.show"), false);
    page({ type: "size", w: 392, h: 232, pad: 26, mode: "card", id: "t1" });
    const frame = frames.at(-1)!;
    assert.deepEqual({ ...frame, y: Math.round(frame.y * 10) / 10 }, { x: 492, y: 235.6, width: 392, height: 232 });
    assert.ok(log.includes("tips.show"));
  });

  it("uses the danger color for confirmations and the corner without an anchor", () => {
    const { controller, frames, spotStyles, page, log } = setup();
    controller.send("tip.show", { id: "c1", kind: "confirm", title: "Delete?", primary: "Confirm", danger: true, anchor, place: "anchored" });
    assert.equal(spotStyles.at(-1)!.color, "#e5534b");
    controller.send("tip.show", { id: "c2", kind: "action", title: "Corner", primary: "Done", anchor: null, place: "corner" });
    assert.ok(log.at(-1) === "spot.hide");
    page({ type: "size", w: 352, h: 160, pad: 26, mode: "card", id: "c2" });
    assert.deepEqual(frames.at(-1), { x: 1100, y: 9, width: 352, height: 160 });
  });

  it("dims the spotlight when minimized and keeps the card where it was when settling", () => {
    const { controller, frames, spotStyles, page } = setup();
    controller.send("tip.show", { id: "t1", title: "Sign in", primary: "Done", anchor, place: "anchored" });
    page({ type: "size", w: 392, h: 232, pad: 26, mode: "card", id: "t1" });
    page({ type: "size", w: 200, h: 84, pad: 26, mode: "pill", id: "t1" });
    assert.deepEqual(spotStyles.at(-1), { color: "#00e5ff", dim: true });
    page({ type: "size", w: 392, h: 232, pad: 26, mode: "card", id: "t1" });
    const card = frames.at(-1)!;
    controller.send("tip.settle", { id: "t1", tone: "done", title: "Continuing" });
    page({ type: "size", w: 220, h: 96, pad: 26, mode: "done", id: "t1" });
    assert.equal(frames.at(-1)!.x, card.x);
  });

  it("forwards answers for the live tip only", () => {
    const { controller, events, page } = setup();
    controller.send("tip.show", { id: "t1", title: "Pick", primary: "Choose" });
    page({ type: "answer", id: "stale", action: "primary", choice: null });
    page({ type: "answer", id: "t1", action: "primary", choice: 2 });
    assert.deepEqual(events, [{ event: "tip.answer", id: "t1", action: "primary", choice: 2 }]);
  });

  it("forgets the tip once the page hid it and reports a crashed page as lost", () => {
    const { controller, events, page, crash, log } = setup();
    controller.send("tip.show", { id: "t1", title: "Wait", primary: "Done" });
    page({ type: "hidden", id: "t1" });
    assert.ok(log.includes("tips.hide"));
    page({ type: "answer", id: "t1", action: "primary", choice: null });
    assert.deepEqual(events, []);
    controller.send("tip.show", { id: "t2", title: "Again", primary: "Done" });
    crash();
    assert.deepEqual(events, [{ event: "tip.lost", id: "t2" }]);
  });
});
