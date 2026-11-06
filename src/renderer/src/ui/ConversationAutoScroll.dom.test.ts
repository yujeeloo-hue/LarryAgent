import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import { ConversationAutoScroll, CONVERSATION_SCROLL_INTENT } from "./ConversationAutoScroll.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
let nextFrame = 0;
const frames = new Map<number, () => void>();
const observers: Array<{ callback: () => void; disconnected: boolean }> = [];
/** Per-element overflowY stubs — targetScrollsOuter consults getComputedStyle. */
const computedStyles = new Map<object, { overflowY: string }>();
Object.assign(globalThis, {
  document: dom.document, HTMLElement: dom.HTMLElement,
  getComputedStyle: (el: object) => computedStyles.get(el) ?? { overflowY: "visible" },
  requestAnimationFrame: (callback: () => void) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  },
  cancelAnimationFrame: (id: number) => frames.delete(id),
  ResizeObserver: class {
    state: { callback: () => void; disconnected: boolean };
    constructor(callback: () => void) {
      this.state = { callback, disconnected: false };
      observers.push(this.state);
    }
    observe() {}
    disconnect() { this.state.disconnected = true; }
  },
});

function settle() {
  for (let i = 0; frames.size; i++) {
    assert.ok(i < 100, "scroll chase settles");
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach(callback => callback());
  }
}

function emit(target: HTMLElement, type: string, properties = {}) {
  const event = new dom.window.Event(type, { bubbles: true });
  Object.assign(event, properties);
  target.dispatchEvent(event);
}

function view(following = true) {
  const host = document.createElement("div");
  const content = document.createElement("div");
  host.append(content);
  document.body.append(host);
  let height = 1000;
  let top = 800;
  Object.defineProperties(host, {
    scrollHeight: { get: () => height },
    clientHeight: { value: 200 },
    scrollTop: { get: () => top, set: value => { top = Math.min(Math.max(0, value), height - 200); }, configurable: true },
  });
  const follow = new ConversationAutoScroll(host, content, () => {}, following);
  return {
    host, content, follow,
    grow: (value: number) => { height = value; },
    scroll: (value: number) => { host.scrollTop = value; emit(host, "scroll"); },
  };
}

test.afterEach(() => {
  frames.clear();
  observers.length = 0;
  computedStyles.clear();
  document.body.replaceChildren();
});

test("large streamed updates and layout scroll events never disable follow", () => {
  const v = view();
  v.grow(2500);
  emit(v.host, "scroll");
  v.follow.contentChanged();
  settle();
  assert.equal(v.follow.following, true);
  assert.equal(v.host.scrollTop, 2300);
  // Images, card animations and viewport resizes can land after the paint.
  v.grow(4000);
  observers[0]!.callback();
  settle();
  assert.equal(v.host.scrollTop, 3800);
  v.follow.destroy();
});

for (const [deltaX, deltaY] of [[0, -1], [0, 1], [1, 0]]) {
  test(`wheel input (${deltaX}, ${deltaY}) cancels a pending chase immediately`, () => {
    const v = view();
    v.grow(2000);
    v.follow.contentChanged();
    emit(v.host, "wheel", { deltaX, deltaY });
    // A queued programmatic scroll event at the same offset cannot resume.
    emit(v.host, "scroll");
    settle();
    assert.equal(v.follow.following, false);
    assert.equal(v.host.scrollTop, 800);
    observers[0]!.callback();
    settle();
    assert.equal(v.host.scrollTop, 800);
    v.follow.destroy();
  });
}

test("follow resumes only after the reader actually returns to the outer bottom", () => {
  const v = view();
  emit(v.host, "wheel", { deltaY: -100 });
  v.scroll(300);
  v.grow(1400);
  emit(v.host, "wheel", { deltaY: 100 });
  v.scroll(1150);
  assert.equal(v.follow.following, false, "being within the old near-bottom threshold is insufficient");
  v.scroll(1200);
  assert.equal(v.follow.following, true);
  v.grow(2000);
  v.follow.contentChanged();
  settle();
  assert.equal(v.host.scrollTop, 1800);
  v.follow.destroy();
});

test("landing a few pixels short of the bottom still resumes the follow", () => {
  const v = view();
  emit(v.host, "wheel", { deltaY: -100 });
  v.scroll(300);
  v.grow(1400); // maxTop = 1200
  emit(v.host, "wheel", { deltaY: 300 });
  v.scroll(1188); // momentum quantization lands 12px short
  assert.equal(v.follow.following, true);
  settle();
  assert.equal(v.host.scrollTop, 1200, "the eased chase closes the gap");
  v.follow.destroy();
});

