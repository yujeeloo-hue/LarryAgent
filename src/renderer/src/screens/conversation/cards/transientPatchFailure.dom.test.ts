/** DOM tests: failed Patch results remain visible and collapse their diagnostics. */
import { parseHTML } from "linkedom";
import { before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

(
  Module as unknown as { _extensions: Record<string, () => void> }
)._extensions[".css"] = () => {};

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  document: dom.document,
  window: dom.window,
  HTMLElement: dom.HTMLElement,
  HTMLDetailsElement: dom.HTMLDetailsElement,
  Node: dom.Node,
  SVGElement: dom.SVGElement,
});

type CardModule = typeof import("./ToolInvocationCardView.js");
type OutcomeModule = typeof import("./ToolOutcomeBadge.js");
type ResourcesModule = typeof import("./cardResources.js");
let createToolInvocationCard: CardModule["createToolInvocationCard"];
let armLiveOutcomeFade: OutcomeModule["armLiveOutcomeFade"];
let disposeCardResources: ResourcesModule["disposeCardResources"];
let setVirtualToolCardOpen: typeof import("./virtualToolCard.js")["setVirtualToolCardOpen"];

before(async () => {
  createToolInvocationCard = (await import("./ToolInvocationCardView.js"))
    .createToolInvocationCard;
  armLiveOutcomeFade = (await import("./ToolOutcomeBadge.js"))
    .armLiveOutcomeFade;
  disposeCardResources = (await import("./cardResources.js"))
    .disposeCardResources;
  ({ setVirtualToolCardOpen } = await import("./virtualToolCard.js"));
});

const FAILURE_TEXT = [
  "PATCH FAILED — old_string not found in /tmp/a.ts.",
  "10| const before = true;",
  "11| const stale = true;",
  "12| const after = true;",
].join("\n");

function finishedPatch(returnCode: number): HTMLElement {
  return createToolInvocationCard({
    id: "call-patch",
    name: "patch",
    status: "done",
    arguments: { path: "/tmp/a.ts", old_string: "stale", new_string: "fresh" },
    argumentsRaw: "{}",
    result: {
      returnCode,
      content: [{
        type: "text",
        text: returnCode === 0 ? "PATCH APPLIED — /tmp/a.ts" : FAILURE_TEXT,
      }],
    },
  });
}

describe("persistent collapsed Patch failure", () => {
  it("keeps the running Patch streaming preview rich and expanded", () => {
    const slot = createToolInvocationCard({
      id: "call-stream",
      name: "patch",
      status: "running",
      arguments: { path: "/tmp/a.ts", old_string: "stale", new_string: "fresh" },
      argumentsRaw: "{}",
      previewContent: "const fresh = true;",
    });
    const card = slot.firstElementChild as HTMLDetailsElement;
    assert.equal(slot.dataset.toolStreaming, "1");
    assert.equal(card.tagName, "DETAILS");
    assert.ok(card.classList.contains("is-rich"));
    assert.ok(card.querySelector(".tool-file-lines"));
    assert.match(card.textContent ?? "", /const fresh/);
  });

  it("history keeps a visible collapsed card with expandable diagnostics", () => {
    const slot = finishedPatch(1);
    const card = slot.firstElementChild as HTMLElement;
    assert.equal(slot.hidden, false);
    assert.equal(card.tagName, "DETAILS");
    assert.ok(!card.hasAttribute("open"), "failure starts collapsed");
    assert.ok(card.classList.contains("is-error"));
    assert.ok(card.querySelector(".content-card-tool-result-chevron"));
    assert.equal(card.querySelector(".content-card-tool-invocation-body"), null);
    assert.match(card.textContent ?? "", /Failed · No changes applied/);
    setVirtualToolCardOpen(slot, true);
    assert.match(card.querySelector(".content-card-tool-invocation-body")?.textContent ?? "", /PATCH FAILED/);
  });

  it("live failure stays visible after 3s and keeps user expansion", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const row = document.createElement("article");
      row.className = "conversation-msg";
      const body = document.createElement("div");
      body.className = "conversation-msg-body";
      const slot = finishedPatch(1);
      body.append(slot);
      row.append(body);
      document.body.replaceChildren(row);

      armLiveOutcomeFade(slot);
      const card = slot.firstElementChild as HTMLElement;
      assert.equal(slot.hidden, false);
      assert.ok(!card.hasAttribute("open"), "failure starts collapsed");
      setVirtualToolCardOpen(slot, true);
      mock.timers.tick(6000);
      assert.equal(slot.parentNode, body, "failure card persists");
      assert.equal(row.parentNode, document.body);
      assert.equal((card as HTMLDetailsElement).open, true, "user can inspect diagnostics");
    } finally {
      mock.timers.reset();
      document.body.replaceChildren();
    }
  });

  it("card disposal still cancels the success badge fade", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const slot = finishedPatch(0);
      const badge = slot.querySelector(".content-card-tool-outcome.is-ok")!;
      document.body.replaceChildren(slot);
      armLiveOutcomeFade(slot);
      disposeCardResources(slot);
      mock.timers.tick(3000);
      assert.equal(
        slot.parentNode === document.body,
        true,
        "a disposed virtual card stays in place",
      );
      assert.ok(!badge.classList.contains("is-faded"), "disposed badge has no stale timer");
    } finally {
      mock.timers.reset();
      document.body.replaceChildren();
    }
  });

  it("successful Patch cards keep their normal rich result", () => {
    const slot = finishedPatch(0);
    const card = slot.firstElementChild as HTMLDetailsElement;
    assert.equal(slot.hidden, false);
    assert.equal(card.tagName, "DETAILS");
    assert.ok(card.querySelector(".content-card-tool-invocation-body"));
  });
});
