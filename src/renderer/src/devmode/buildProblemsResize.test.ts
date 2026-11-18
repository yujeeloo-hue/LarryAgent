import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import {
  BuildProblemsResizeController,
  DEFAULT_BUILD_PROBLEMS_HEIGHT,
  DEFAULT_BUILD_PROBLEMS_WIDTH,
} from "./buildProblemsResize.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
const storage = new Map<string, string>();
const observers: Array<{ callback: () => void }> = [];
Object.assign(globalThis, {
  document: dom.document,
  window: dom.window,
  localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  },
  ResizeObserver: class {
    callback: () => void;
    constructor(callback: () => void) {
      this.callback = callback;
      observers.push(this);
    }
    observe() {}
    disconnect() {}
  },
});

function event(type: string, values: Record<string, unknown> = {}) {
  return Object.assign(
    new dom.window.Event(type, { bubbles: true, cancelable: true }),
    values,
  );
}

type Fixture = {
  controller: BuildProblemsResizeController;
  container: HTMLElement;
  size: () => number;
  layout: (box: { width: number; height: number }, stacked?: boolean) => void;
  close: () => void;
};

function fixture(): Fixture {
  const container = document.createElement("div");
  const pane = document.createElement("aside");
  document.body.append(container);
  container.append(pane);
  const controller = new BuildProblemsResizeController();
  container.append(controller.handle);
  let stacked = false;
  let box = { width: 900, height: 320 };
  container.getBoundingClientRect = () => box as DOMRect;
  controller.handle.getBoundingClientRect = () =>
    (stacked
      ? { width: box.width, height: 8 }
      : { width: 8, height: box.height }) as DOMRect;
  pane.getBoundingClientRect = () => {
    const painted =
      Number.parseFloat(pane.style.getPropertyValue("--devmode-build-problems-size")) || 0;
    return (stacked
      ? { width: box.width, height: painted }
      : { width: painted, height: box.height }) as DOMRect;
  };
  controller.handle.setPointerCapture = () => {};
  controller.handle.releasePointerCapture = () => {};
  controller.mount(container, pane);
  return {
    controller,
    container,
    size: () =>
      Number.parseFloat(
        pane.style.getPropertyValue("--devmode-build-problems-size"),
      ),
    layout(next, nextStacked = stacked) {
      box = next;
      stacked = nextStacked;
      observers.at(-1)?.callback();
    },
    close() {
      controller.destroy();
      container.remove();
    },
  };
}

test("defaults to the persisted width and hides nothing", () => {
  storage.clear();
  const f = fixture();
  try {
    assert.equal(f.size(), DEFAULT_BUILD_PROBLEMS_WIDTH);
    assert.equal(f.controller.handle.getAttribute("role"), "separator");
    assert.equal(f.controller.handle.getAttribute("aria-orientation"), "vertical");
    assert.equal(f.controller.handle.getAttribute("aria-valuenow"), "252");
    assert.equal(f.controller.handle.hidden, false);
  } finally {
    f.close();
  }
});

test("dragging right widens the pane and stores the width", () => {
  storage.clear();
  const f = fixture();
  try {
    f.controller.handle.dispatchEvent(
      event("pointerdown", { button: 0, pointerId: 1, clientX: 300 }),
    );
    window.dispatchEvent(event("pointermove", { pointerId: 1, clientX: 400 }));
    assert.equal(f.size(), 352);
    assert.equal(
      f.controller.handle.classList.contains("is-dragging"),
      true,
      "the pill must stay lit under the pointer",
    );
    window.dispatchEvent(event("pointerup", { pointerId: 1 }));
    assert.equal(storage.get("jellybot.devmode.buildProblemsWidth"), "352");
    assert.equal(f.controller.handle.classList.contains("is-dragging"), false);
    assert.equal(storage.get("jellybot.devmode.buildProblemsHeight"), undefined);

    const restored = fixture();
    try {
      assert.equal(restored.size(), 352, "width survives a remount");
    } finally {
      restored.close();
    }
  } finally {
    f.close();
  }
});

