import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import { installSelectPopups } from "./selectPopup.js";

function makeDocument(theme: "light" | "dark", platform = "win32") {
  const { document, window } = parseHTML(
    `<!doctype html><html data-theme="${theme}"><body></body></html>`,
  );
  document.documentElement.classList.add(`platform-${platform}`);
  // linkedom's select.value is read-only; supply browser-like value behavior
  // for the event/controller contract under test.
  const select = document.createElement("select");
  for (const [value, label] of [["allow", "Allow"], ["ask", "Ask"]]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    select.append(option);
  }
  let value = "allow";
  Object.defineProperty(select, "value", {
    get: () => value,
    set: (next: string) => { value = next; },
  });
  document.body.append(select);
  Object.assign(globalThis, { Event: window.Event });
  return { document, window, select };
}

function putInAppScope(document: Document, select: HTMLSelectElement): HTMLElement {
  const scope = document.createElement("section");
  scope.setAttribute("data-app-select", "");
  scope.append(select);
  document.body.append(scope);
  return scope;
}

test("Light select uses an app-drawn popup and preserves change events", () => {
  const { document, window, select } = makeDocument("light");
  const dispose = installSelectPopups(document);
  let changes = 0;
  select.addEventListener("change", () => { changes += 1; });

  const openEvent = new window.Event("pointerdown", { bubbles: true, cancelable: true });
  select.dispatchEvent(openEvent);
  assert.equal(openEvent.defaultPrevented, true);
  const menu = document.querySelector(".app-select-popup");
  assert.ok(menu);
  assert.equal(menu.getAttribute("role"), "listbox");
  const rows = menu.querySelectorAll(".app-select-popup-option");
  assert.equal(rows.length, 2);
  rows[1]!.dispatchEvent(new window.Event("pointerdown", { bubbles: true, cancelable: true }));
  assert.equal(select.value, "ask");
  assert.equal(changes, 1);
  assert.equal(document.querySelector(".app-select-popup"), null);
  dispose();
});

test("Dark selects outside app scopes keep their native popup behavior", () => {
  const { document, window, select } = makeDocument("dark");
  const dispose = installSelectPopups(document);
  const event = new window.Event("pointerdown", { bubbles: true, cancelable: true });
  select.dispatchEvent(event);
  assert.equal(event.defaultPrevented, false);
  assert.equal(document.querySelector(".app-select-popup"), null);
  dispose();
});

test("Light popup supports keyboard navigation and selection", () => {
  const { document, window, select } = makeDocument("light");
  const dispose = installSelectPopups(document);
  const keydown = (target: Element, key: string): void => {
    const event = new window.Event("keydown", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "key", { value: key });
    target.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
  };

  keydown(select, "ArrowDown");
  const menu = document.querySelector(".app-select-popup");
  assert.ok(menu);
  const first = menu.querySelector(".app-select-popup-option.is-active");
  assert.equal(first?.textContent, "Allow");
  keydown(first!, "ArrowDown");
  const second = menu.querySelector(".app-select-popup-option.is-active");
  assert.equal(second?.textContent, "Ask");
  keydown(second!, "Enter");
  assert.equal(select.value, "ask");
  dispose();
});

test("delegated Light popup works for selects created after installation", () => {
  const { document, window } = makeDocument("light");
  const dispose = installSelectPopups(document);
  const later = document.createElement("select");
  const option = document.createElement("option");
  option.value = "new";
  option.textContent = "New";
  later.append(option);
  document.body.append(later);

  const event = new window.Event("pointerdown", { bubbles: true, cancelable: true });
  later.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(document.querySelectorAll(".app-select-popup-option").length, 1);
  dispose();
  assert.equal(document.querySelector(".app-select-popup"), null);
});

for (const platform of ["win32", "darwin", "linux"] as const) {
  test(`${platform} Dark app scope uses a popup and preserves input/change events`, () => {
    const { document, window, select } = makeDocument("dark", platform);
    const scope = putInAppScope(document, select);
    const dispose = installSelectPopups(document);
    const events: string[] = [];
    select.addEventListener("input", () => events.push("input"));
    select.addEventListener("change", () => events.push("change"));

    for (const type of ["pointerdown", "mousedown", "click"]) {
      const event = new window.Event(type, { bubbles: true, cancelable: true });
      select.dispatchEvent(event);
      assert.equal(event.defaultPrevented, true, `${type} must suppress the native picker`);
    }
    const menu = document.querySelector(".app-select-popup");
    assert.ok(menu);
    assert.equal(menu.parentElement, document.body);
    assert.equal(scope.contains(menu), false, "popup must escape clipped editor panels");
    const row = menu.querySelectorAll(".app-select-popup-option")[1]!;
    row.dispatchEvent(new window.Event("pointerdown", { bubbles: true, cancelable: true }));
    assert.equal(select.value, "ask");
    assert.deepEqual(events, ["input", "change"]);
    assert.equal(document.querySelector(".app-select-popup"), null);
    dispose();
  });
}

