/**
 * DOM test: MCP Hub in-place card repaints.
 *
 * Regression: any MCP snapshot change used to re-render the whole Manage
 * body / Devices view — the page scrollers (.manage-body / .dev-detail)
 * are recreated by those rebuilds, so every edit yanked the page back to
 * the top (user report). The repaint helpers must swap ONLY the MCP card:
 * sibling cards keep their DOM nodes, the card's position survives, the
 * rail's inner scroll is re-applied, and the focused device server row +
 * action carry across the swap.
 *
 * linkedom quirks worked around here: scrollTop is geometry-clamped
 * (property stubbed) and focus() never touches document.activeElement
 * (activeElement stubbed + focus spied on the fresh nodes).
 */
import { parseHTML } from "linkedom";
import test from "node:test";
import assert from "node:assert/strict";

const dom = parseHTML("<!doctype html><html><body></body></html>");
(Object.assign(globalThis, {
  document: dom.document,
  window: dom.window,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
}));

const { repaintMcpHubCard, repaintDeviceMcpCard } = await import("../src/McpHubView.js");

/** linkedom clamps scrollTop by geometry — intercept the property instead. */
function stubScrollTop(el: HTMLElement, initial = 0): { value: number } {
  const state = { value: initial };
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => state.value,
    set: (next: number) => { state.value = next; },
  });
  return state;
}

/** linkedom focus() does not move document.activeElement — serve ours. */
function stubActiveElement(el: HTMLElement | null): void {
  Object.defineProperty(document, "activeElement", {
    configurable: true,
    get: () => el,
  });
}

/** Record focus() calls on every focusable node of a subtree. */
function spyFocus(root: HTMLElement, log: HTMLElement[]): void {
  for (const node of [root, ...Array.from(root.querySelectorAll<HTMLElement>("button, li"))]) {
    node.focus = () => log.push(node);
  }
}

function manageContainer(): { container: HTMLElement; before: HTMLElement; hub: HTMLElement; after: HTMLElement } {
  const before = document.createElement("div");
  before.className = "card";
  const hub = document.createElement("div");
  hub.className = "card token-hub-card mcp-hub-card";
  const rail = document.createElement("ul");
  rail.className = "th-provider-list";
  hub.append(rail);
  const after = document.createElement("div");
  after.className = "card";
  const container = document.createElement("div");
  container.append(before, hub, after);
  document.body.append(container);
  return { container, before, hub, after };
}

test("repaintMcpHubCard swaps only the hub card and re-applies the rail scroll", () => {
  const { container, before, after, hub } = manageContainer();
  stubScrollTop(hub.querySelector<HTMLElement>(".th-provider-list")!, 120);

  let freshScroll: { value: number } | null = null;
  const swapped = repaintMcpHubCard(container, () => {
    const fresh = document.createElement("div");
    fresh.className = "card token-hub-card mcp-hub-card";
    const rail = document.createElement("ul");
    rail.className = "th-provider-list";
    freshScroll = stubScrollTop(rail, 0);
    fresh.append(rail);
    return fresh;
  });

  assert.equal(swapped, true);
  // Neighbors keep their node identity — the rest of the page was not rebuilt.
  assert.equal(container.children[0], before);
  assert.equal(container.children[2], after);
  assert.equal(container.children.length, 3);
  // Fresh card sits exactly where the old one was (position preserved →
  // the page scroller never moves).
  assert.ok(container.children[1]!.classList.contains("mcp-hub-card"));
  assert.ok(!hub.isConnected, "old card detached");
  assert.equal(freshScroll!.value, 120, "rail scroll re-applied onto the fresh node");
  container.remove();
});

test("repaintMcpHubCard returns false when the card is not mounted", () => {
  const container = document.createElement("div");
  const card = document.createElement("div");
  card.className = "card";
  container.append(card);
  assert.equal(repaintMcpHubCard(container, () => document.createElement("div")), false);
  container.remove();
});

