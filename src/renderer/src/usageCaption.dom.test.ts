/**
 * DOM regression tests for the tray usage popup's rotating caption slot
 * (docs/plans/20261014-usage-popup-rotating-caption.md).
 *
 * Guards the three properties the panel's geometry depends on: exactly one
 * line is ever painted per section, the shared heartbeat moves every section
 * in lockstep while each keeps its own cycle length, and a paused /
 * reduced-motion slot never moves on its own.
 */
import assert from "node:assert/strict";
import test, { describe, it } from "node:test";
import { parseHTML } from "linkedom";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  document: dom.document,
  window: dom.window,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
});

import { createCaptionRotator } from "./usageCaption.js";
import type { CaptionSlot } from "./usageCaption.js";

type Heart = { fn: () => void; cancelled: boolean };

function harness(opts?: { reduced?: boolean }): {
  rotator: ReturnType<typeof createCaptionRotator>;
  hearts: Heart[];
  arms: number;
  fire: () => void;
} {
  const hearts: Heart[] = [];
  const h = {
    hearts,
    arms: 0,
    rotator: null as unknown as ReturnType<typeof createCaptionRotator>,
    fire() {
      // The live heartbeat is the newest handle that was not cancelled.
      const live = [...hearts].reverse().find((k) => !k.cancelled);
      live?.fn();
    },
  };
  h.rotator = createCaptionRotator({
    // No fade in tests: the DOM write happens synchronously.
    defer: (fn) => {
      fn();
      return () => {};
    },
    schedule: (fn) => {
      h.arms += 1;
      const heart: Heart = { fn, cancelled: false };
      hearts.push(heart);
      return () => {
        heart.cancelled = true;
      };
    },
    prefersReducedMotion: opts?.reduced ?? false,
  });
  return h;
}

function section(): HTMLElement {
  const el = document.createElement("section");
  el.className = "up-section";
  return el;
}

const text = (root: HTMLElement): string =>
  root.querySelector(".up-caption-text")?.textContent ?? "";
const slotsOf = (root: HTMLElement): NodeListOf<Element> =>
  root.querySelectorAll(".up-caption");
const pipsOf = (root: HTMLElement): NodeListOf<Element> =>
  root.querySelectorAll(".up-pip");

describe("usageCaption.add", () => {
  it("paints nothing when the section has no lines", () => {
    const { rotator } = harness();
    const s = section();
    rotator.add(s, []);
    assert.equal(slotsOf(s).length, 0);
    assert.equal(rotator.slots().length, 0);
  });

  it("paints one line and no pips for a single-line section", () => {
    const { rotator } = harness();
    const s = section();
    rotator.add(s, ["Balance: 5.28 CNY"]);
    assert.equal(slotsOf(s).length, 1);
    assert.equal(pipsOf(s).length, 0);
    assert.equal(text(s), "Balance: 5.28 CNY");
    assert.equal(s.querySelector(".up-caption")?.dataset["count"], "1");
  });

  it("renders one pip per line with the first one active", () => {
    const { rotator } = harness();
    const s = section();
    rotator.add(s, ["a", "b", "c"]);
    assert.equal(pipsOf(s).length, 3);
    assert.deepEqual(
      [...pipsOf(s)].map((p) => p.classList.contains("is-on")),
      [true, false, false],
    );
  });

  it("keeps the full line list reachable through the title", () => {
    const { rotator } = harness();
    const s = section();
    rotator.add(s, ["5h resets 21:05", "Monthly resets Nov 12"]);
    assert.equal(
      s.querySelector(".up-caption-text")?.getAttribute("title"),
      "5h resets 21:05\nMonthly resets Nov 12",
    );
  });
});

