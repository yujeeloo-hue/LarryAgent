/**
 * Find widget — replace row on the same custom panel as ⌘F.
 */
import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";
import { parseHTML } from "linkedom";

(
  Module as unknown as { _extensions: Record<string, () => void> }
)._extensions[".css"] = () => {};

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  document: dom.document,
  window: dom.window,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
});

type FindWidgetControllerT =
  typeof import("./FindWidgetController.js")["FindWidgetController"];
let FindWidgetController: FindWidgetControllerT;

test.before(async () => {
  ({ FindWidgetController } = await import("./FindWidgetController.js"));
});

function mockEditorArea() {
  return {
    activeEditor: {
      getSelection: () => null,
      getModel: () => null,
      getPosition: () => ({ lineNumber: 1, column: 1 }),
      focus: () => undefined,
      createDecorationsCollection: () => ({
        clear: () => undefined,
        set: () => undefined,
      }),
      revealRangeInCenter: () => undefined,
      setPosition: () => undefined,
      executeEdits: () => true,
    },
    monacoApi: {},
    activeModel: {
      findMatches: () => [],
      getValueInRange: () => "",
    },
  };
}

test("⌘F opens find with the replace row collapsed", () => {
  const controller = new FindWidgetController(
    mockEditorArea() as never,
  );
  controller.mount(dom.document.body);
  controller.open("find");
  assert.equal(controller.isOpen, true);
  assert.equal(controller.view.root.hidden, false);
  assert.equal(controller.view.root.classList.contains("is-replace"), false);
  const replaceRow = controller.view.root.querySelector(".devmode-find-replace");
  assert.equal(replaceRow instanceof HTMLElement && replaceRow.hidden, true);
  controller.destroy();
});

test("Ctrl+H / replace mode expands the second row on the same panel", () => {
  const controller = new FindWidgetController(
    mockEditorArea() as never,
  );
  controller.mount(dom.document.body);
  controller.open("replace");
  assert.equal(controller.view.root.classList.contains("is-replace"), true);
  assert.equal(
    controller.view.root.getAttribute("aria-label"),
    "Find and replace",
  );
  const replaceRow = controller.view.root.querySelector(".devmode-find-replace");
  assert.equal(replaceRow instanceof HTMLElement && replaceRow.hidden, false);
  assert.ok(controller.view.root.querySelector('[aria-label="Replace"]'));
  assert.ok(controller.view.root.querySelector('[aria-label="Replace All"]'));
  controller.destroy();
});

test("the chevron toggles the replace row without a new overlay", () => {
  const controller = new FindWidgetController(
    mockEditorArea() as never,
  );
  controller.mount(dom.document.body);
  controller.open("find");
  const reveal = controller.view.root.querySelector(
    '[aria-label="Toggle replace"]',
  );
  assert.ok(reveal);
  (reveal as HTMLElement).click();
  assert.equal(controller.view.root.classList.contains("is-replace"), true);
  (reveal as HTMLElement).click();
  assert.equal(controller.view.root.classList.contains("is-replace"), false);
  controller.destroy();
});
