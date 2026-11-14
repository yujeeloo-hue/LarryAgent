import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";
import { parseHTML } from "linkedom";

(Module as unknown as { _extensions: Record<string, () => void> })._extensions[".css"] = () => {};
const moduleLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request.includes("?raw")) return "";
  return moduleLoad.call(this, request, parent, isMain);
};

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  document: dom.document,
  window: dom.window,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  CSS: { escape: (value: string) => value },
  localStorage: { getItem: () => null, setItem: () => {} },
});

type View = import("./WorkspaceChangesView.js").WorkspaceChangesView;
type Controller = import("./WorkspaceChangesController.js").WorkspaceChangesController;
let WorkspaceChangesView: new () => View;
let WorkspaceChangesController: new () => Controller;

test.before(async () => {
  ({ WorkspaceChangesView } = await import("./WorkspaceChangesView.js"));
  ({ WorkspaceChangesController } = await import("./WorkspaceChangesController.js"));
});

const originalNavigator = (globalThis as { navigator?: unknown }).navigator;
test.afterEach(() => {
  delete (window as { jellybot?: unknown }).jellybot;
  Object.defineProperty(globalThis, "navigator", {
    value: originalNavigator,
    configurable: true,
  });
  document.body.replaceChildren();
});

type Row = import("./WorkspaceChangesView.js").WorkspaceChangesFileRow;

function row(path: string): Row {
  return {
    path,
    name: path.split("/").pop() ?? path,
    status: "modified",
    insertions: 1,
    deletions: 0,
    binary: false,
  };
}

