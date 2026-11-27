import { parseHTML } from "linkedom";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const store = new Map<string, string>();
const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  document: dom.document,
  window: dom.window,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  location: { host: "test.local" },
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
});

const { renderManageCards, renderSidebarFooter } = await import("../src/render.js");

function renderManage(freshKey: { name: string; key: string } | null = null): HTMLElement {
  return renderManageCards({
    currentKeyId: null,
    account: { username: "admin" },
    onChangeAccount: () => {},
    keys: [],
    freshKey,
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
}

test("Manage removes the Appearance card and keeps account settings after API keys", () => {
  store.set("larryRemote.theme", "dark");
  const body = renderManage();
  const cards = [...body.children].filter((c) => c.classList.contains("card"));
  assert.match(cards[0].textContent!, /API Keys/);
  assert.match(cards[1].textContent!, /Console Account/);
  assert.doesNotMatch(body.textContent!, /Appearance|Theme applies|Dark|Light/);
  assert.equal(body.querySelector('[aria-label="Theme"], .theme-seg, [data-theme]'), null);
  assert.equal(body.querySelectorAll(".account-input").length, 3);
});

test("shared sidebar footer keeps all three actions labeled and independently operable", () => {
  const calls: string[] = [];
  const footer = renderSidebarFooter({
    devicesIcon: document.createElement("span"),
    manageIcon: document.createElement("span"),
    onDevices: () => calls.push("devices"),
    onManage: () => calls.push("manage"),
    onSignOut: () => calls.push("sign-out"),
  });
  const buttons = [...footer.querySelectorAll<HTMLButtonElement>("button")];
  assert.deepEqual(buttons.map(button => button.textContent), ["Devices", "Manage", "Sign out"]);
  assert.ok(buttons.every(button => button.getAttribute("type") === "button"));
  assert.ok(buttons[2].classList.contains("footer-signout"));
  for (const button of buttons) button.click();
  assert.deepEqual(calls, ["devices", "manage", "sign-out"]);
});

test("fresh Relay key box uses the Light theme pale recess instead of a gray slab", () => {
  const body = renderManage({ name: "Office", key: "jbr_abcdef" });
  const value = body.querySelector(".key-once .key-val");
  assert.ok(value, "one-time key value rendered");
  assert.match(value!.textContent!, /jbr_abcdef/);

  const css = readFileSync(
    fileURLToPath(new URL("../src/style.css", import.meta.url)),
    "utf8",
  );
  const rule = css.match(/html\[data-theme="light"\] \.key-val\s*\{[^}]*\}/);
  assert.ok(rule, "Light key-val rule present");
  assert.match(rule[0], /background:\s*#eef4fa/);
  assert.match(rule[0], /border-color:\s*rgba\(var\(--accent-rgb\),\s*0\.16\)/);
});
