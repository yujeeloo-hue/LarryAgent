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
Object.assign(dom.window, {
  matchMedia: () => ({ matches: true }),
  localStorage: {
    getItem: () => null,
    setItem: () => undefined,
  },
});

type DocumentOutlineControllerT =
  typeof import("./DocumentOutlineController.js")["DocumentOutlineController"];
let DocumentOutlineController: DocumentOutlineControllerT;

test.before(async () => {
  ({ DocumentOutlineController } = await import(
    "./DocumentOutlineController.js"
  ));
});

test("lists functions from the active buffer and jumps on click", () => {
  let revealed: { path: string; line: number } | null = null;
  const controller = new DocumentOutlineController({
    getActiveDocument: () => ({
      path: "E:/src/foo.ts",
      text: [
        "export class Host {",
        "  start(): void {}",
        "}",
        "export function boot() {}",
      ].join("\n"),
    }),
    revealLine: (path, line) => {
      revealed = { path, line };
    },
  });
  const labels = [
    ...controller.view.root.querySelectorAll(".devmode-doc-outline-label"),
  ].map((el) => el.textContent);
  assert.deepEqual(labels, ["Host", "start", "boot"]);
  const sigs = [
    ...controller.view.root.querySelectorAll(".devmode-doc-outline-sig"),
  ].map((el) => el.textContent);
  assert.deepEqual(sigs, ["(): void", "()"]);
  const rows = [
    ...controller.view.root.querySelectorAll(".devmode-doc-outline-row"),
  ];
  assert.equal(rows[1]?.getAttribute("title")?.includes("(): void"), true);
  (rows[2] as HTMLElement).click();
  assert.deepEqual(revealed, { path: "E:/src/foo.ts", line: 4 });
  controller.destroy();
});

test("empty state when no editor tab is open", () => {
  const controller = new DocumentOutlineController({
    getActiveDocument: () => null,
    revealLine: () => undefined,
  });
  const empty = controller.view.root.querySelector(
    ".devmode-doc-outline-empty",
  );
  assert.equal(empty?.textContent, "Open a file to see its outline.");
  controller.destroy();
});

test("header toggles the collapsed class", () => {
  const controller = new DocumentOutlineController({
    getActiveDocument: () => null,
    revealLine: () => undefined,
  });
  const head = controller.view.root.querySelector(".devmode-doc-outline-head");
  assert.ok(head);
  assert.equal(controller.view.root.classList.contains("is-collapsed"), false);
  (head as HTMLElement).click();
  assert.equal(controller.view.root.classList.contains("is-collapsed"), true);
  controller.destroy();
});

test("C++ outline uses the sibling header, not .cpp bodies", async () => {
  const header = [
    "class AMyActor",
    "{",
    "public:",
    "    void BeginPlay();",
    "    int32 Health;",
    "private:",
    "    void TickInternal();",
    "};",
  ].join("\n");
  let revealed: { path: string; line: number } | null = null;
  const controller = new DocumentOutlineController({
    getActiveDocument: () => ({
      path: "E:/Game/Private/MyActor.cpp",
      text: "void AMyActor::BeginPlay() { Super::BeginPlay(); }",
    }),
    readFile: async (path) =>
      path === "E:/Game/Public/MyActor.h" ? header : null,
    revealLine: (path, line) => {
      revealed = { path, line };
    },
  });
  await controller.refresh();
  const labels = [
    ...controller.view.root.querySelectorAll(".devmode-doc-outline-label"),
  ].map((el) => el.textContent);
  assert.deepEqual(labels, [
    "AMyActor",
    "public",
    "BeginPlay",
    "Health",
    "private",
    "TickInternal",
  ]);
  const access = controller.view.root.querySelectorAll(
    ".devmode-doc-outline-row.is-access",
  );
  assert.equal(access.length, 2);
  const health = [
    ...controller.view.root.querySelectorAll(".devmode-doc-outline-row"),
  ].find((el) => el.querySelector(".devmode-doc-outline-label")?.textContent === "Health");
  assert.equal(
    health?.querySelector(".devmode-doc-outline-icon")?.getAttribute("data-kind"),
    "variable",
  );
  const beginPlay = [
    ...controller.view.root.querySelectorAll(".devmode-doc-outline-row"),
  ].find(
    (el) =>
      el.querySelector(".devmode-doc-outline-label")?.textContent === "BeginPlay",
  );
  (beginPlay as HTMLElement).click();
  assert.deepEqual(revealed, { path: "E:/Game/Public/MyActor.h", line: 4 });
  controller.destroy();
});

test("C++ implementation without a header shows an empty outline", async () => {
  const controller = new DocumentOutlineController({
    getActiveDocument: () => ({
      path: "E:/src/orphan.cpp",
      text: "void Foo::Bar() {}",
    }),
    revealLine: () => undefined,
  });
  await controller.refresh();
  const empty = controller.view.root.querySelector(
    ".devmode-doc-outline-empty",
  );
  assert.equal(empty?.textContent, "No header declarations for this file.");
  controller.destroy();
});

test("resize handle lives in the gutter, outside the outline card", () => {
  const controller = new DocumentOutlineController({
    getActiveDocument: () => null,
    revealLine: () => undefined,
  });
  // The card clips its own body (border-radius + overflow:hidden), so the
  // handle must be a sibling — the stack owns the gap it sits in.
  assert.equal(controller.view.root.contains(controller.view.resizeHandle), false);
  assert.equal(
    controller.view.resizeHandle.classList.contains("devmode-doc-outline-resize"),
    true,
  );
  // Collapsing hides the handle; the stack gap becomes the separator.
  (
    controller.view.root.querySelector(".devmode-doc-outline-head") as HTMLElement
  ).click();
  assert.equal(controller.view.resizeHandle.hidden, true);
  controller.destroy();
});
