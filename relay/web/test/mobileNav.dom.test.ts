/**
 * DOM test: mobile navigation layer — the shared sheet scrim
 * (mobileNav.ts), the exclusive sheet opener, and the dual-render manage
 * cards (desktop zebra table + mobile row cards from renderManageCards).
 */
import { parseHTML } from "linkedom";
import test from "node:test";
import assert from "node:assert/strict";

// Modules touch document/window at call time — install linkedom first.
const dom = parseHTML("<!doctype html><html><body></body></html>");
(Object.assign(globalThis, {
  document: dom.document,
  window: dom.window,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  location: { host: "test.local" },
}));

const { syncMenuScrim, openSheetPanel } = await import("../src/mobileNav.js");
const { renderManageCards, renderDevicesViewBody } = await import("../src/render.js");
const { buildComposerToolbar } = await import("../src/composerControls.js");

test("scrim is a lazy singleton that toggles with the menu", () => {
  syncMenuScrim(false);
  const scrim = document.querySelector(".sheet-scrim") as HTMLElement | null;
  assert.ok(scrim, "scrim element created lazily on first use");
  syncMenuScrim(true);
  assert.ok(scrim!.classList.contains("is-open"));
  syncMenuScrim(false);
  assert.ok(!scrim!.classList.contains("is-open"));
  // Repeated opens reuse the same node — never a second scrim.
  syncMenuScrim(true);
  assert.equal(document.querySelectorAll(".sheet-scrim").length, 1);
  syncMenuScrim(false);
});

test("tapping the scrim dismisses via the registered close fn (once)", () => {
  let closed = 0;
  syncMenuScrim(true, () => { closed += 1; });
  (document.querySelector(".sheet-scrim") as HTMLElement).click();
  assert.equal(closed, 1, "close fn fired exactly once");
  assert.ok(!document.querySelector(".sheet-scrim")!.classList.contains("is-open"));
});

test("openSheetPanel is exclusive — the previous sheet closes first", () => {
  const a = document.createElement("div");
  const b = document.createElement("div");
  a.className = "sheet";
  b.className = "sheet";
  document.body.append(a, b);
  openSheetPanel(a);
  assert.ok(a.classList.contains("is-open"));
  openSheetPanel(b);
  assert.ok(!a.classList.contains("is-open"), "first sheet dismissed");
  assert.ok(b.classList.contains("is-open"), "second sheet open");
  assert.ok(document.querySelector(".sheet-scrim")!.classList.contains("is-open"), "scrim follows the active sheet");
});

test("openSheetPanel highlight follows the trigger button", () => {
  const sheet = document.createElement("div");
  const trigger = document.createElement("button");
  document.body.append(sheet, trigger);
  openSheetPanel(sheet, trigger);
  assert.ok(trigger.classList.contains("is-open"), "trigger highlighted while open");
  // Dismissal via the scrim removes the highlight too.
  (document.querySelector(".sheet-scrim") as HTMLElement).click();
  assert.ok(!trigger.classList.contains("is-open"));
  assert.ok(!sheet.classList.contains("is-open"));
});

test("an unrelated closed menu cannot release the active sheet's scrim", () => {
  const sheet = document.createElement("div");
  const otherMenu = document.createElement("div");
  document.body.append(sheet, otherMenu);
  let closed = 0;
  syncMenuScrim(true, () => { closed++; }, sheet);
  syncMenuScrim(false, undefined, otherMenu);
  const scrim = document.querySelector(".sheet-scrim") as HTMLElement;
  assert.ok(scrim.classList.contains("is-open"));
  scrim.click();
  scrim.click();
  assert.equal(closed, 1);
  sheet.remove();
  otherMenu.remove();
});

test("taking scrim ownership closes the previous menu before registering the new one", () => {
  const first = document.createElement("div");
  const second = document.createElement("div");
  let closed = "";
  syncMenuScrim(true, () => { closed += "first"; syncMenuScrim(false, undefined, first); }, first);
  syncMenuScrim(true, () => { closed += "second"; }, second);
  assert.equal(closed, "first");
  (document.querySelector(".sheet-scrim") as HTMLElement).click();
  assert.equal(closed, "firstsecond");
});

