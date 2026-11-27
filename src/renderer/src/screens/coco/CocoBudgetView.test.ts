import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import { CocoBudgetView } from "./CocoBudgetView.js";

const { document } = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { document });
const limits = { hourlyTokens: 200000, dailyTokens: 1000000 };
const budget = { hourly: 176000, daily: 428000, estimated: false };

test("hourly and daily quantities follow percentages with consistent precision", () => {
  const view = new CocoBudgetView(budget, limits);
  assert.deepEqual([...view.root.querySelectorAll('.coco-budget-percent')].map(node => node.textContent), ["88.0%", "42.8%"]);
  assert.deepEqual([...view.root.querySelectorAll('.coco-budget-detail')].map(node => node.textContent), ["176k / 200k tokens", "428k / 1M tokens"]);
  const row = view.root.querySelector('.coco-budget-row')!;
  assert.ok(row.querySelector('.coco-budget-percent')!.nextElementSibling!.classList.contains('coco-budget-detail'));
});
test("small live increments and changed limits update existing bars", () => {
  const view = new CocoBudgetView({ ...budget, hourly: 32000 }, limits);
  const bar = view.root.querySelector('progress')!;
  view.update({ ...budget, hourly: 32200 }, limits);
  assert.equal(view.root.querySelector('progress'), bar);
  assert.equal(bar.getAttribute('value'), '32200');
  assert.equal(view.root.querySelector('.coco-budget-percent')!.textContent, '16.1%');
  view.update({ ...budget, hourly: 32200 }, { ...limits, hourlyTokens: 100000 });
  assert.equal(bar.getAttribute('max'), '100000');
  assert.equal(view.root.querySelector('.coco-budget-percent')!.textContent, '32.2%');
});
test("reset budget asks to continue without changing the bars itself", () => {
  let resets = 0;
  const view = new CocoBudgetView({ ...budget, hourly: 250000 }, limits, () => { resets++; });
  const reset = view.root.querySelector(".coco-budget-reset") as HTMLButtonElement;
  assert.equal(reset.textContent, "Reset budget");
  reset.click();
  assert.equal(resets, 1);
  assert.equal(view.root.querySelector(".coco-budget-percent")!.textContent, "125.0%");
});
test("over-budget and estimated usage retain truthful amounts", () => {
  const view = new CocoBudgetView({ ...budget, hourly: 250000, estimated: true }, limits);
  const bar = view.root.querySelector('progress')!;
  assert.equal(bar.getAttribute('value'), '200000');
  assert.match(bar.getAttribute('aria-valuetext')!, /125\.0%.*250,000 \/ 200,000 tokens.*includes estimates/);
  assert.equal(view.root.querySelector('.coco-budget-detail')!.textContent, '250k / 200k tokens');
  assert.equal(view.root.querySelector('.coco-budget-estimate'), null);
  view.update({ hourly: 0, daily: 0, estimated: false }, limits);
  assert.equal(bar.getAttribute('value'), '0');
  assert.equal(view.root.querySelector('.coco-budget-percent')!.textContent, '0.0%');
  assert.equal(view.root.querySelector('.coco-budget-estimate'), null);
});
