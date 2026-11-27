import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module from "node:module";
import test from "node:test";
import { parseHTML } from "linkedom";

(Module as unknown as { _extensions: Record<string, () => void> })._extensions[".css"] = () => {};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request.includes("?raw")) return "";
  if (request.includes("?url")) return request.slice(0, request.indexOf("?url"));
  return originalLoad.call(this, request, parent, isMain);
};
const dom = parseHTML("<!doctype html><html><body></body></html>");

let queued: Array<() => void> = [];
Object.assign(globalThis, {
  document: dom.document,
  window: dom.window,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.window.Event,
  MutationObserver: dom.window.MutationObserver,
  ResizeObserver: class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  },
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  requestAnimationFrame: (callback: (time: number) => void) => {
    queued.push(() => callback(0));
    return queued.length;
  },
  cancelAnimationFrame: () => {
    queued = [];
  },
});
Object.assign(dom.window, { jellybot: { onRemoteStatus: () => () => {} } });

import { bindScrollFade, syncScrollFade } from "./scrollFade.js";
import { WorkspaceSectionView } from "../sidebar/WorkspaceSectionView.js";
import { ArchivedProjectsView } from "../sidebar/ArchivedProjectsView.js";
import type { CocoViewHandlers } from "../screens/coco/CocoView.js";

const TOP_CLASS = "is-fade-top";
const BOTTOM_CLASS = "is-fade-bottom";

function flushFrames(): void {
  const pending = queued;
  queued = [];
  for (const run of pending) run();
}

function scrollerWith(scrollHeight: number, clientHeight: number): HTMLElement {
  const el = document.createElement("div");
  el.scrollTop = 0;
  Object.defineProperty(el, "scrollHeight", {
    value: scrollHeight,
    configurable: true,
  });
  Object.defineProperty(el, "clientHeight", {
    value: clientHeight,
    configurable: true,
  });
  return el;
}

function primeScroller(el: HTMLElement): void {
  el.scrollTop = 0;
  Object.defineProperty(el, "scrollHeight", { value: 900, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: 400, configurable: true });
  el.dispatchEvent(new dom.window.Event("scroll"));
  flushFrames();
}

test("fade tracks both edges of the scroll port", () => {
  const el = scrollerWith(900, 400);

  el.scrollTop = 0;
  syncScrollFade(el);
  assert.equal(el.classList.contains(BOTTOM_CLASS), true, "bottom on at the top");
  assert.equal(el.classList.contains(TOP_CLASS), false, "top off at the top");

  el.scrollTop = 300;
  syncScrollFade(el);
  assert.equal(el.classList.contains(BOTTOM_CLASS), true, "bottom on mid-list");
  assert.equal(el.classList.contains(TOP_CLASS), true, "top on mid-list");

  el.scrollTop = 500;
  syncScrollFade(el);
  assert.equal(el.classList.contains(BOTTOM_CLASS), false, "bottom off at the end");
  assert.equal(el.classList.contains(TOP_CLASS), true, "top on at the end");
});

test("fade ignores sub-pixel slack and fits entirely", () => {
  const slack = scrollerWith(402, 400);
  slack.scrollTop = 0;
  syncScrollFade(slack);
  assert.equal(slack.classList.contains(BOTTOM_CLASS), false, "2px is not overflow");

  const overflowing = scrollerWith(403, 400);
  overflowing.scrollTop = 0;
  syncScrollFade(overflowing);
  assert.equal(overflowing.classList.contains(BOTTOM_CLASS), true, "3px overflows");

  const fits = scrollerWith(300, 400);
  syncScrollFade(fits);
  assert.equal(fits.classList.contains(BOTTOM_CLASS), false, "short list never fades");
  assert.equal(fits.classList.contains(TOP_CLASS), false, "short list has no top fade");

  const nudged = scrollerWith(900, 400);
  nudged.scrollTop = 2;
  syncScrollFade(nudged);
  assert.equal(nudged.classList.contains(TOP_CLASS), false, "2px of scroll is slack");
});

test("binding follows scrolling and stops after dispose", () => {
  const el = scrollerWith(900, 400);
  const dispose = bindScrollFade(el);
  assert.equal(el.classList.contains(BOTTOM_CLASS), true, "primed on bind");
  assert.equal(el.classList.contains(TOP_CLASS), false, "primed without top fade");

  el.scrollTop = 500;
  el.dispatchEvent(new dom.window.Event("scroll"));
  flushFrames();
  assert.equal(el.classList.contains(BOTTOM_CLASS), false, "scroll to end clears bottom");
  assert.equal(el.classList.contains(TOP_CLASS), true, "scroll to end raises top");

  el.scrollTop = 120;
  el.dispatchEvent(new dom.window.Event("scroll"));
  flushFrames();
  assert.equal(el.classList.contains(BOTTOM_CLASS), true, "scroll back restores bottom");
  assert.equal(el.classList.contains(TOP_CLASS), true, "scroll back keeps top");

  el.scrollTop = 0;
  el.dispatchEvent(new dom.window.Event("scroll"));
  flushFrames();
  assert.equal(el.classList.contains(TOP_CLASS), false, "back at top clears top");

  dispose();
  assert.equal(el.classList.contains(BOTTOM_CLASS), false, "dispose clears the mask");
  assert.equal(el.classList.contains(TOP_CLASS), false, "dispose clears the top mask");

  el.scrollTop = 120;
  el.dispatchEvent(new dom.window.Event("scroll"));
  flushFrames();
  assert.equal(el.classList.contains(BOTTOM_CLASS), false, "disposed binding is inert");
  assert.equal(el.classList.contains(TOP_CLASS), false, "disposed binding stays inert");
});

