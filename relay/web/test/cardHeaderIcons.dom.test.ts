import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseHTML } from "linkedom";
import { cardHeaderArtwork, cardHeaderIcon } from "../src/cardHeaderIcons.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { document: dom.document, window: dom.window,
  HTMLElement: dom.HTMLElement, Node: dom.Node, location: { host: "preview.local" } });
const { renderManageCards, renderDevicesViewBody } = await import("../src/render.js");
const noop = () => {};

test("card symbols preserve the approved SVGs and remain independent beside hidden cards", () => {
  for (const [name, artwork] of Object.entries(cardHeaderArtwork)) {
    assert.equal(artwork, readFileSync(new URL(`../src/assets/card-header/${name}.svg`, import.meta.url), "utf8").trim());
  }
  const svg = cardHeaderIcon("keys");
  const { document } = parseHTML(`<html><body><div hidden>${svg}</div>${svg}${svg}</body></html>`);
  assert.equal(document.querySelectorAll("svg[data-relay-card-icon='keys']").length, 3);
  assert.equal(document.querySelectorAll("defs, mask, [id]").length, 0);
  assert.equal(document.querySelectorAll('path[fill-rule="evenodd"]').length, 3);
});

test("Manage uses the approved header symbols while action icons stay outline", () => {
  const body = renderManageCards({ currentKeyId: null, account: { username: "Preview" },
    onChangeAccount: noop, keys: [], freshKey: null, info: null, audit: [],
    onClearAudit: noop, prompts: [], devices: [], onCreateKey: noop,
    onCopyKey: async () => false, onRenameKey: noop, onRotateKey: noop,
    onDeleteKey: noop, onDismissFreshKey: noop, onBlock: noop, onRemove: noop,
    security: { bans: [], failures: [] }, onBanIp: noop, onUnbanIp: noop });
  assert.deepEqual([...body.querySelectorAll(".card-head [data-relay-card-icon]")]
    .map(svg => svg.getAttribute("data-relay-card-icon")),
    ["keys", "account", "relay", "devices", "security", "prompts", "audit"]);
  assert.equal(body.querySelectorAll("button [data-relay-card-icon]").length, 0);
  assert.ok(body.querySelector('button svg[fill="none"][stroke="currentColor"]'));
  for (const svg of body.querySelectorAll("[data-relay-card-icon]")) {
    assert.equal(svg.getAttribute("width"), "16");
    assert.equal(svg.getAttribute("height"), "16");
  }
});

test("Devices header migration preserves the Block action and isolates its icon", () => {
  const now = Date.now(); let blocked = false;
  const body = renderDevicesViewBody({ devices: [{ deviceId: "preview", name: "Preview Mac",
    platform: "darwin arm64", version: "1.5.9", online: true, blocked: false,
    firstSeen: now, lastSeen: now, ipHistory: [] }], selectedId: "preview", prompts: [],
    onSelect: noop, onBlock: (_device, value) => { blocked = value; }, onRemove: noop });
  assert.deepEqual([...body.querySelectorAll(".card-head [data-relay-card-icon]")]
    .map(svg => svg.getAttribute("data-relay-card-icon")), ["devices", "ip", "operations"]);
  const button = [...body.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "Block")!;
  button.click();
  assert.equal(blocked, true);
  assert.equal(body.querySelectorAll("button [data-relay-card-icon]").length, 0);
});
