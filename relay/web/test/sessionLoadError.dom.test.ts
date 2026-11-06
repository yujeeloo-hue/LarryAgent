/**
 * DOM tests: session-load failure view — the centered "Failed to load
 * session." note carries an in-place Retry button (no hard reload needed)
 * and a Back-to-home escape button; each click forwards to its callback
 * exactly once.
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

const { sessionLoadErrorView } = await import("../src/sessionLoadError.js");

test("renders failure note with Retry and Back-to-home buttons", () => {
  const view = sessionLoadErrorView(() => {}, () => {});
  assert.equal(view.className, "empty-note conv-load-error");
  const text = view.querySelector("span");
  assert.equal(text?.textContent, "Failed to load session.");
  const buttons = view.querySelectorAll("button");
  assert.equal(buttons.length, 2, "retry + back-to-home buttons present");
  const [retry, home] = buttons;
  assert.equal(retry?.className, "btn ghost");
  assert.equal(retry?.getAttribute("type"), "button");
  assert.equal(retry?.textContent, "Retry");
  assert.equal(home?.className, "btn ghost");
  assert.equal(home?.getAttribute("type"), "button");
  assert.equal(home?.textContent, "Back to home");
});

test("clicking Retry invokes the retry callback exactly once", () => {
  let calls = 0;
  const view = sessionLoadErrorView(() => {
    calls += 1;
  }, () => {});
  const button = view.querySelector("button")!;
  button.click();
  assert.equal(calls, 1, "one click forwards exactly one retry");
});

test("clicking Back to home invokes the home callback exactly once", () => {
  let retries = 0;
  let homes = 0;
  const view = sessionLoadErrorView(() => {
    retries += 1;
  }, () => {
    homes += 1;
  });
  const home = view.querySelectorAll("button")[1]!;
  home.click();
  assert.equal(homes, 1, "one click forwards exactly one home navigation");
  assert.equal(retries, 0, "home click never triggers a retry");
});

test("view mounts standalone into a container", () => {
  const host = document.createElement("div");
  host.append(sessionLoadErrorView(() => {}, () => {}));
  document.body.append(host);
  assert.equal(document.querySelectorAll(".conv-load-error").length, 1);
});
