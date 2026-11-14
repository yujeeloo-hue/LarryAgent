/**
 * DOM tests: context usage ring (web console) — ring mounting into button
 * wraps, dashoffset painting, threshold/estimate classes, the desktop hover
 * tooltip numbers, plus the provider-only hydration / stream-event mapping
 * and the pure helpers shared with the Mac ring pipeline.
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

const {
  buildContextGauge,
  contextGaugeRatio,
  formatGaugeCacheLabel,
  gaugeValueFromSessionContextUsage,
  gaugeValueFromStreamEvent,
  shouldAcceptGaugeTokens,
} = await import("../src/contextGauge.js");

const CIRCUMFERENCE = 2 * Math.PI * 15.5;

function ringOf(host: HTMLElement): SVGCircleElement {
  return host.querySelector(".context-usage-progress") as SVGCircleElement;
}

test("rings mount into button wraps and paint the ratio via dashoffset", () => {
  const gauge = buildContextGauge(200_000);
  const send = document.createElement("div");
  const stop = document.createElement("div");
  gauge.attachRing(send);
  gauge.attachRing(stop);
  // Re-attach is a no-op — exactly one ring per host.
  gauge.attachRing(send);
  assert.equal(send.querySelectorAll(".context-usage-ring").length, 1);
  assert.equal(stop.querySelectorAll(".context-usage-ring").length, 1);

  // Mac ring geometry: 36-box, r 15, rotated svg hidden from a11y.
  const svg = send.querySelector(".context-usage-ring");
  assert.equal(svg?.getAttribute("viewBox"), "0 0 36 36");
  assert.equal(svg?.getAttribute("aria-hidden"), "true");
  assert.ok(send.querySelector(".context-usage-track"));

  // No reading yet: progress emptied, dashoffset at the full circumference.
  const progress = ringOf(send);
  assert.ok(progress.classList.contains("is-empty"));
  assert.ok(
    Math.abs(Number(progress.getAttribute("stroke-dashoffset")) - CIRCUMFERENCE) < 1e-9,
  );

  gauge.setUsage({ usedTokens: 84_000, source: "provider", cachedTokens: 31_000 });
  assert.equal(progress.classList.contains("is-empty"), false);
  const expected = CIRCUMFERENCE * (1 - 0.42);
  assert.ok(
    Math.abs(Number(progress.getAttribute("stroke-dashoffset")) - expected) < 1e-9,
  );
  // Every mounted ring paints the same offset.
  assert.equal(
    ringOf(stop).getAttribute("stroke-dashoffset"),
    progress.getAttribute("stroke-dashoffset"),
  );

  gauge.setUsage(null);
  assert.ok(progress.classList.contains("is-empty"));
});

test("warning / critical / estimate thresholds repaint ring classes", () => {
  const gauge = buildContextGauge(200_000);
  const host = document.createElement("div");
  gauge.attachRing(host);
  const progress = ringOf(host);

  gauge.setUsage({ usedTokens: 158_000, source: "provider" });
  assert.ok(progress.classList.contains("is-warning"));
  assert.equal(progress.classList.contains("is-critical"), false);

  gauge.setUsage({ usedTokens: 186_000, source: "provider" });
  assert.equal(progress.classList.contains("is-warning"), false);
  assert.ok(progress.classList.contains("is-critical"));

  // Post-compact estimate: grayed-out ring (the one estimate exception).
  gauge.setUsage({ usedTokens: 110_000, source: "estimate" });
  assert.ok(progress.classList.contains("is-estimate"));
  assert.equal(progress.classList.contains("is-warning"), false);
  assert.equal(progress.classList.contains("is-critical"), false);
});

test("tooltip carries raw numbers and threshold footers", () => {
  const gauge = buildContextGauge(200_000);
  const host = document.createElement("div");
  gauge.attachTooltip(host);
  const tip = host.querySelector(".context-usage-tooltip") as HTMLElement;
  assert.equal(tip.getAttribute("role"), "tooltip");

  gauge.setUsage({ usedTokens: 84_000, source: "provider", cachedTokens: 31_000 });
  const rows = [...tip.querySelectorAll(".ctx-tip-row b")].map((n) => n.textContent);
  assert.deepEqual(rows, ["84.0K", "200.0K", "31.0K (37%)"]);
  assert.match(tip.querySelector(".ctx-tip-foot")?.textContent ?? "", /provider usage/);

  gauge.setUsage({ usedTokens: 158_000, source: "provider" });
  assert.match(tip.querySelector(".ctx-tip-foot")?.textContent ?? "", /high context usage/);

  gauge.setUsage({ usedTokens: 186_000, source: "provider" });
  assert.match(tip.querySelector(".ctx-tip-foot")?.textContent ?? "", /near context limit/);

  gauge.setUsage({ usedTokens: 110_000, source: "estimate" });
  assert.equal(tip.querySelector(".ctx-tip-foot")?.textContent, "estimated (post-compact)");

  gauge.setUsage(null);
  assert.deepEqual(
    [...tip.querySelectorAll(".ctx-tip-row b")].map((n) => n.textContent),
    ["—", "200.0K", "—"],
  );
});

test("setLimit repaints the ratio without a new usage", () => {
  const gauge = buildContextGauge(200_000);
  const host = document.createElement("div");
  gauge.attachRing(host);
  gauge.setUsage({ usedTokens: 100_000, source: "provider" });
  const quarter = CIRCUMFERENCE * (1 - 0.5);
  assert.ok(
    Math.abs(Number(ringOf(host).getAttribute("stroke-dashoffset")) - quarter) < 1e-9,
  );
  gauge.setLimit(400_000);
  assert.ok(
    Math.abs(Number(ringOf(host).getAttribute("stroke-dashoffset")) - CIRCUMFERENCE * 0.75) < 1e-9,
  );
  // Non-positive limits are ignored.
  gauge.setLimit(0);
  assert.ok(
    Math.abs(Number(ringOf(host).getAttribute("stroke-dashoffset")) - CIRCUMFERENCE * 0.75) < 1e-9,
  );
});

test("session hydration is provider-only", () => {
  assert.equal(
    gaugeValueFromSessionContextUsage({ usedTokens: 84_000, source: "estimate" }),
    null,
  );
  assert.equal(
    gaugeValueFromSessionContextUsage({ usedTokens: 0, source: "provider" }),
    null,
  );
  assert.deepEqual(
    gaugeValueFromSessionContextUsage({
      usedTokens: 84_000,
      cachedTokens: 31_000,
      source: "provider",
    }),
    { usedTokens: 84_000, cachedTokens: 31_000, source: "provider" },
  );
  // Non-number / missing shapes degrade to null.
  assert.equal(gaugeValueFromSessionContextUsage({}), null);
});

test("context_display events: provider source only", () => {
  assert.equal(
    gaugeValueFromStreamEvent({ type: "context_display", usedTokens: 90_000, source: "estimate" }),
    null,
  );
  assert.deepEqual(
    gaugeValueFromStreamEvent({
      type: "context_display",
      usedTokens: 90_000,
      cachedTokens: 12_000,
      source: "provider",
    }),
    { usedTokens: 90_000, cachedTokens: 12_000, source: "provider" },
  );
  assert.equal(
    gaugeValueFromStreamEvent({ type: "context_display", source: "provider" }),
    null,
  );
});

test("usage events: promptTokens preferred, placeholders ignored", () => {
  assert.deepEqual(
    gaugeValueFromStreamEvent({ type: "usage", promptTokens: 84_000, totalTokens: 90_500 }),
    { usedTokens: 84_000, source: "provider" },
  );
  assert.deepEqual(
    gaugeValueFromStreamEvent({ type: "usage", totalTokens: 90_500 }),
    { usedTokens: 90_500, source: "provider" },
  );
  // Mid-stream placeholder with no positive token count.
  assert.equal(gaugeValueFromStreamEvent({ type: "usage" }), null);
  assert.equal(
    gaugeValueFromStreamEvent({ type: "usage", promptTokens: 0, totalTokens: 0 }),
    null,
  );
});

test("shouldAcceptGaugeTokens keeps a known-good reading against a bare 0", () => {
  assert.equal(shouldAcceptGaugeTokens(84_000, 0), false);
  assert.equal(shouldAcceptGaugeTokens(0, 0), true);
  assert.equal(shouldAcceptGaugeTokens(84_000, 90_000), true);
  assert.equal(shouldAcceptGaugeTokens(84_000, "x"), false);
  assert.equal(shouldAcceptGaugeTokens(84_000, Number.NaN), false);
});

test("ratio clamps and cache label formats", () => {
  assert.equal(contextGaugeRatio(84_000, 200_000), 0.42);
  assert.equal(contextGaugeRatio(300_000, 200_000), 1);
  assert.equal(contextGaugeRatio(0, 200_000), 0);
  assert.equal(contextGaugeRatio(-5, 200_000), 0);
  assert.equal(contextGaugeRatio(50_000, 0), 0);

  assert.equal(formatGaugeCacheLabel(undefined, 84_000), "—");
  assert.equal(formatGaugeCacheLabel(0, 84_000), "—");
  assert.equal(formatGaugeCacheLabel(31_000, 0), "—");
  assert.equal(formatGaugeCacheLabel(31_000, 84_000), "31.0K (37%)");
  // Cache larger than used (stale provider report) clamps to 100%.
  assert.equal(formatGaugeCacheLabel(120_000, 84_000), "120.0K (100%)");
});
