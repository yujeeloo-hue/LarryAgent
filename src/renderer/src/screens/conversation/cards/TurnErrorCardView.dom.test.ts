/**
 * DOM tests: Retry click consumes the error card immediately.
 *
 * Clicking Retry folds the card to its title row and blocks repeat clicks
 * while the resend is in flight; a rejected retry (controller resolves
 * false) restores the pill. The row itself is dropped by the transcript
 * refresh once the resend starts — these tests pin the interim state.
 */
import { parseHTML } from "linkedom";
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  document: dom.document,
  window: dom.window,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  Node: dom.Node,
  SVGElement: dom.SVGElement,
});

type ErrorCardModule = typeof import("./TurnErrorCardView.js");
let createTurnErrorCard: ErrorCardModule["createTurnErrorCard"];
type RetryPayload = ErrorCardModule["TurnErrorRetryPayload"];
type RetryOutcome = ErrorCardModule["RetryOutcome"];

before(async () => {
  ({ createTurnErrorCard } = await import("./TurnErrorCardView.js"));
});

function errorCard(
  onRetry: (payload: RetryPayload) => RetryOutcome,
): { card: HTMLElement; click: () => void } {
  const payload: RetryPayload = { text: "go", attachments: [] };
  const card = createTurnErrorCard({
    text: "upstream 502",
    retry: payload,
    onRetry,
  });
  const btn = card.querySelector<HTMLButtonElement>(
    ".content-card-error-retry",
  )!;
  return {
    card,
    click: () =>
      btn.dispatchEvent(new dom.window.Event("click", { bubbles: true })),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createTurnErrorCard retry click", () => {
  it("collapses immediately on click and stays consumed on success", async () => {
    const { card, click } = errorCard(() => true);
    assert.ok(card.querySelector(".content-card-error-body"));
    click();
    assert.equal(card.classList.contains("is-consumed"), true);
    assert.equal(
      card.querySelector<HTMLButtonElement>(".content-card-error-retry")!
        .disabled,
      true,
    );
    await settle();
    await settle();
    assert.equal(card.classList.contains("is-consumed"), true);
  });

  it("restores the pill when the retry is rejected", async () => {
    const { card, click } = errorCard(() => false);
    click();
    assert.equal(card.classList.contains("is-consumed"), true);
    await settle();
    await settle();
    assert.equal(card.classList.contains("is-consumed"), false);
    assert.equal(
      card.querySelector<HTMLButtonElement>(".content-card-error-retry")!
        .disabled,
      false,
    );
  });

  it("ignores a second click while the retry is in flight", async () => {
    let calls = 0;
    const { card, click } = errorCard(() => {
      calls += 1;
      return new Promise((resolve) => setTimeout(() => resolve(true), 5));
    });
    click();
    click();
    await settle();
    await settle();
    assert.equal(calls, 1);
    assert.equal(card.classList.contains("is-consumed"), true);
  });

  it("renders no pill when no retry payload exists", () => {
    const card = createTurnErrorCard({ text: "502" });
    assert.equal(card.querySelector(".content-card-error-retry"), null);
  });
});

describe("createTurnErrorCard setup wizard entry", () => {
  // Presence only — clicking the pill lazy-imports the wizard module chain
  // (CSS + raw SVG imports), which node/tsx cannot load; the app bundles it.
  it("renders the wizard pill on missing-key errors", () => {
    const card = createTurnErrorCard({
      text:
        'Missing API key for provider "DeepSeek". Add it in Setting or .env JELLYBOT_API_KEY.',
      retry: { text: "go", attachments: [] },
      onRetry: () => true,
    });
    assert.ok(card.querySelector(".content-card-error-setup"));
    assert.ok(card.querySelector(".content-card-error-retry"));
  });

  it("renders the wizard pill even without a retry payload", () => {
    const card = createTurnErrorCard({
      text: 'Missing API key for provider "OpenAI"',
    });
    assert.ok(card.querySelector(".content-card-error-setup"));
  });

  it("renders no wizard pill for other failures", () => {
    const card = createTurnErrorCard({
      text: "upstream 502",
      retry: { text: "go", attachments: [] },
      onRetry: () => true,
    });
    assert.equal(card.querySelector(".content-card-error-setup"), null);
  });
});
