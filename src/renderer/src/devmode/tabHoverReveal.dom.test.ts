/**
 * DOM tests: hovering an edge-clipped tab scrolls the strip just enough to
 * reveal the tab fully — close button and title must stay reachable when the
 * strip overflows. Fully-visible tabs are no-ops, and reduced-motion users
 * get an instant jump instead of smooth scrollBy.
 */
import { parseHTML } from "linkedom";
import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  document: dom.document,
  window: dom.window,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  CSS: { escape: (value: string) => value },
});

// linkedom ships neither scrollIntoView nor scrollBy; stub both, recording
// scrollBy calls so tests can assert the hover-reveal delta.
const scrollByCalls: { left?: number; behavior?: string }[] = [];
for (const proto of [dom.window.HTMLElement.prototype, dom.window.Element.prototype]) {
  if (typeof proto.scrollIntoView !== "function") {
    proto.scrollIntoView = () => undefined;
  }
  if (typeof proto.scrollBy !== "function") {
    proto.scrollBy = function patchedScrollBy(
      this: dom.HTMLElement,
      opts: { left?: number; behavior?: string } = {},
    ) {
      scrollByCalls.push({ left: opts.left, behavior: opts.behavior });
      this.scrollLeft += opts.left ?? 0;
    };
  }
}

let reduceMotion = false;
Object.assign(dom.window, {
  matchMedia: () => ({ matches: reduceMotion }),
});

const origLoad = (
  Module as unknown as { _load: (...args: unknown[]) => unknown }
)._load;
(Module as unknown as { _load: (...args: unknown[]) => unknown })._load =
  function patchedLoad(this: unknown, request: string, ...rest: unknown[]): unknown {
    if (request.includes("?worker&inline")) return class WorkerStub {};
    if (request === "monaco-editor/languages/definitions/cpp/cpp.js") {
      return { language: { tokenizer: {} } };
    }
    if (request.endsWith(".css")) return {};
    return origLoad.call(this, request, ...rest);
  };

type EditorAreaControllerT = typeof import("./EditorAreaController.js")["EditorAreaController"];
let EditorAreaController: EditorAreaControllerT;

test.before(async () => {
  ({ EditorAreaController } = await import("./EditorAreaController.js"));
  // Opening tabs awaits Monaco — these tests only exercise the tab strip.
  (
    EditorAreaController.prototype as unknown as {
      ensureMonaco: () => Promise<void>;
    }
  ).ensureMonaco = () => Promise.resolve();
});

const FILE_OK = {
  ok: true as const,
  content: "class Foo {}",
  encoding: "utf8" as const,
  sizeBytes: 12,
  mtimeMs: 1,
};

/** Viewport rect stub: the scroller shows [0, 400]. */
const VIEW_LEFT = 0;
const VIEW_RIGHT = 400;

function setRect(el: HTMLElement, left: number, right: number): void {
  (el as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect =
    () =>
      ({
        left,
        right,
        top: 0,
        bottom: 24,
        width: right - left,
        height: 24,
        x: left,
        y: 0,
      }) as unknown as DOMRect;
}

async function areaWithTabs(count: number): Promise<InstanceType<EditorAreaControllerT>> {
  const area = new EditorAreaController();
  Object.assign(window, {
    jellybot: { readFileForEditor: async () => FILE_OK },
  });
  for (let i = 0; i < count; i++) {
    await area.openFile(`E:\\work\\File${i}.cpp`);
  }
  return area;
}

function hover(el: HTMLElement): void {
  el.dispatchEvent(new dom.window.Event("mouseenter"));
}

test("hovering a right-clipped tab scrolls it fully into view", async () => {
  const area = await areaWithTabs(3);
  const scroller = area.root.querySelector(".devmode-tabs-scroll") as HTMLElement;
  setRect(scroller, VIEW_LEFT, VIEW_RIGHT);
  const tabs = [...area.root.querySelectorAll(".devmode-tab")] as HTMLElement[];
  assert.equal(tabs.length, 3);

  // Tab spills 60px past the right edge (close button occluded).
  setRect(tabs[2], 350, 460);
  scrollByCalls.length = 0;
  hover(tabs[2]);
  assert.deepEqual(
    scrollByCalls.map((call) => call.left),
    [60],
    "scrolls right by exactly the clipped amount",
  );
  assert.equal(
    scrollByCalls[0]?.behavior,
    "smooth",
    "matches the strip's other reveal motions",
  );
});

test("hovering a left-clipped tab scrolls back to reveal it", async () => {
  const area = await areaWithTabs(3);
  const scroller = area.root.querySelector(".devmode-tabs-scroll") as HTMLElement;
  setRect(scroller, VIEW_LEFT, VIEW_RIGHT);
  const tabs = [...area.root.querySelectorAll(".devmode-tab")] as HTMLElement[];

  // Tab spills 30px past the left edge (title start occluded).
  setRect(tabs[0], -30, 50);
  scrollByCalls.length = 0;
  hover(tabs[0]);
  assert.deepEqual(
    scrollByCalls.map((call) => call.left),
    [-30],
    "scrolls left by exactly the clipped amount",
  );
});

test("hovering a fully-visible tab never scrolls", async () => {
  const area = await areaWithTabs(3);
  const scroller = area.root.querySelector(".devmode-tabs-scroll") as HTMLElement;
  setRect(scroller, VIEW_LEFT, VIEW_RIGHT);
  const tabs = [...area.root.querySelectorAll(".devmode-tab")] as HTMLElement[];

  for (const [i, tab] of tabs.entries()) {
    setRect(tab, 20 + i * 100, 100 + i * 100);
  }
  scrollByCalls.length = 0;
  for (const tab of tabs) hover(tab);
  assert.deepEqual(scrollByCalls, [], "fully-visible tabs are no-ops");
});

test("reduced motion jumps instantly instead of smooth scrolling", async () => {
  reduceMotion = true;
  try {
    const area = await areaWithTabs(2);
    const scroller = area.root.querySelector(".devmode-tabs-scroll") as HTMLElement;
    setRect(scroller, VIEW_LEFT, VIEW_RIGHT);
    const tabs = [...area.root.querySelectorAll(".devmode-tab")] as HTMLElement[];

    setRect(tabs[1], 350, 460);
    scroller.scrollLeft = 0;
    scrollByCalls.length = 0;
    hover(tabs[1]);
    assert.deepEqual(scrollByCalls, [], "no smooth scrollBy under reduced motion");
    assert.equal(scroller.scrollLeft, 60, "scrollLeft jumps directly to reveal");
  } finally {
    reduceMotion = false;
  }
});