test("sidebar lists bind the fade to their scroll body", () => {
  const workspaceView = new WorkspaceSectionView();
  const workspaceBody =
    workspaceView.root.querySelector<HTMLElement>(".sidebar-section-body");
  assert.ok(workspaceBody, "workspace section renders a scroll body");
  workspaceBody.scrollTop = 0;
  Object.defineProperty(workspaceBody, "scrollHeight", {
    value: 900,
    configurable: true,
  });
  Object.defineProperty(workspaceBody, "clientHeight", {
    value: 400,
    configurable: true,
  });
  workspaceBody.dispatchEvent(new dom.window.Event("scroll"));
  flushFrames();
  assert.equal(workspaceBody.classList.contains(BOTTOM_CLASS), true);

  const archivedView = new ArchivedProjectsView();
  const archivedBody =
    archivedView.root.querySelector<HTMLElement>(".sidebar-section-body");
  assert.ok(archivedBody, "archived section renders a scroll body");
  archivedBody.scrollTop = 0;
  Object.defineProperty(archivedBody, "scrollHeight", {
    value: 900,
    configurable: true,
  });
  Object.defineProperty(archivedBody, "clientHeight", {
    value: 400,
    configurable: true,
  });
  archivedBody.dispatchEvent(new dom.window.Event("scroll"));
  flushFrames();
  assert.equal(archivedBody.classList.contains(BOTTOM_CLASS), true);
});

test("page content panes fade both edges with the shared utility", async () => {
  const { ToolsView } = await import("../screens/tools/ToolsView.js");
  const { SettingView } = await import("../screens/setting/SettingView.js");
  const { CocoView } = await import("../screens/coco/CocoView.js");
  const handlers: CocoViewHandlers = {
    command: async () => {},
    act: () => {},
    focusComposer: () => {},
    chatToggled: () => {},
    workFocused: () => {},
    removeReference: () => {},
    loadHistory: () => {},
    deleteRule: () => {},
    enable: async () => {},
    retry: () => {},
    sessionSelect: () => {},
    reportsViewed: () => {},
  };

  const panes: Array<[string, HTMLElement]> = [];
  const tools = new ToolsView();
  panes.push([".tools-content", tools.root.querySelector<HTMLElement>(".tools-content")!]);
  const settings = new SettingView();
  panes.push([".setting-content", settings.root.querySelector<HTMLElement>(".setting-content")!]);
  const coco = new CocoView(handlers, false);
  const cocoRoot = (coco as unknown as { root: HTMLElement }).root;
  panes.push([".coco-main", cocoRoot.querySelector<HTMLElement>(".coco-main")!]);

  for (const [selector, pane] of panes) {
    assert.ok(pane, `${selector} renders a scroll pane`);
    assert.equal(pane.classList.contains("scroll-fade"), true, `${selector} opts into the fade`);
    primeScroller(pane);
    assert.equal(pane.classList.contains(BOTTOM_CLASS), true, `${selector} fades the bottom`);
    pane.scrollTop = 200;
    pane.dispatchEvent(new dom.window.Event("scroll"));
    flushFrames();
    assert.equal(pane.classList.contains(TOP_CLASS), true, `${selector} fades the top once scrolled`);
  }
  coco.destroy();
});

test("the shared fade utility stays mask-only", () => {
  const css = readFileSync(new URL("../styles/shell.css", import.meta.url), "utf8");
  const mask = css.match(/\.scroll-fade\.is-fade-top,\s*\.scroll-fade\.is-fade-bottom\s*\{([^}]*)\}/)?.[1];
  assert.ok(mask, "shared mask rule present");
  assert.match(mask, /mask-image:\s*linear-gradient\(/);
  assert.match(mask, /var\(--scroll-fade-top\)/);
  assert.match(mask, /var\(--scroll-fade-bottom\)/);
  assert.doesNotMatch(mask, /background/);

  const base = css.match(/\n\.scroll-fade\s*\{([^}]*)\}/)?.[1];
  assert.ok(base, "base token block present");
  assert.match(base, /--scroll-fade-h:\s*28px/);
  assert.match(base, /--scroll-fade-top:\s*0px/);
  assert.match(base, /--scroll-fade-bottom:\s*100%/);
});

test("sidebar shell keeps the fade mask-only so transparency survives", () => {
  const css = readFileSync(
    new URL("../styles/shell.css", import.meta.url),
    "utf8",
  );
  const mask = css.match(
    /\.sidebar-section-body\.is-fade-top,\s*\.sidebar-section-body\.is-fade-bottom\s*\{([^}]*)\}/,
  )?.[1];
  assert.ok(mask, "mask rule present");
  assert.match(mask, /--sidebar-scroll-fade-top\)/);
  assert.match(mask, /--sidebar-scroll-fade-bottom\)/);
  assert.match(mask, /mask-image:\s*linear-gradient\(/);
  assert.doesNotMatch(mask, /background/);

  const top = css.match(
    /\.sidebar-section-body\.is-fade-top\s*\{([^}]*)\}/,
  )?.[1];
  assert.ok(top, "top state rule present");
  assert.match(top, /--sidebar-scroll-fade-top:\s*var\(--sidebar-scroll-fade-h\)/);

  const bottom = css.match(
    /\.sidebar-section-body\.is-fade-bottom\s*\{([^}]*)\}/,
  )?.[1];
  assert.ok(bottom, "bottom state rule present");
  assert.match(
    bottom,
    /--sidebar-scroll-fade-bottom:\s*calc\(100% - var\(--sidebar-scroll-fade-h\)\)/,
  );
});