test("macOS Dark app scope supports keyboard selection", () => {
  const { document, window, select } = makeDocument("dark", "darwin");
  putInAppScope(document, select);
  const dispose = installSelectPopups(document);
  const key = (target: Element, value: string): void => {
    const event = new window.Event("keydown", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "key", { value });
    target.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
  };
  key(select, "ArrowDown");
  const menu = document.querySelector(".app-select-popup");
  assert.ok(menu);
  key(menu.querySelector(".is-active")!, "ArrowDown");
  key(menu.querySelector(".is-active")!, "Enter");
  assert.equal(select.value, "ask");
  assert.equal(document.querySelector(".app-select-popup"), null);
  dispose();
});

test("Windows app popup supports keyboard cancel without changing the value", () => {
  const { document, window, select } = makeDocument("dark");
  putInAppScope(document, select);
  const dispose = installSelectPopups(document);
  let changes = 0;
  select.addEventListener("change", () => { changes += 1; });
  let focusRestored = false;
  select.focus = () => { focusRestored = true; };

  const key = (target: Element, value: string): void => {
    const event = new window.Event("keydown", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "key", { value });
    target.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
  };
  key(select, "F4");
  const menu = document.querySelector(".app-select-popup");
  assert.ok(menu);
  key(menu.querySelector(".is-active")!, "ArrowDown");
  key(menu.querySelector(".is-active")!, "Escape");
  assert.equal(document.querySelector(".app-select-popup"), null);
  assert.equal(select.value, "allow");
  assert.equal(changes, 0);
  assert.equal(focusRestored, true);
  dispose();
});

test("Windows app scope leaves disabled and multi-select controls alone", () => {
  for (const property of ["disabled", "multiple"] as const) {
    const { document, window, select } = makeDocument("dark");
    putInAppScope(document, select);
    select[property] = true;
    const dispose = installSelectPopups(document);
    const event = new window.Event("pointerdown", { bubbles: true, cancelable: true });
    select.dispatchEvent(event);
    assert.equal(event.defaultPrevented, false);
    assert.equal(document.querySelector(".app-select-popup"), null);
    dispose();
  }
});

test("an open Windows app popup stays usable after a theme change", () => {
  const { document, window, select } = makeDocument("light");
  putInAppScope(document, select);
  const dispose = installSelectPopups(document);
  select.dispatchEvent(new window.Event("pointerdown", { bubbles: true, cancelable: true }));
  const menu = document.querySelector(".app-select-popup");
  assert.ok(menu);
  document.documentElement.dataset.theme = "dark";
  window.dispatchEvent(new window.Event("resize"));
  assert.equal(document.querySelector(".app-select-popup"), menu);
  menu.querySelectorAll(".app-select-popup-option")[1]!
    .dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true }));
  assert.equal(select.value, "ask");
  dispose();
});

test("selects inside a dark island mark their popup, others do not", () => {
  const { document, window, select } = makeDocument("light");
  const scope = putInAppScope(document, select);
  scope.setAttribute("data-dark-island", "");
  const dispose = installSelectPopups(document);
  select.dispatchEvent(new window.Event("pointerdown", { bubbles: true, cancelable: true }));
  const islandMenu = document.querySelector(".app-select-popup");
  assert.ok(islandMenu);
  assert.equal(islandMenu.hasAttribute("data-dark-island"), true,
    "graph editor popups carry the island marker for darkIslandCss");
  islandMenu.querySelectorAll(".app-select-popup-option")[0]!
    .dispatchEvent(new window.Event("pointerdown", { bubbles: true, cancelable: true }));

  const plain = document.createElement("select");
  const option = document.createElement("option");
  option.textContent = "Plain";
  plain.append(option);
  document.body.append(plain);
  plain.dispatchEvent(new window.Event("pointerdown", { bubbles: true, cancelable: true }));
  const plainMenu = document.querySelector(".app-select-popup");
  assert.ok(plainMenu);
  assert.equal(plainMenu.hasAttribute("data-dark-island"), false,
    "regular Light popups keep the app palette");
  dispose();
});