test("Devices picker survives inactive composer listeners and dismisses on the backdrop", () => {
  const toolbar = buildComposerToolbar({
    providers: [{ id: "p", name: "Default", modelId: "model" }],
    state: { providerId: "p", reasoningEffort: "high", infinite: false, bypass: false },
    bypassAvailable: true,
  }, {});
  document.body.append(toolbar.root);
  const sheet = document.createElement("div");
  sheet.className = "sheet";
  const body = renderDevicesViewBody({
    devices: [], prompts: [], selectedId: null,
    onSelect: () => {}, onBlock: () => {}, onRemove: () => {},
    onOpenPicker: () => openSheetPanel(sheet, body.querySelector<HTMLElement>(".dev-picker")),
  });
  document.body.append(body, sheet);
  const picker = body.querySelector<HTMLElement>(".dev-picker")!;
  picker.click();
  const scrim = document.querySelector(".sheet-scrim") as HTMLElement;
  assert.ok(sheet.classList.contains("is-open"));
  assert.ok(scrim.classList.contains("is-open"), "opening click must not dismiss the shared backdrop");
  assert.equal(picker.getAttribute("aria-expanded"), "true");
  // A still-mounted Composer also observes document clicks while its own
  // menus are closed; it must not clear the device selector's close handler.
  document.body.click();
  assert.ok(scrim.classList.contains("is-open"));
  scrim.click();
  assert.ok(!sheet.classList.contains("is-open"));
  assert.ok(!picker.classList.contains("is-open"));
  assert.equal(picker.getAttribute("aria-expanded"), "false");
  toolbar.root.remove();
  body.remove();
  sheet.remove();
});

test("manage cards dual-render: zebra table for desktop + m-rows for mobile", () => {
  const now = Date.now();
  const body = renderManageCards({
    currentKeyId: "k1",
    account: { username: "admin" },
    onChangeAccount: () => {},
    keys: [{ id: "k1", name: "larry-main", keyTail: "a91f", createdAt: now, deviceCount: 2 }],
    freshKey: null,
    info: null,
    audit: [{ ts: now, actor: "viewer", action: "login", detail: "larry" }],
    onClearAudit: () => {},
    prompts: [{ ts: now, deviceId: "d1", deviceName: "Mac", keyId: "k1", keyName: "Home", actor: "admin", action: "startTurn", text: "hello prompt" }],
    devices: [{
      deviceId: "d1", name: "MacBook Pro", platform: "darwin", version: "0.8.1",
      online: true, firstSeen: now, lastSeen: now, blocked: false, keyName: "larry-main",
    }],
    onCreateKey: () => {},
    onCopyKey: async () => true,
    onRenameKey: () => {},
    onRotateKey: () => {},
    onDeleteKey: () => {},
    onDismissFreshKey: () => {},
    onBlock: () => {},
    onRemove: () => {},
  });
  // Desktop tables still present (display:none only inside the media query).
  assert.ok(body.querySelector("table.zebra.dev-table"), "device/keys zebra table present");
  const rowLists = body.querySelectorAll(".m-rows");
  assert.equal(rowLists.length, 4, "keys + devices + prompts + audit mobile row lists");
  assert.match(rowLists[0]!.textContent!, /larry-main/);
  assert.match(rowLists[0]!.textContent!, /a91f/);
  assert.ok(rowLists[0]!.querySelectorAll(".m-row-btn").length >= 4, "key icon actions rendered");
  assert.match(rowLists[1]!.textContent!, /MacBook Pro/);
  assert.match(rowLists[2]!.textContent!, /hello prompt/);
  assert.match(rowLists[3]!.textContent!, /viewer · login/);
  // The "this key" badge marks the current key in both renderings.
  assert.equal(body.querySelectorAll(".key-badge").length, 2, "badge on table row + mobile row");
});

test("manage cards empty states render in both layouts", () => {
  const body = renderManageCards({
    currentKeyId: null,
    account: { username: "admin" },
    onChangeAccount: () => {},
    keys: [],
    freshKey: null,
    info: null,
    audit: [],
    onClearAudit: () => {},
    prompts: [],
    devices: [],
    onCreateKey: () => {},
    onCopyKey: async () => false,
    onRenameKey: () => {},
    onRotateKey: () => {},
    onDeleteKey: () => {},
    onDismissFreshKey: () => {},
    onBlock: () => {},
    onRemove: () => {},
  });
  assert.match(body.textContent!, /No keys\./);
  assert.match(body.textContent!, /No devices registered yet\./);
  assert.match(body.textContent!, /No activity yet\./);
});
