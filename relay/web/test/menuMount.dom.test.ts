/**
 * DOM test: popover menu mount coordination (mobileNav.ts mountPopoverMenu).
 * On phones the bottom-sheet menus must re-parent to <body> — the pushed
 * .main is a z-index stacking context that would otherwise clamp them under
 * the body-level scrim. Desktop (and breakpoint crossings) put the menu back
 * on its anchor wrap so absolute popover positioning works again.
 *
 * Runs in its own test process: linkedom has no matchMedia, so a controllable
 * mock must be installed BEFORE the module import (the breakpoint query is
 * captured once at module load). `matches` must be a getter — a value
 * captured at first matchMedia() call would never follow phone changes.
 */
import { parseHTML } from "linkedom";
import test from "node:test";
import assert from "node:assert/strict";

const dom = parseHTML("<!doctype html><html><body></body></html>");
let phone = true;
const breakpointListeners: Array<() => void> = [];
(Object.assign(globalThis, {
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  location: { host: "test.local" },
  window: {
    matchMedia: (query: string) => ({
      get matches() { return phone && query.includes("768"); },
      addEventListener: (_type: string, fn: () => void) => { breakpointListeners.push(fn); },
      removeEventListener: () => {},
    }),
  },
}));

const { mountPopoverMenu } = await import("../src/mobileNav.js");

test("phone: menu re-parents to <body> to escape .main's stacking context", () => {
  const home = document.createElement("div");
  home.className = "composer-plus-wrap";
  const menu = document.createElement("div");
  menu.className = "composer-menu";
  home.append(menu);
  document.body.append(home);

  mountPopoverMenu(menu, home);
  assert.equal(menu.parentElement, document.body, "menu mounted on body (above the scrim)");
  assert.equal(home.contains(menu), false, "menu no longer inside the anchor wrap");
});

test("breakpoint crossing returns the menu to its anchor wrap", () => {
  const home = document.createElement("div");
  const menu = document.createElement("div");
  home.append(menu);
  document.body.append(home);

  mountPopoverMenu(menu, home);
  assert.equal(menu.parentElement, document.body, "starts on body (phone)");

  phone = false;
  for (const fn of breakpointListeners) fn();
  assert.equal(menu.parentElement, home, "desktop puts the menu back for absolute positioning");

  phone = true;
  for (const fn of breakpointListeners) fn();
  assert.equal(menu.parentElement, document.body, "back to body on phone again");
});

test("disconnected menus are dropped from coordination without errors", () => {
  const home = document.createElement("div");
  const menu = document.createElement("div");
  home.append(menu);
  document.body.append(home);
  mountPopoverMenu(menu, home);
  home.remove();
  // Re-sync via a fresh registration — the stale entry must not throw.
  const other = document.createElement("div");
  const otherHome = document.createElement("div");
  otherHome.append(other);
  document.body.append(otherHome);
  mountPopoverMenu(other, otherHome);
  assert.equal(other.parentElement, document.body);
});
