import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { parseHTML } from "linkedom";
import { installMobileBackGesture } from "../src/mobileBackGesture.js";

function browser(t: TestContext) {
  const dom = parseHTML(`<!doctype html><html><body><div class="layout"><main class="main">
    <section class="view" hidden><button class="m-back">Hidden Back</button></section>
    <section class="view"><button class="m-back">Back</button><div class="content">Page</div>
      <textarea></textarea><button class="action">Action</button><pre><code>Code</code></pre>
      <div class="horizontal"><span>Scrollable</span></div></section>
  </main></div></body></html>`);
  const { document, window } = dom;
  const media = { matches: true };
  const viewport = { scale: 1 };
  Object.assign(window, {
    matchMedia: () => media,
    visualViewport: viewport,
    getSelection: () => ({ isCollapsed: true }),
    getComputedStyle: () => ({ overflowX: "auto" }),
  });
  const previous = { window: globalThis.window, document: globalThis.document, Element: globalThis.Element };
  Object.assign(globalThis, { window, document, Element: dom.Element });
  const layout = document.querySelector<HTMLElement>(".layout")!;
  const back = document.querySelector<HTMLButtonElement>(".view:not([hidden]) .m-back")!;
  let backs = 0;
  back.addEventListener("click", () => { backs++; });
  const dispose = installMobileBackGesture(() => layout);
  t.after(() => { dispose(); Object.assign(globalThis, previous); });
  const emit = (type: string, x: number, y: number, selector = ".content", count = 1, time = 0, cancelable = true) => {
    const event = new window.Event(type, { bubbles: true, cancelable });
    const touch = { identifier: 1, clientX: x, clientY: y };
    Object.defineProperties(event, {
      touches: { value: type === "touchend" ? [] : Array(count).fill(touch) },
      changedTouches: { value: [touch] },
      timeStamp: { value: time },
    });
    document.querySelector(selector)!.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const swipe = (selector = ".content", dx = 120, dy = 5, duration = 200) => {
    emit("touchstart", 20, 150, selector);
    const prevented = emit("touchmove", 20 + dx, 150 + dy, selector, 1, duration / 2);
    emit("touchend", 20 + dx, 150 + dy, selector, 1, duration);
    return prevented;
  };
  return { window, document, layout, back, media, viewport, emit, swipe, dispose, backs: () => backs };
}

test("right swipe invokes the current page's Back once; hidden pages are ignored", (t) => {
  const b = browser(t);
  assert.equal(b.swipe(), true);
  assert.equal(b.backs(), 1);
  b.emit("touchend", 140, 155);
  assert.equal(b.backs(), 1);
});

test("left, vertical, diagonal, short and slow gestures cannot navigate", (t) => {
  const b = browser(t);
  for (const [dx, dy, duration] of [[-120, 0, 200], [5, 100, 200], [80, 80, 200], [40, 0, 200], [120, 0, 1500]]) {
    b.swipe(".content", dx, dy, duration);
  }
  // A vertical drag cannot change its mind after scrolling starts.
  b.emit("touchstart", 20, 150);
  assert.equal(b.emit("touchmove", 22, 185), false);
  b.emit("touchmove", 180, 190);
  b.emit("touchend", 180, 190);
  assert.equal(b.backs(), 0);
});

test("editing, controls, code and horizontal scrollers keep their native gestures", (t) => {
  const b = browser(t);
  const horizontal = b.document.querySelector(".horizontal")!;
  Object.defineProperties(horizontal, { scrollWidth: { value: 500 }, clientWidth: { value: 200 } });
  for (const selector of ["textarea", ".action", "code", ".horizontal span"]) {
    assert.equal(b.swipe(selector), false, selector);
  }
  b.window.getSelection = () => ({ isCollapsed: false }) as unknown as Selection;
  assert.equal(b.swipe(), false);
  assert.equal(b.backs(), 0);
});

test("desktop, zoom, multitouch, cancellation and rotation do not navigate", (t) => {
  const b = browser(t);
  b.media.matches = false;
  b.swipe();
  b.media.matches = true;
  b.viewport.scale = 1.2;
  b.swipe();
  b.viewport.scale = 1;
  b.emit("touchstart", 20, 150);
  b.emit("touchmove", 50, 150, ".content", 2);
  b.emit("touchend", 140, 150);
  for (const type of ["touchcancel", "orientationchange", "resize"]) {
    b.emit("touchstart", 20, 150);
    b.emit("touchmove", 80, 150);
    if (type === "touchcancel") b.emit(type, 80, 150);
    else b.window.dispatchEvent(new b.window.Event(type));
    b.emit("touchend", 140, 150);
  }
  b.emit("touchstart", 20, 150);
  b.emit("touchmove", 80, 150, ".content", 1, 100, false);
  b.emit("touchend", 140, 150);
  assert.equal(b.backs(), 0);
});

test("sheets, dialogs and the Files panel prevent navigation of the page underneath", (t) => {
  const b = browser(t);
  for (const className of ["sheet-scrim is-open", "th-overlay", "files-panel"]) {
    const overlay = b.document.createElement("div");
    overlay.className = className;
    b.document.body.append(overlay);
    assert.equal(b.swipe(), false);
    overlay.remove();
  }
  const closedPanel = b.document.createElement("div");
  closedPanel.className = "files-panel";
  closedPanel.hidden = true;
  b.document.body.append(closedPanel);
  b.swipe();
  assert.equal(b.backs(), 1);
});

test("a nested page follows its own Back action, while home and stale gestures have none", (t) => {
  const b = browser(t);
  b.back.hidden = true;
  b.back.remove();
  b.swipe();
  assert.equal(b.backs(), 0);
  const nested = b.document.createElement("section");
  nested.className = "view";
  nested.innerHTML = '<button class="m-back">Back to Manage</button><div class="nested">Memory</div>';
  b.document.querySelector(".view:not([hidden])")!.setAttribute("hidden", "");
  b.document.querySelector(".main")!.append(nested);
  let destination = "Memory";
  nested.querySelector("button")!.addEventListener("click", () => { destination = "Manage"; });
  b.swipe(".nested");
  assert.equal(destination, "Manage");
  b.emit("touchstart", 20, 150, ".nested");
  b.emit("touchmove", 80, 150, ".nested");
  nested.hidden = true;
  b.emit("touchend", 140, 150, ".nested");
  assert.equal(b.backs(), 0);
  b.dispose();
  nested.hidden = false;
  destination = "Memory";
  b.swipe(".nested");
  assert.equal(destination, "Memory");
});