function deviceContainer(): { container: HTMLElement; neighbor: HTMLElement } {
  const neighbor = document.createElement("div");
  neighbor.className = "card th-device-card";
  const card = document.createElement("div");
  card.className = "card th-device-card mcp-device-card";
  card.dataset.deviceId = "dev-1";
  const container = document.createElement("div");
  container.append(neighbor, card);
  document.body.append(container);
  return { container, neighbor };
}

function deviceCard(rows: string[]): HTMLElement {
  const card = document.createElement("div");
  card.className = "card th-device-card mcp-device-card";
  card.dataset.deviceId = "dev-1";
  const list = document.createElement("ul");
  for (const id of rows) {
    const row = document.createElement("li");
    row.className = "th-device-profile-row";
    row.dataset.providerId = id;
    const copy = document.createElement("button");
    copy.dataset.providerAction = "copy";
    row.append(copy);
    list.append(row);
  }
  card.append(list);
  return card;
}

/** Mount a device card, focus its `focusRow` copy button (as a click would). */
function mountFocused(container: HTMLElement, focusRow: string): { card: HTMLElement; button: HTMLElement } {
  const card = deviceCard(["srv-a", "srv-b"]);
  container.append(card);
  const button = Array.from(card.querySelectorAll<HTMLElement>(".th-device-profile-row"))
    .find((row) => row.dataset.providerId === focusRow)!
    .querySelector<HTMLElement>("[data-provider-action=copy]")!;
  stubActiveElement(button);
  return { card, button };
}

test("repaintDeviceMcpCard swaps only the MCP card and carries the focused row + action", () => {
  const { container, neighbor } = deviceContainer();
  mountFocused(container, "srv-b");

  const focusLog: HTMLElement[] = [];
  const swapped = repaintDeviceMcpCard(container, () => {
    const fresh = deviceCard(["srv-a", "srv-b"]);
    spyFocus(fresh, focusLog);
    return fresh;
  });

  assert.equal(swapped, true);
  assert.equal(container.children[0], neighbor, "sibling provider card untouched");
  assert.ok(!container.children[1]!.classList.contains("mcp-hub-card"));
  const fresh = container.querySelector<HTMLElement>(".th-device-card.mcp-device-card")!;
  assert.equal(fresh.querySelectorAll(".th-device-profile-row").length, 2);
  // Same server row + same action re-focused inside the fresh card.
  assert.equal(focusLog.length, 1, "exactly one focus restore");
  const focused = focusLog[0]!;
  assert.equal(focused.dataset.providerAction, "copy", "same action re-focused");
  assert.equal(
    focused.closest<HTMLElement>(".th-device-profile-row")?.dataset.providerId,
    "srv-b",
    "same server row re-focused",
  );
  stubActiveElement(null);
  container.remove();
});

test("repaintDeviceMcpCard drops focus when the focused server no longer exists", () => {
  const { container, neighbor } = deviceContainer();
  mountFocused(container, "srv-b");

  const focusLog: HTMLElement[] = [];
  const swapped = repaintDeviceMcpCard(container, () => {
    const fresh = deviceCard(["srv-a"]); // srv-b deleted
    spyFocus(fresh, focusLog);
    return fresh;
  });

  assert.equal(swapped, true);
  assert.equal(container.children[0], neighbor);
  const fresh = container.querySelector<HTMLElement>(".th-device-card.mcp-device-card")!;
  assert.equal(fresh.querySelectorAll(".th-device-profile-row").length, 1);
  assert.equal(focusLog.length, 0, "no stale focus on a wrong row");
  stubActiveElement(null);
  container.remove();
});

test("repaintDeviceMcpCard returns false when the card is not mounted", () => {
  const container = document.createElement("div");
  const card = document.createElement("div");
  card.className = "card th-device-card";
  container.append(card);
  assert.equal(repaintDeviceMcpCard(container, () => document.createElement("div")), false);
  container.remove();
});