describe("usageCaption heartbeat", () => {
  it("advances every section on one tick, each on its own cycle", () => {
    const h = harness();
    const a = section();
    const b = section();
    h.rotator.add(a, ["a0", "a1"]);
    h.rotator.add(b, ["b0", "b1", "b2"]);
    h.rotator.start();

    h.fire();
    assert.equal(text(a), "a1");
    assert.equal(text(b), "b1");

    // "a" wraps after two lines while "b" still has one left.
    h.fire();
    assert.equal(text(a), "a0");
    assert.equal(text(b), "b2");
    h.fire();
    assert.equal(text(a), "a1");
    assert.equal(text(b), "b0");
    assert.equal(h.arms, 1, "one shared heartbeat, not one per section");
  });

  it("keeps every section's pending fade when the fade is really delayed", () => {
    // The fade is a real async hand-off: a single shared cancel handle made
    // the last section of a tick cancel the ones before it, so only one
    // section ever rotated. A synchronous `defer` cannot see that, so this
    // test queues the fades and flushes them after the tick, like the 140ms
    // production timeout does.
    const queue: (() => void)[] = [];
    const rotator = createCaptionRotator({
      defer: (fn) => {
        queue.push(fn);
        return () => {
          const i = queue.indexOf(fn);
          if (i >= 0) queue.splice(i, 1);
        };
      },
      schedule: (fn) => {
        queueTick.push(fn);
        return () => {};
      },
    });
    const queueTick: (() => void)[] = [];
    const a = section();
    const b = section();
    const c = section();
    rotator.add(a, ["a0", "a1"]);
    rotator.add(b, ["b0", "b1"]);
    rotator.add(c, ["c0", "c1"]);
    rotator.start();

    queueTick.at(-1)!();
    assert.equal(queue.length, 3, "one pending fade per rotating section");
    for (const fn of queue.splice(0)) fn();

    assert.deepEqual([text(a), text(b), text(c)], ["a1", "b1", "c1"]);
    rotator.stop();
  });

  it("moves the pip highlight with the line", () => {
    const h = harness();
    const s = section();
    h.rotator.add(s, ["x", "y", "z"]);
    h.rotator.start();
    h.fire();
    assert.deepEqual(
      [...pipsOf(s)].map((p) => p.classList.contains("is-on")),
      [false, true, false],
    );
  });

  it("skips a hovered section but keeps the others rotating", () => {
    const h = harness();
    const hovered = section();
    const other = section();
    h.rotator.add(hovered, ["h0", "h1"]);
    h.rotator.add(other, ["o0", "o1"]);
    h.rotator.start();

    hovered.querySelector(".up-caption")?.dispatchEvent(
      new dom.window.Event("mouseenter"),
    );
    h.fire();
    assert.equal(text(hovered), "h0", "hover pauses that section only");
    assert.equal(text(other), "o1");

    hovered.querySelector(".up-caption")?.dispatchEvent(
      new dom.window.Event("mouseleave"),
    );
    h.fire();
    assert.equal(text(hovered), "h1");
  });

  it("clicking a line flips it and re-arms the heartbeat", () => {
    const h = harness();
    const s = section();
    h.rotator.add(s, ["c0", "c1", "c2"]);
    h.rotator.start();

    s.querySelector(".up-caption")?.dispatchEvent(new dom.window.Event("click"));
    assert.equal(text(s), "c1");
    assert.equal(h.arms, 2, "manual flip re-anchors the shared timer");
  });

  it("never schedules an autonomous timer under reduced motion, click still works", () => {
    const h = harness({ reduced: true });
    const s = section();
    h.rotator.add(s, ["r0", "r1"]);
    h.rotator.start();
    assert.equal(h.arms, 0);
    assert.equal(text(s), "r0");

    const slot = h.rotator.slots()[0] as CaptionSlot;
    h.rotator.advance(slot);
    assert.equal(text(s), "r1");
    assert.equal(h.arms, 0, "reduced motion keeps the click path, not the timer");
  });

  it("stop() cancels the heartbeat", () => {
    const h = harness();
    const s = section();
    h.rotator.add(s, ["s0", "s1"]);
    h.rotator.start();
    h.rotator.stop();
    h.fire();
    assert.equal(text(s), "s0");
  });
});

test("usageCaption slot is one line tall by construction", () => {
  // The panel height is content-driven; a slot that grows on rotation would
  // re-trigger the resize ping to main on every tick. Height lives in CSS
  // (.up-caption { height: 15px }) — assert the markup can not add lines.
  const h = harness();
  const s = section();
  h.rotator.add(s, ["l0", "l1", "l2", "l3"]);
  h.rotator.start();
  for (let i = 0; i < 4; i++) h.fire();
  assert.equal(slotsOf(s).length, 1);
  assert.equal(text(s), "l0");
  assert.equal(s.querySelectorAll(".up-caption-text").length, 1);
});
