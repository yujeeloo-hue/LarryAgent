import assert from "node:assert/strict";
import Module, { register } from "node:module";
import test from "node:test";
import { parseHTML } from "linkedom";
import type { TokenHubController, DeviceSyncPreview } from "../src/TokenHubController.js";

// Exercise the real Token Hub DOM module; CSS is painted by the browser.
register("data:text/javascript," + encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    return url.endsWith(".css")
      ? { format: "module", source: "", shortCircuit: true }
      : nextLoad(url, context);
  }
`), import.meta.url);
const moduleLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request.includes("?raw")) return "";
  return moduleLoad.call(this, request, parent, isMain);
};

const dom = parseHTML("<!doctype html><html><body></body></html>");
// linkedom's <select>.value has a getter only — route it through the
// option selected attribute so protocol selects stay settable (same patch
// as tokenHubApiOptions.dom.test.ts).
const selectProto = Object.getPrototypeOf(dom.document.createElement("select"));
Object.defineProperty(selectProto, "value", {
  configurable: true,
  get(this: HTMLSelectElement): string {
    return this.querySelector("option[selected]")?.getAttribute("value")
      ?? this.querySelector("option")?.getAttribute("value")
      ?? "";
  },
  set(this: HTMLSelectElement, value: string): void {
    for (const option of this.querySelectorAll("option")) {
      if (option.getAttribute("value") === value) option.setAttribute("selected", "");
      else option.removeAttribute("selected");
    }
  },
});
Object.assign(globalThis, {
  document: dom.document,
  window: dom.window,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  location: { host: "relay.test" },
  requestAnimationFrame: (fn: FrameRequestCallback) => { fn(0); return 1; },
});
const { buildNewTaskPanel, renderManageCards } = await import("../src/render.js");
const { buildComposerToolbar } = await import("../src/composerControls.js");
const { buildDeviceProviderCard, openAddProviderWizard } = await import("../src/TokenHubView.js");

function button(root: ParentNode, label: string): HTMLButtonElement {
  const found = [...root.querySelectorAll<HTMLButtonElement>("button")]
    .find((item) => item.textContent?.trim() === label);
  assert.ok(found, `${label} button exists`);
  return found;
}

test("composer keeps its own button colors for send, stop, controls and attachment removal", () => {
  const toolbar = buildComposerToolbar({
    providers: [], bypassAvailable: false,
    state: { providerId: null, reasoningEffort: "low", infinite: false, bypass: false },
  }, {});
  toolbar.setItems([{ id: "file", name: "notes.txt", kind: "file" }]);
  const panel = buildNewTaskPanel({
    workspaces: [{ id: "/project", name: "Project", path: "/project" }],
    selectedWorkspaceId: "/project", draft: "Hello", heroIconUrl: "favicon.png", toolbar,
    onPickWorkspace: () => {}, onSend: () => {},
  });
  const semanticButtons = ".composer .action-primary, .composer .action-danger, .composer .action-danger-list, .composer .action-danger-icon";
  assert.equal(panel.root.querySelectorAll(semanticButtons).length, 0);
  toolbar.setRunning(true);
  assert.equal(panel.root.querySelectorAll(semanticButtons).length, 0);
  assert.ok(toolbar.root.querySelector(".composer-send-btn.is-stop"));
  panel.setBusy(true);
  assert.equal(toolbar.root.querySelector(".composer-send-btn")!.hasAttribute("aria-busy"), false);
});

test("Manage text buttons use action colors while square icons keep their original styles", () => {
  const root = renderManageCards({
    currentKeyId: null, account: { username: "admin" },
    keys: [{ id: "key-1", name: "Office", keyTail: "abcd", deviceCount: 1, createdAt: 1 }],
    freshKey: null, info: null, audit: [], prompts: [],
    devices: [
      { deviceId: "mac", name: "Mac", platform: "darwin", version: "1.3.6", online: true, firstSeen: 1, lastSeen: 1, blocked: false },
      { deviceId: "pc", name: "PC", platform: "win32", version: "1.3.6", online: true, firstSeen: 1, lastSeen: 1, blocked: true },
    ],
    security: {
      bans: [{ ip: "192.0.2.1", reason: "manual", bannedAt: 1, expiresAt: 0 }],
      failures: [{ ip: "192.0.2.2", failures: 1, strikes: 0, blockedUntil: 0 }],
    },
    onClearAudit: () => {}, onCreateKey: () => {}, onCopyKey: async () => true,
    onRenameKey: () => {}, onRotateKey: () => {}, onDeleteKey: () => {},
    onDismissFreshKey: () => {}, onBlock: () => {}, onRemove: () => {},
  });
  for (const label of ["Save", "New Key", "Ban IP…"]) assert.ok(button(root, label).classList.contains("action-primary"), label);
  for (const label of ["Delete", "Remove", "Clear"]) {
    assert.ok(button(root, label).classList.contains("action-danger"), label);
  }
  for (const label of ["Delete", "Remove"]) {
    assert.ok(button(root, label).classList.contains("action-danger-list"), `${label} is a list action`);
  }
  assert.equal(button(root, "Clear").classList.contains("action-danger-list"), false, "standalone Clear keeps its solid face");
  for (const label of ["Copy", "Rename", "Rotate", "Block"]) {
    assert.equal(button(root, label).matches(".action-primary, .action-danger"), false, label);
  }
  for (const label of ["Delete", "Remove", "Ban", "Unban", "Unblock", "Rotate", "Block"]) {
    const square = root.querySelector(`.m-row-btn[title="${label}"]`)!;
    assert.ok(square, `${label} mobile icon exists`);
    assert.equal(square.matches(".action-primary, .action-danger, .action-danger-list, .action-danger-icon"), false, `${label} square keeps original styling`);
  }
});

function deviceController(opts: { pending?: "pull" | "remove"; count?: number } = {}) {
  const providers = Array.from({ length: opts.count ?? 2 }, (_, index) => ({
    id: `provider-${index}`, name: `Provider ${index}`, modelId: `model-${index}`,
    baseUrl: "https://models.example/v1", supportsMultimodal: false,
    imageInput: "url" as const, rawEndpoint: false, apiKeyConfigured: true, match: "add" as const,
  }));
  const preview: DeviceSyncPreview = {
    deviceOnline: true, supportsSync: true, deviceProviders: providers,
    hubProviders: [], snapshot: { providers: [], deviceProviderIds: {} },
  };
  let removed = "";
  const controller = {
    getSnapshot: () => ({ status: "ready", providers: [], deviceProviderIds: {} }),
    getDeviceSyncPreview: () => preview,
    getSyncPending: () => opts.pending ?? null,
    getSyncError: () => null,
    getSyncAnnouncement: () => "",
    getDeviceOperation: (_device: string, operation: string) => operation === opts.pending ? { status: "pending" } : null,
    removeProviderFromDevice: async (_device: string, id: string) => { removed = id; },
    subscribe: () => () => {},
    loadDeviceSyncPreview: async () => preview,
  } as unknown as TokenHubController;
  return { controller, removed: () => removed };
}

test("device provider deletion keeps its confirmation destructive while Cancel stays neutral", () => {
  document.body.replaceChildren();
  const state = deviceController();
  const root = buildDeviceProviderCard("mac", "Mac", true, state.controller);
  assert.ok(root.querySelector(".th-device-add")!.classList.contains("action-primary"));
  assert.equal(root.querySelector(".th-device-copy")!.matches(".action-primary, .action-danger"), false, "Copy to Relay keeps its neutral transparent face");
  const remove = root.querySelector<HTMLButtonElement>(".th-device-delete")!;
  assert.ok(remove.matches(".th-icon-btn.action-danger.action-danger-list"), "device provider trash uses the translucent red row action");
  remove.click();
  const dialog = document.querySelector('[role="dialog"]')!;
  assert.ok(button(dialog, "Delete").classList.contains("action-danger"));
  assert.equal(button(dialog, "Delete").classList.contains("action-danger-list"), false, "confirmation keeps its solid destructive face");
  assert.equal(button(dialog, "Delete").classList.contains("action-primary"), false);
  assert.equal(button(dialog, "Cancel").matches(".action-primary, .action-danger"), false);
  button(dialog, "Delete").click();
  assert.equal(state.removed(), "provider-0");
});

test("provider loading marks only the active operation busy and preserves last-provider disable", () => {
  const pending = deviceController({ pending: "pull" });
  const root = buildDeviceProviderCard("mac", "Mac", true, pending.controller);
  const copy = root.querySelector<HTMLButtonElement>(".th-device-copy")!;
  assert.equal(copy.disabled, true);
  assert.equal(copy.getAttribute("aria-busy"), "true");
  assert.equal(root.querySelector(".th-device-delete")!.getAttribute("aria-busy"), "false");

  const single = deviceController({ count: 1 });
  const last = buildDeviceProviderCard("mac", "Mac", true, single.controller)
    .querySelector<HTMLButtonElement>(".th-device-delete")!;
  assert.equal(last.disabled, true);
  assert.equal(last.getAttribute("aria-busy"), "false");
});

test("provider wizard uses primary additions, a destructive Clear, and neutral navigation", () => {
  document.body.replaceChildren();
  openAddProviderWizard(deviceController().controller);
  const dialog = document.querySelector('[role="dialog"]')!;
  assert.ok(button(dialog, "Add manually").classList.contains("action-primary"));
  assert.equal(button(dialog, "Cancel").matches(".action-primary, .action-danger"), false);
  button(dialog, "Add manually").click();
  assert.ok(button(dialog, "Add ID").classList.contains("action-primary"));
  assert.ok(button(dialog, "Add 0 providers").classList.contains("action-primary"));
  assert.ok(button(dialog, "Clear").classList.contains("action-danger"));
  assert.equal(button(dialog, "Back").matches(".action-primary, .action-danger"), false);
  dialog.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click();
});
