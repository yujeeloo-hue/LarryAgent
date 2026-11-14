/**
 * Auto V2 as a top-level run-mode row — regression repro:
 * the built-in react_v2 graph used to live inside the Custom graphs
 * flyout; it must now sit directly under Auto and never appear twice.
 */
import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";
import { parseHTML } from "linkedom";

(
  Module as unknown as { _extensions: Record<string, () => void> }
)._extensions[".css"] = () => {};
// Vite asset imports (?raw) are not JS — intercept at load time.
const moduleLoad = (Module as unknown as { _load: typeof Module._load })._load;
(Module as unknown as { _load: typeof Module._load })._load = function (
  request: string,
  parent: unknown,
  isMain: boolean,
) {
  if (request.includes("?raw")) return "";
  return moduleLoad.call(this, request, parent as Node.Module, isMain);
} as typeof Module._load;

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  document: dom.document,
  window: dom.window,
  HTMLElement: dom.HTMLElement,
  SVGElement: dom.SVGElement,
  Node: dom.Node,
  requestAnimationFrame: (cb: FrameRequestCallback) =>
    setTimeout(() => cb(performance.now()), 0) as unknown as number,
  ResizeObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
  getComputedStyle: () =>
    ({ getPropertyValue: () => "" }) as unknown as typeof getComputedStyle,
});

type ViewT = typeof import("./TaskComposerView.js")["TaskComposerView"];
let TaskComposerView: ViewT;
let AUTO_V2_COMPOSER_GRAPH: typeof import("./TaskComposerView.js")["AUTO_V2_COMPOSER_GRAPH"];

test.before(async () => {
  ({ TaskComposerView, AUTO_V2_COMPOSER_GRAPH } = await import(
    "./TaskComposerView.js"
  ));
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const build = () => {
  const view = new TaskComposerView({
    className: "test",
    onPromptSubmit: () => {},
    onTextInput: () => {},
  } as unknown as ConstructorParameters<ViewT>[0]);
  document.body.append(view.root);
  return view;
};

const modeRowLabels = (view: ViewT): string[] =>
  [
    ...view.plusMenu
      .querySelector('.composer-plus-menu-group[aria-label="Run mode"]')!
      .querySelectorAll(".composer-plus-menu-item"),
  ].map((el) => el.getAttribute("aria-label") ?? "");

test("Auto V2 is a top-level mode row directly under Auto", () => {
  const view = build();
  assert.deepEqual(modeRowLabels(view), [
    "Auto",
    "Auto V2",
    "Ask",
    "Plan",
    "Custom graphs",
  ]);
  // Top-level means outside the Custom graphs flyout.
  const flyout = view.plusMenu.querySelector(".composer-plus-custom-submenu");
  assert.ok(flyout);
  assert.ok(!flyout!.contains(view.plusMenu.querySelector(".composer-plus-autov2-item")!));
});

test("clicking Auto V2 selects the builtin graph via the custom path", () => {
  const view = build();
  const picked: unknown[] = [];
  view.setOnCustomGraphSelect((graph) => {
    picked.push(graph);
  });

  view.setPlusMenuOpen(true);
  view.plusMenu.querySelector<HTMLButtonElement>(".composer-plus-autov2-item")!.click();

  assert.equal(picked.length, 1);
  assert.deepEqual(picked[0], {
    id: "builtin:react_v2",
    name: "Auto V2",
    color: "#a78bfa",
  });
  assert.equal(
    view.plusButton.getAttribute("aria-expanded"),
    "false",
    "plus menu closes on pick",
  );
});

test("Auto V2 selection marks its own row, not the Custom graphs trigger", () => {
  const view = build();
  view.setCustomGraphSelection({ ...AUTO_V2_COMPOSER_GRAPH });

  const autoV2 = view.plusMenu.querySelector<HTMLButtonElement>(
    ".composer-plus-autov2-item",
  )!;
  const trigger = view.plusMenu.querySelector<HTMLButtonElement>(
    ".composer-plus-custom-trigger",
  )!;
  assert.equal(autoV2.getAttribute("aria-checked"), "true");
  assert.equal(trigger.getAttribute("aria-checked"), "false");
  assert.equal(
    trigger.querySelector(".composer-plus-menu-item-label")!.textContent,
    "Custom graphs",
    "trigger keeps its default label while Auto V2 is active",
  );

  // Switching back to Auto clears the Auto V2 row.
  view.setComposerRunMode("agent");
  assert.equal(autoV2.getAttribute("aria-checked"), "false");
});

test("a library graph selection keeps the trigger selected, Auto V2 clear", () => {
  const view = build();
  view.setCustomGraphSelection({
    id: "graph-1",
    name: "My graph",
    color: "#ff8800",
  });
  assert.equal(
    view.plusMenu
      .querySelector<HTMLButtonElement>(".composer-plus-autov2-item")!
      .getAttribute("aria-checked"),
    "false",
  );
  assert.equal(
    view.plusMenu
      .querySelector<HTMLButtonElement>(".composer-plus-custom-trigger")!
      .getAttribute("aria-checked"),
    "true",
  );
});

test("custom graphs flyout hides builtin entries (no duplicate Auto V2)", async () => {
  const view = build();
  const jellybot = (globalThis.window as unknown as Record<string, unknown>).jellybot;
  (globalThis.window as unknown as Record<string, unknown>).jellybot = {
    listFsmGraphs: async () => [],
    listComposerGraphs: async () => [
      {
        id: "builtin:react_v2",
        name: "Auto V2",
        updatedAt: 0,
        origin: "user",
        enabled: true,
        color: "#a78bfa",
      },
      {
        id: "graph-1",
        name: "My graph",
        updatedAt: 1,
        origin: "user",
        enabled: true,
      },
    ],
  };
  try {
    view.setPlusMenuOpen(true);
    await flush();
    await flush();
    const rows = [
      ...view.plusMenu.querySelectorAll(".composer-plus-custom-item .composer-plus-menu-item-label"),
    ].map((el) => el.textContent);
    assert.deepEqual(rows, ["My graph"]);
  } finally {
    (globalThis.window as unknown as Record<string, unknown>).jellybot = jellybot;
    view.destroy();
    view.root.remove();
  }
});
