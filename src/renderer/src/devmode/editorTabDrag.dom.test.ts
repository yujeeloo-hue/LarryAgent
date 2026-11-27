import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module from "node:module";
import { parseHTML } from "linkedom";
import test from "node:test";

const dom = parseHTML("<!doctype html><html><body></body></html>");
const saved = new Map<string, string>();

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => void saved.set(key, value),
    removeItem: (key: string) => void saved.delete(key),
  },
});
Object.assign(globalThis, {
  document: dom.document,
  window: dom.window,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  CSS: { escape: (value: string) => value },
  ResizeObserver: class {
    observe() {}
    disconnect() {}
  },
});
dom.window.matchMedia = () => ({ matches: true }); // reduced motion: no rAF/FLIP

const widths = new Map<string, number>();
(dom.window.HTMLElement.prototype as unknown as {
  getBoundingClientRect: () => unknown;
}).getBoundingClientRect = function patchedRect(this: dom.HTMLElement) {
  const path = this.dataset?.path;
  if (!path || !this.classList.contains("devmode-tab")) {
    return { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 };
  }
  const siblings = [...(this.parentElement?.children ?? [])].filter(
    (node): node is dom.HTMLElement =>
      !!(node as dom.HTMLElement).dataset?.path,
  );
  const index = siblings.indexOf(this);
  const left = siblings
    .slice(0, index)
    .reduce((sum, node) => sum + (widths.get(node.dataset.path!) ?? 100), 0);
  const width = widths.get(path) ?? 100;
  return {
    left,
    right: left + width,
    top: 12,
    bottom: 36,
    width,
    height: 24,
    x: left,
    y: 12,
  };
};

for (const proto of [dom.window.HTMLElement.prototype, dom.window.Element.prototype]) {
  if (typeof proto.scrollIntoView !== "function") proto.scrollIntoView = () => undefined;
  if (typeof proto.scrollBy !== "function") {
    proto.scrollBy = function patchedScrollBy(
      this: dom.HTMLElement,
      opts: { left?: number } = {},
    ) {
      this.scrollLeft += opts.left ?? 0;
    };
  }
}

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
const ROOT = "E:/work";

async function areaWithTabs(
  count: number,
  options?: ConstructorParameters<EditorAreaControllerT>[0],
): Promise<InstanceType<EditorAreaControllerT>> {
  const area = new EditorAreaController(options);
  saved.clear();
  Object.assign(window, { jellybot: { readFileForEditor: async () => FILE_OK } });
  await area.switchWorkspaceTabs(ROOT);
  for (let i = 0; i < count; i++) {
    await area.openFile(`E:\\work\\File${i}.ts`);
    widths.set(`E:/work/File${i}.ts`, 100);
  }
  area.mount(document.body);
  return area;
}

function tabs(area: InstanceType<EditorAreaControllerT>): HTMLElement[] {
  return [...area.root.querySelectorAll<HTMLElement>(".devmode-tab[data-path]")];
}

function order(area: InstanceType<EditorAreaControllerT>): string[] {
  return tabs(area).map((el) => el.dataset.path!);
}

function pointer(type: string, props: Record<string, unknown>): Event {
  return Object.assign(
    new dom.window.Event(type, { bubbles: true, cancelable: true }),
    { button: 0, buttons: 1, pointerId: 3, clientY: 24 },
    props,
  );
}

function beginDrag(
  el: HTMLElement,
  x: number,
  y = 24,
): void {
  el.dispatchEvent(pointer("pointerdown", { clientX: x, clientY: y }));
}

test("only horizontal movement starts the drag; the ghost follows the row and neighbours slide", async () => {
  const area = await areaWithTabs(3);
  try {
    const [first, second, third] = tabs(area);
    const x0 = second.getBoundingClientRect().left + 20;
    const endX = third.getBoundingClientRect().right + 10;
    beginDrag(second, x0);

    window.dispatchEvent(pointer("pointermove", { clientX: x0, clientY: 120 }));
    assert.equal(document.querySelectorAll(".devmode-tab-drag-ghost").length, 0);
    assert.equal(document.querySelectorAll(".devmode-tab.is-dragging").length, 0);

    window.dispatchEvent(pointer("pointermove", { clientX: endX, clientY: 120 }));
    const ghost = document.querySelector<HTMLElement>(".devmode-tab-drag-ghost");
    assert.ok(ghost, "a floating copy follows the pointer");
    assert.equal(ghost.dataset.path, undefined);
    assert.equal(ghost.getAttribute("aria-hidden"), "true");
    assert.equal(ghost.style.height, "24px");
    assert.equal(ghost.style.transform, `translate3d(${endX - 20}px,12px,0)`);
    assert.deepEqual(order(area).map((p) => p.split("/").pop()), [
      "File0.ts",
      "File2.ts",
      "File1.ts",
    ]);
    assert.ok(area.root.querySelector(".devmode-tabs")!.classList.contains("is-tab-dragging"));

    window.dispatchEvent(pointer("pointerup", { clientX: endX, clientY: 120, buttons: 0 }));
    assert.deepEqual(
      area.getOpenFiles().openFiles.map((p) => p.split("/").pop()),
      ["File0.ts", "File2.ts", "File1.ts"],
    );
    assert.equal(area.getOpenFiles().activeFile, "E:/work/File2.ts");
    assert.equal(document.querySelectorAll(".devmode-tab-drag-ghost").length, 0);
    assert.equal(document.querySelectorAll(".devmode-tab.is-dragging").length, 0);
    assert.ok(!area.root.querySelector(".devmode-tabs")!.classList.contains("is-tab-dragging"));
    assert.ok(first && second && third);
  } finally {
    area.destroy();
  }
});