test("wheel momentum tails at the bottom never strand a resumed reader", () => {
  const v = view(false); // paused, already sitting at the bottom
  emit(v.host, "wheel", { deltaY: 20 });
  assert.equal(v.follow.following, true, "a downward nudge at the bottom is a follow request");
  // Tail wheels keep firing after the scroller clamps; each must keep (not
  // re-pause) the follow.
  emit(v.host, "wheel", { deltaY: 8 });
  emit(v.host, "wheel", { deltaY: 3 });
  assert.equal(v.follow.following, true);
  v.follow.destroy();
});

test("held-down keys at the bottom resume and keep the follow", () => {
  const v = view(false);
  emit(v.host, "keydown", { key: "ArrowDown" });
  assert.equal(v.follow.following, true);
  emit(v.host, "keydown", { key: "End" });
  assert.equal(v.follow.following, true);
  // Upward keys still pause.
  emit(v.host, "keydown", { key: "ArrowUp" });
  assert.equal(v.follow.following, false);
  v.follow.destroy();
});

test("a downward touch drag at the bottom resumes the follow", () => {
  const v = view(false);
  emit(v.host, "touchmove", { touches: [{ clientY: 500 }] });
  assert.equal(v.follow.following, false, "the first sample only records a baseline");
  emit(v.host, "touchmove", { touches: [{ clientY: 480 }] });
  assert.equal(v.follow.following, true);
  v.follow.destroy();
});

test("downward wheels inside a nested scrollable do not resume the outer follow", () => {
  const v = view(false); // paused, at the bottom
  const nested = document.createElement("div");
  Object.defineProperties(nested, {
    scrollHeight: { value: 400 }, clientHeight: { value: 200 },
    scrollTop: { get: () => 0, set: () => {}, configurable: true },
  });
  computedStyles.set(nested, { overflowY: "auto" });
  v.content.append(nested);
  emit(nested, "wheel", { deltaY: 40 });
  assert.equal(v.follow.following, false);
  v.follow.destroy();
});

/** Nested scrollport parked at its own bottom (streaming write/patch preview). */
function bottomedNested(v: ReturnType<typeof view>) {
  const nested = document.createElement("div");
  Object.defineProperties(nested, {
    scrollHeight: { value: 400 }, clientHeight: { value: 200 },
    scrollTop: { get: () => 200, set: () => {}, configurable: true },
  });
  computedStyles.set(nested, { overflowY: "auto" });
  v.content.append(nested);
  return nested;
}

test("a downward wheel over a bottomed nested preview never pauses a following reader", () => {
  const v = view();
  const nested = bottomedNested(v);
  v.grow(2000);
  v.follow.contentChanged();
  settle(); // streaming chase parks the outer at its bottom first
  assert.equal(v.host.scrollTop, 1800);
  // Momentum tail over the streaming preview: the gesture chains outward,
  // so it is follow intent — the streaming chase must survive it.
  emit(nested, "wheel", { deltaY: 40 });
  assert.equal(v.follow.following, true, "the chase is not canceled");
  v.grow(2200);
  v.follow.contentChanged();
  settle();
  assert.equal(v.host.scrollTop, 2000);
  v.follow.destroy();
});

test("momentum tails over a bottomed nested preview resume a paused reader", () => {
  const v = view(false); // paused at the bottom, like the stranded streaming case
  const nested = bottomedNested(v);
  emit(nested, "wheel", { deltaY: 20 });
  assert.equal(v.follow.following, true);
  emit(nested, "wheel", { deltaY: 8 });
  assert.equal(v.follow.following, true);
  v.follow.destroy();
});

test("a downward touch drag over a bottomed nested preview keeps the follow", () => {
  const v = view();
  const nested = bottomedNested(v);
  v.grow(2000);
  v.follow.contentChanged();
  settle();
  emit(nested, "touchmove", { touches: [{ clientY: 500 }] });
  emit(nested, "touchmove", { touches: [{ clientY: 480 }] });
  assert.equal(v.follow.following, true);
  v.grow(2200);
  v.follow.contentChanged();
  settle();
  assert.equal(v.host.scrollTop, 2000);
  v.follow.destroy();
});

