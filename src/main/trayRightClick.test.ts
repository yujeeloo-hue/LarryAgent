import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createRightClickToggle,
  RIGHT_CLICK_ECHO_WINDOW_MS,
  type RightClickBounds,
} from "./trayRightClick.js";

const B: RightClickBounds = { x: 10, y: 20, width: 16, height: 16 };

function harness(echoWindowMs = RIGHT_CLICK_ECHO_WINDOW_MS) {
  let clock = 1_000;
  const calls: RightClickBounds[] = [];
  const handler = createRightClickToggle((bounds) => calls.push(bounds), {
    now: () => clock,
    echoWindowMs,
  });
  return {
    handler,
    calls,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("createRightClickToggle", () => {
  it("collapses the press + WM_CONTEXTMENU echo pair into one toggle", () => {
    const { handler, calls, advance } = harness();
    handler(B); // WM_RBUTTONDOWN
    advance(60);
    handler(B); // WM_CONTEXTMENU echo within window
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], B);
  });

  it("toggles once per gesture across repeated right-clicks", () => {
    const { handler, calls, advance } = harness();
    for (let i = 0; i < 4; i += 1) {
      handler(B);
      advance(50);
      handler(B);
      advance(400);
    }
    assert.equal(calls.length, 4);
  });

  it("disarms immediately after consuming one echo so rapid second gesture still fires", () => {
    const { handler, calls, advance } = harness();
    handler(B); // gesture 1 press
    advance(40);
    handler(B); // gesture 1 echo (disarms)
    advance(80); // still < 320ms from gesture 1 press, but echo already consumed
    handler(B); // gesture 2 press — must NOT be swallowed
    advance(40);
    handler(B); // gesture 2 echo
    assert.equal(calls.length, 2);
  });

  it("never swallows the next right-click when Explorer omits the WM_CONTEXTMENU echo", () => {
    const { handler, calls, advance } = harness();
    handler(B); // gesture 1: single event only (no echo emitted by shell)
    assert.equal(calls.length, 1);

    advance(RIGHT_CLICK_ECHO_WINDOW_MS + 50);
    // Next user right-click must work on the first try — never dropped.
    handler(B);
    assert.equal(calls.length, 2);
  });

  it("handles alternating single-event and double-event gestures without desync", () => {
    const { handler, calls, advance } = harness();
    // Gesture 1: single event (no echo)
    handler(B);
    assert.equal(calls.length, 1);
    advance(1_000);

    // Gesture 2: double event (press + echo)
    handler(B);
    advance(55);
    handler(B);
    assert.equal(calls.length, 2);
    advance(1_000);

    // Gesture 3: single event (no echo)
    handler(B);
    assert.equal(calls.length, 3);
  });

  it("independent instances do not share pairing state", () => {
    const a = harness();
    const b = harness();
    a.handler(B);
    b.handler(B);
    b.advance(40);
    b.handler(B);
    assert.equal(a.calls.length, 1);
    assert.equal(b.calls.length, 1);
  });
});