test("reference and close buttons stay clickable and never initiate a drag", async () => {
  const references: string[] = [];
  const area = await areaWithTabs(2, {
    onReferenceFile: (path) => references.push(path),
  });
  try {
    const first = tabs(area)[0];
    const reference = first.querySelector<HTMLElement>(".devmode-tab-reference")!;
    const close = first.querySelector<HTMLElement>(".devmode-tab-close")!;
    beginDrag(reference, 20);
    window.dispatchEvent(pointer("pointermove", { clientX: 400 }));
    assert.equal(document.querySelectorAll(".devmode-tab-drag-ghost").length, 0);
    reference.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
    assert.deepEqual(references, ["E:/work/File0.ts"]);
    assert.equal(area.getOpenFiles().activeFile, "E:/work/File1.ts");

    beginDrag(close, 20);
    window.dispatchEvent(pointer("pointermove", { clientX: 400 }));
    assert.equal(document.querySelectorAll(".devmode-tab-drag-ghost").length, 0);
    close.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
    assert.deepEqual(
      area.getOpenFiles().openFiles.map((p) => p.split("/").pop()),
      ["File1.ts"],
    );
  } finally {
    area.destroy();
  }
});

test("cancel, pointercancel and blur restore the original order and drag state", async () => {
  const area = await areaWithTabs(3);
  try {
    const second = tabs(area)[1];
    const endX = tabs(area)[2].getBoundingClientRect().right + 10;
    beginDrag(second, second.getBoundingClientRect().left + 20);
    window.dispatchEvent(pointer("pointermove", { clientX: endX }));
    assert.deepEqual(order(area).map((p) => p.split("/").pop()), [
      "File0.ts",
      "File2.ts",
      "File1.ts",
    ]);
    window.dispatchEvent(pointer("pointercancel", { clientX: endX }));
    assert.deepEqual(
      area.getOpenFiles().openFiles.map((p) => p.split("/").pop()),
      ["File0.ts", "File1.ts", "File2.ts"],
    );
    assert.equal(document.querySelectorAll(".devmode-tab-drag-ghost").length, 0);
    assert.equal(document.querySelectorAll(".devmode-tab.is-dragging").length, 0);
    assert.ok(!area.root.querySelector(".devmode-tabs")!.classList.contains("is-tab-dragging"));

    const secondAgain = tabs(area)[1];
    beginDrag(secondAgain, secondAgain.getBoundingClientRect().left + 20);
    window.dispatchEvent(pointer("pointermove", { clientX: endX }));
    window.dispatchEvent(new dom.window.Event("blur"));
    assert.equal(document.querySelectorAll(".devmode-tab-drag-ghost").length, 0);
    assert.equal(document.querySelectorAll(".devmode-tab.is-dragging").length, 0);
    assert.deepEqual(
      area.getOpenFiles().openFiles.map((p) => p.split("/").pop()),
      ["File0.ts", "File1.ts", "File2.ts"],
    );
  } finally {
    area.destroy();
  }
});