test("the drag can never swallow the log", () => {
  storage.clear();
  const f = fixture();
  try {
    f.layout({ width: 400, height: 320 });
    f.controller.handle.dispatchEvent(
      event("pointerdown", { button: 0, pointerId: 1, clientX: 200 }),
    );
    window.dispatchEvent(event("pointermove", { pointerId: 1, clientX: 900 }));
    assert.equal(f.size(), 240, "capped at 72% / container minus the log reserve");
    window.dispatchEvent(event("pointerup", { pointerId: 1 }));
    assert.equal(storage.get("jellybot.devmode.buildProblemsWidth"), "240");
  } finally {
    f.close();
  }
});

test("keyboard nudges, Home/End and reset stay inside the bounds", () => {
  storage.clear();
  const f = fixture();
  try {
    const key = (type: string, values: Record<string, unknown>) =>
      f.controller.handle.dispatchEvent(event(type, values));
    key("keydown", { key: "ArrowRight" });
    assert.equal(f.size(), 268);
    key("keydown", { key: "ArrowLeft", shiftKey: true });
    assert.equal(f.size(), 220);
    key("keydown", { key: "End" });
    assert.equal(f.size(), 648);
    key("keydown", { key: "Home" });
    assert.equal(f.size(), 148);
    key("keydown", { key: "Enter" });
    assert.equal(f.size(), DEFAULT_BUILD_PROBLEMS_WIDTH);
    assert.equal(storage.get("jellybot.devmode.buildProblemsWidth"), "252");
    f.controller.handle.dispatchEvent(event("dblclick"));
    assert.equal(f.size(), DEFAULT_BUILD_PROBLEMS_WIDTH);
  } finally {
    f.close();
  }
});

test("stacked panel resizes the height on the same handle", () => {
  storage.clear();
  const f = fixture();
  try {
    f.layout({ width: 520, height: 800 }, true);
    assert.equal(f.controller.handle.getAttribute("aria-orientation"), "horizontal");
    f.controller.handle.dispatchEvent(
      event("pointerdown", { button: 0, pointerId: 2, clientY: 200 }),
    );
    window.dispatchEvent(event("pointermove", { pointerId: 2, clientY: 260 }));
    window.dispatchEvent(event("pointerup", { pointerId: 2 }));
    assert.equal(f.size(), DEFAULT_BUILD_PROBLEMS_HEIGHT + 60);
    assert.equal(storage.get("jellybot.devmode.buildProblemsHeight"), "228");
    assert.equal(storage.get("jellybot.devmode.buildProblemsWidth"), undefined);
    f.controller.handle.dispatchEvent(event("keydown", { key: "ArrowUp" }));
    assert.equal(f.size(), DEFAULT_BUILD_PROBLEMS_HEIGHT + 60 - 16);
    f.controller.handle.dispatchEvent(event("keydown", { key: "Enter" }));
    assert.equal(f.size(), DEFAULT_BUILD_PROBLEMS_HEIGHT);
  } finally {
    f.close();
  }
});

test("a shrinking panel re-clamps without losing the preferred size", () => {
  storage.clear();
  const f = fixture();
  try {
    f.controller.handle.dispatchEvent(event("keydown", { key: "ArrowRight", shiftKey: true }));
    f.controller.handle.dispatchEvent(event("keydown", { key: "ArrowRight", shiftKey: true }));
    assert.equal(f.size(), 348);
    f.layout({ width: 520, height: 320 });
    assert.equal(f.size(), 348, "520 wide still fits the preferred width");
    f.layout({ width: 400, height: 320 });
    assert.equal(f.size(), 240);
    assert.equal(storage.get("jellybot.devmode.buildProblemsWidth"), "348");
    f.layout({ width: 900, height: 320 });
    assert.equal(f.size(), 348, "growing back restores the preferred width");
  } finally {
    f.close();
  }
});

test("destroying mid-drag removes the listeners", () => {
  storage.clear();
  const f = fixture();
  f.controller.handle.dispatchEvent(
    event("pointerdown", { button: 0, pointerId: 3, clientX: 300 }),
  );
  f.controller.destroy();
  window.dispatchEvent(event("pointermove", { pointerId: 3, clientX: 600 }));
  assert.equal(f.controller.handle.classList.contains("is-dragging"), false);
  assert.equal(f.size(), DEFAULT_BUILD_PROBLEMS_WIDTH, "the drag is dead");
  f.container.remove();
});
