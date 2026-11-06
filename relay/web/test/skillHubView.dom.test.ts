/**
 * DOM test: Skill Hub in-place card repaints.
 *
 * Same regression as the MCP Hub cards: a snapshot change must swap ONLY the
 * skill card so the page scrollers (.manage-body / .dev-detail) keep their
 * DOM and the rail's inner scroll survives. The device card must also carry
 * the focused skill row + action across the swap.
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

const { repaintSkillHubCard, repaintDeviceSkillCard } = await import("../src/SkillHubView.js");

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
  hub.className = "card token-hub-card skill-hub-card";
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

test("repaintSkillHubCard swaps only the skill card and re-applies the rail scroll", () => {
  const { container, before, after, hub } = manageContainer();
  stubScrollTop(hub.querySelector<HTMLElement>(".th-provider-list")!, 90);

  let freshScroll: { value: number } | null = null;
  const swapped = repaintSkillHubCard(container, () => {
    const fresh = document.createElement("div");
    fresh.className = "card token-hub-card skill-hub-card";
    const rail = document.createElement("ul");
    rail.className = "th-provider-list";
    freshScroll = stubScrollTop(rail, 0);
    fresh.append(rail);
    return fresh;
  });

  assert.equal(swapped, true);
  assert.equal(container.children[0], before, "previous card untouched");
  assert.equal(container.children[2], after, "next card untouched");
  assert.equal(container.children.length, 3);
  assert.ok(container.children[1]!.classList.contains("skill-hub-card"));
  assert.ok(!hub.isConnected, "old card detached");
  assert.equal(freshScroll!.value, 90, "rail scroll re-applied onto the fresh node");
  container.remove();
});

test("repaintSkillHubCard returns false when the card is not mounted", () => {
  const container = document.createElement("div");
  const card = document.createElement("div");
  card.className = "card mcp-hub-card";
  container.append(card);
  assert.equal(repaintSkillHubCard(container, () => document.createElement("div")), false);
  container.remove();
});

function deviceContainer(): { container: HTMLElement; neighbor: HTMLElement } {
  const neighbor = document.createElement("div");
  neighbor.className = "card th-device-card mcp-device-card";
  const card = document.createElement("div");
  card.className = "card th-device-card skill-device-card";
  card.dataset.deviceId = "dev-1";
  const container = document.createElement("div");
  container.append(neighbor, card);
  document.body.append(container);
  return { container, neighbor };
}

function deviceCard(rows: string[]): HTMLElement {
  const card = document.createElement("div");
  card.className = "card th-device-card skill-device-card";
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

function mountFocused(container: HTMLElement, focusRow: string): { card: HTMLElement; button: HTMLElement } {
  const card = deviceCard(["skill-a", "skill-b"]);
  container.append(card);
  const button = Array.from(card.querySelectorAll<HTMLElement>(".th-device-profile-row"))
    .find((row) => row.dataset.providerId === focusRow)!
    .querySelector<HTMLElement>("[data-provider-action=copy]")!;
  stubActiveElement(button);
  return { card, button };
}

test("repaintDeviceSkillCard swaps only the skill card and carries the focused row + action", () => {
  const { container, neighbor } = deviceContainer();
  mountFocused(container, "skill-b");

  const focusLog: HTMLElement[] = [];
  const swapped = repaintDeviceSkillCard(container, () => {
    const fresh = deviceCard(["skill-a", "skill-b"]);
    spyFocus(fresh, focusLog);
    return fresh;
  });

  assert.equal(swapped, true);
  assert.equal(container.children[0], neighbor, "sibling MCP card untouched");
  assert.ok(!container.children[1]!.classList.contains("mcp-device-card"));
  const fresh = container.querySelector<HTMLElement>(".th-device-card.skill-device-card")!;
  assert.equal(fresh.querySelectorAll(".th-device-profile-row").length, 2);
  assert.equal(focusLog.length, 1, "exactly one focus restore");
  const focused = focusLog[0]!;
  assert.equal(focused.dataset.providerAction, "copy", "same action re-focused");
  assert.equal(
    focused.closest<HTMLElement>(".th-device-profile-row")?.dataset.providerId,
    "skill-b",
    "same skill row re-focused",
  );
  stubActiveElement(null);
  container.remove();
});

test("repaintDeviceSkillCard drops focus when the focused skill no longer exists", () => {
  const { container, neighbor } = deviceContainer();
  mountFocused(container, "skill-b");

  const focusLog: HTMLElement[] = [];
  const swapped = repaintDeviceSkillCard(container, () => {
    const fresh = deviceCard(["skill-a"]); // skill-b deleted
    spyFocus(fresh, focusLog);
    return fresh;
  });

  assert.equal(swapped, true);
  assert.equal(container.children[0], neighbor);
  assert.equal(focusLog.length, 0, "no stale focus on a wrong row");
  stubActiveElement(null);
  container.remove();
});

test("repaintDeviceSkillCard returns false when the card is not mounted", () => {
  const container = document.createElement("div");
  const card = document.createElement("div");
  card.className = "card th-device-card mcp-device-card";
  container.append(card);
  assert.equal(repaintDeviceSkillCard(container, () => document.createElement("div")), false);
  container.remove();
});