test("a re-render during the drag commits the visible order and clears the drag state", async () => {
  const area = await areaWithTabs(3);
  try {
    const second = tabs(area)[1];
    const endX = tabs(area)[2].getBoundingClientRect().right + 10;
    beginDrag(second, second.getBoundingClientRect().left + 20);
    window.dispatchEvent(pointer("pointermove", { clientX: endX }));
    assert.ok(document.querySelector(".devmode-tab-drag-ghost"));

    // An agent-driven open re-renders the strip mid-drag.
    await area.openFile("E:\\work\\File3.ts");

    assert.equal(document.querySelectorAll(".devmode-tab-drag-ghost").length, 0);
    assert.equal(document.querySelectorAll(".devmode-tab.is-dragging").length, 0);
    assert.ok(!area.root.querySelector(".devmode-tabs")!.classList.contains("is-tab-dragging"));
    assert.deepEqual(
      area.getOpenFiles().openFiles.map((p) => p.split("/").pop()),
      ["File0.ts", "File2.ts", "File1.ts", "File3.ts"],
    );

    window.dispatchEvent(pointer("pointerup", { clientX: endX, buttons: 0 }));
    assert.equal(document.querySelectorAll(".devmode-tab-drag-ghost").length, 0);
    assert.deepEqual(
      area.getOpenFiles().openFiles.map((p) => p.split("/").pop()),
      ["File0.ts", "File2.ts", "File1.ts", "File3.ts"],
    );
  } finally {
    area.destroy();
  }
});

test("Alt+Arrow moves the active tab and the new order is persisted", async () => {
  const area = await areaWithTabs(3);
  const altKey = (key: string): Event =>
    Object.assign(new dom.window.Event("keydown", { bubbles: true }), {
      key,
      altKey: true,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
    });
  try {
    // File2.ts is the active tab (last opened): ArrowLeft swaps it with File1.ts
    assert.equal(area.getOpenFiles().activeFile, "E:/work/File2.ts");
    tabs(area)[2].dispatchEvent(altKey("ArrowLeft"));
    assert.deepEqual(
      area.getOpenFiles().openFiles.map((p) => p.split("/").pop()),
      ["File0.ts", "File2.ts", "File1.ts"],
    );
    assert.equal(area.getOpenFiles().activeFile, "E:/work/File2.ts");

    tabs(area)[1].dispatchEvent(altKey("ArrowRight"));
    assert.deepEqual(
      area.getOpenFiles().openFiles.map((p) => p.split("/").pop()),
      ["File0.ts", "File1.ts", "File2.ts"],
    );
    assert.equal(area.getOpenFiles().activeFile, "E:/work/File2.ts");

    // Alt+Arrow on the last tab cannot move further right.
    tabs(area)[2].dispatchEvent(altKey("ArrowRight"));
    assert.deepEqual(
      area.getOpenFiles().openFiles.map((p) => p.split("/").pop()),
      ["File0.ts", "File1.ts", "File2.ts"],
    );
  } finally {
    area.destroy();
  }
  const stored = JSON.parse(saved.get(`jellybot.devmode.tabs.${ROOT}`)!);
  assert.deepEqual(
    stored.files.map((path: string) => path.split("/").pop()),
    ["File0.ts", "File1.ts", "File2.ts"],
  );
});

const css = readFileSync(new URL("./devmode.css", import.meta.url), "utf8");

test("drag ghost uses square corners and does not add a border to the tab box", () => {
  const rule = /\.devmode-tab-drag-ghost\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(rule, /position:\s*fixed/);
  assert.match(rule, /pointer-events:\s*none/);
  assert.match(rule, /border-radius:\s*0/);
  assert.match(rule, /border:\s*0/);
  assert.match(rule, /box-shadow:/);
  // The ghost lives on <body>, outside .devmode-tabs where these vars are declared.
  assert.match(rule, /--devmode-header-bg:/);
  assert.match(rule, /--devmode-header-active:/);
  assert.match(
    css,
    /:root\[data-theme="light"\] \.devmode-tab-drag-ghost\s*\{[^}]*--devmode-header-bg:/,
  );
});

test("drag isolates every control on the tab strip", () => {
  assert.match(
    css,
    /\.devmode-tabs\.is-tab-dragging \.devmode-tab,\s*\.devmode-tabs\.is-tab-dragging \.devmode-tabs-nav\s*\{[^}]*pointer-events:\s*none/,
  );
  assert.match(css, /\.devmode-tab\.is-dragging\s*\{[^}]*opacity:\s*0\.35/);
});

test("the drag placeholder pulses without changing its box", () => {
  const keyframes =
    /@keyframes devmode-tab-drag-placeholder\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
  assert.match(keyframes, /opacity:\s*0\.26/);
  assert.match(keyframes, /opacity:\s*0\.72/);
  assert.doesNotMatch(keyframes, /height|width|padding|margin|border-width/);
  assert.match(
    css,
    /\.devmode-tab\.is-dragging\s*\{[^}]*animation:\s*devmode-tab-drag-placeholder 0\.9s ease-in-out infinite/,
  );
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.devmode-tab\.is-dragging\s*\{[^}]*animation:\s*none/,
  );
});