test("nested patch, write and Thinking scrolls pause the outer follow", () => {
  for (const className of ["tool-patch-diff", "tool-file-lines", "conversation-reasoning-body"]) {
    const v = view();
    const nested = document.createElement("div");
    nested.className = className;
    v.content.append(nested);
    emit(nested, "wheel", { deltaY: -1 });
    emit(nested, "scroll");
    assert.equal(v.follow.following, false);
    v.grow(2000);
    v.follow.contentChanged();
    settle();
    assert.equal(v.host.scrollTop, 800);
    // The explicit bottom button must work even if the outer view never moved.
    v.follow.follow();
    settle();
    assert.equal(v.host.scrollTop, 1800);
    v.follow.destroy();
  }
});

test("native vertical and horizontal scrollbar drags pause before scrolling", () => {
  const v = view();
  const nested = document.createElement("div");
  v.content.append(nested);
  Object.defineProperties(nested, {
    clientWidth: { value: 284 }, clientHeight: { value: 184 },
    clientLeft: { value: 0 }, clientTop: { value: 0 },
    scrollWidth: { value: 600 }, scrollHeight: { value: 1000 },
  });
  nested.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 200 }) as DOMRect;
  for (const [clientX, clientY] of [[295, 50], [50, 195]]) {
    emit(nested, "pointerdown", { button: 0, clientX, clientY });
    assert.equal(v.follow.following, false);
    v.follow.follow();
  }
  v.follow.destroy();
});

test("Relay overlay scrollbar drags notify the conversation even from a sibling thumb", () => {
  const v = view();
  const nested = document.createElement("div");
  v.content.append(nested);
  emit(nested, CONVERSATION_SCROLL_INTENT);
  assert.equal(v.follow.following, false);
  v.follow.destroy();
});

test("touch and keyboard scrolling pause, while typing and ordinary clicks do not", () => {
  const v = view();
  const input = document.createElement("textarea");
  v.content.append(input);
  emit(input, "keydown", { key: "ArrowDown" });
  emit(v.content, "pointerdown", { button: 0, clientX: 30, clientY: 30 });
  assert.equal(v.follow.following, true);
  emit(v.content, "touchmove");
  assert.equal(v.follow.following, false);
  v.follow.follow();
  emit(v.content, "keydown", { key: "PageUp" });
  assert.equal(v.follow.following, false);
  v.follow.destroy();
});

test("paused state survives a snapshot restore at the physical bottom", () => {
  const v = view(false);
  emit(v.host, "scroll");
  observers[0]!.callback();
  v.follow.contentChanged();
  settle();
  assert.equal(v.follow.following, false);
  v.grow(2000);
  v.follow.contentChanged();
  settle();
  assert.equal(v.host.scrollTop, 800);
  v.follow.destroy();
});

test("destroy disconnects observers, events and scheduled scrolls", () => {
  const v = view();
  v.grow(2000);
  v.follow.contentChanged();
  v.follow.destroy();
  assert.equal(observers[0]!.disconnected, true);
  emit(v.host, "wheel", { deltaY: -1 });
  settle();
  assert.equal(v.host.scrollTop, 800);
  assert.equal(v.follow.following, true);
});

test("integer pixel rounding settles at the exact bottom without an endless animation", () => {
  const v = view();
  let top = 0;
  Object.defineProperty(v.host, "scrollTop", {
    get: () => top, set: value => { top = Math.round(value); }, configurable: true,
  });
  v.follow.follow();
  settle();
  assert.equal(top, 800);
  assert.equal(frames.size, 0);
  v.follow.destroy();
});

test("programmatic paging restores cannot resume a paused reader", () => {
  const v = view();
  emit(v.host, "wheel", { deltaY: -100 });
  v.grow(2000);
  v.follow.restoreTop(1800);
  emit(v.host, "scroll");
  assert.equal(v.follow.following, false);
  v.follow.destroy();
});

test("a scrollbar drag can return to the bottom then move away again in one gesture", () => {
  const v = view();
  Object.defineProperties(v.host, {
    clientWidth: { value: 284 }, clientLeft: { value: 0 }, clientTop: { value: 0 },
  });
  v.host.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 200 }) as DOMRect;
  emit(v.host, "pointerdown", { button: 0, clientX: 295, clientY: 50 });
  v.scroll(300);
  v.scroll(800);
  assert.equal(v.follow.following, true);
  v.scroll(400);
  assert.equal(v.follow.following, false);
  emit(v.host, "pointerup");
  v.follow.destroy();
});