function contextmenuEvent(x = 120, y = 80): Event {
  const event = new dom.window.Event("contextmenu", {
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(event, "clientX", { value: x });
  Object.defineProperty(event, "clientY", { value: y });
  return event;
}

function keyEvent(key: string, target: EventTarget): void {
  const event = new dom.window.Event("keydown", {
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(event, "key", { value: key });
  target.dispatchEvent(event);
}

test("toolbar reveal button reveals the selected file and disables without selection", () => {
  const view = new WorkspaceChangesView();
  view.setRevealLabel("Reveal in Finder");
  view.setFiles([row("src/a.ts"), row("src/b.ts")], "src/a.ts");
  assert.equal(view.revealButton.disabled, false);
  assert.equal(view.revealButton.title, "Reveal in Finder");
  assert.equal(view.revealButton.getAttribute("aria-label"), "Reveal in Finder");

  const revealed: string[] = [];
  view.onReveal((path) => revealed.push(path));
  view.revealButton.click();
  assert.deepEqual(revealed, ["src/a.ts"]);

  view.setFiles([row("src/a.ts"), row("src/b.ts")], "");
  assert.equal(view.revealButton.disabled, true, "no selection → disabled");
  view.revealButton.click();
  assert.equal(revealed.length, 1, "disabled click must not reveal");

  view.setFiles([], "");
  assert.equal(view.revealButton.disabled, true, "empty list → disabled");
});

test("row context menu reveals the right-clicked file, not the selection", () => {
  const view = new WorkspaceChangesView();
  view.setRevealLabel("Show in Explorer");
  view.setFiles([row("src/a.ts"), row("src/deep/b.ts")], "src/a.ts");
  const revealed: string[] = [];
  view.onReveal((path) => revealed.push(path));

  const rows = view.root.querySelectorAll(".workspace-changes-row");
  (rows[1] as HTMLElement).dispatchEvent(contextmenuEvent());

  const menu = document.body.querySelector(".workspace-changes-ctx-menu");
  assert.ok(menu, "context menu opens on right-click");
  assert.equal(menu.getAttribute("role"), "menu");
  const items = menu.querySelectorAll(".workspace-changes-ctx-item");
  assert.equal(items.length, 2);
  assert.equal((items[0] as HTMLElement).textContent, "Show in Explorer");
  assert.equal((items[1] as HTMLElement).textContent, "Copy Relative Path");

  (items[0] as HTMLElement).click();
  assert.deepEqual(revealed, ["src/deep/b.ts"], "reveals right-clicked row");
  assert.equal(
    document.body.querySelector(".workspace-changes-ctx-menu"),
    null,
    "menu closes after action",
  );
});

test("row context menu Copy Relative Path writes the relative path", () => {
  const view = new WorkspaceChangesView();
  view.setFiles([row("src/a.ts")], "src/a.ts");
  view.onReveal(() => assert.fail("reveal must not fire for copy"));

  let copied = "";
  Object.defineProperty(globalThis, "navigator", {
    value: { clipboard: { writeText: async (text: string) => { copied = text; } } },
    configurable: true,
  });

  (view.root.querySelector(".workspace-changes-row") as HTMLElement).dispatchEvent(contextmenuEvent());
  const items = document.body.querySelectorAll(".workspace-changes-ctx-item");
  (items[1] as HTMLElement).click();
  assert.equal(copied, "src/a.ts");
  assert.equal(document.body.querySelector(".workspace-changes-ctx-menu"), null);
});

test("Escape closes the row menu without closing the window", () => {
  const view = new WorkspaceChangesView();
  const host = document.createElement("div");
  document.body.append(host);
  view.mount(host);
  let windowCloses = 0;
  view.onClose(() => {
    windowCloses += 1;
  });
  view.setFiles([row("src/a.ts")], "src/a.ts");

  (view.root.querySelector(".workspace-changes-row") as HTMLElement).dispatchEvent(contextmenuEvent());
  assert.ok(document.body.querySelector(".workspace-changes-ctx-menu"));

  // Dispatch on body (not window): capture listeners on window must run
  // before the bubble-phase window-close handler, mirroring real key events.
  keyEvent("Escape", document.body);
  assert.equal(document.body.querySelector(".workspace-changes-ctx-menu"), null, "menu closed");
  assert.equal(windowCloses, 0, "window close must not fire while menu open");

  // After the menu is gone, Escape closes the window again.
  keyEvent("Escape", document.body);
  assert.equal(windowCloses, 1);
  view.unmount();
});

test("setFiles replaces any open row menu", () => {
  const view = new WorkspaceChangesView();
  view.setFiles([row("src/a.ts")], "src/a.ts");
  (view.root.querySelector(".workspace-changes-row") as HTMLElement).dispatchEvent(contextmenuEvent());
  assert.ok(document.body.querySelector(".workspace-changes-ctx-menu"));
  view.setFiles([row("src/a.ts")], "src/a.ts");
  assert.equal(document.body.querySelector(".workspace-changes-ctx-menu"), null);
});

type BridgeFixture = Record<string, unknown>;

function bridgeFixture(platform: string, revealed: string[]): BridgeFixture {
  return {
    platform,
    listWorkingTreeChanges: async () => ({
      isRepo: true,
      files: [row("src/deep/a.ts")],
    }),
    getWorkingTreePathDiff: async () => ({
      path: "src/deep/a.ts",
      binary: true,
      before: "",
      after: "",
      truncated: false,
    }),
    showItemInFolder: async (path: string) => {
      revealed.push(path);
      return true;
    },
    closeWorkspaceChangesWindow: async () => ({ ok: true }),
  };
}

async function tick(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

test("controller joins workspace root on reveal (darwin)", async () => {
  const revealed: string[] = [];
  (window as unknown as { jellybot: BridgeFixture }).jellybot = bridgeFixture("darwin", revealed);

  const controller = new WorkspaceChangesController();
  const host = document.createElement("div");
  document.body.append(host);
  controller.mount(host);
  controller.setWorkspacePath("/tmp/jb-repo");
  await tick();

  const button = host.querySelector('button[aria-label="Reveal in Finder"]');
  assert.ok(button, "platform label drives the toolbar button aria-label");
  (button as HTMLButtonElement).click();
  assert.deepEqual(revealed, ["/tmp/jb-repo/src/deep/a.ts"]);
});

test("controller reveals with backslash join and Explorer label on win32", async () => {
  const revealed: string[] = [];
  (window as unknown as { jellybot: BridgeFixture }).jellybot = bridgeFixture("win32", revealed);

  const controller = new WorkspaceChangesController();
  const host = document.createElement("div");
  document.body.append(host);
  controller.mount(host);
  controller.setWorkspacePath("C:\\work\\repo");
  await tick();

  const button = host.querySelector('button[aria-label="Show in Explorer"]');
  assert.ok(button, "win32 uses the Show in Explorer label");
  (button as HTMLButtonElement).click();
  assert.deepEqual(revealed, ["C:\\work\\repo\\src\\deep\\a.ts"]);
});
