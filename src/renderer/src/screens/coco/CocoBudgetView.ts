import type { CocoSnapshot } from "../../../../coco/types.js";
import { button, el } from "./dom.js";

type Budget = CocoSnapshot["budget"];
type Limits = Pick<CocoSnapshot["settings"], "hourlyTokens" | "dailyTokens">;
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const exact = new Intl.NumberFormat("en-US");
const tokenCount = (value: number): string => compact.format(value).replace("K", "k");

type BudgetRow = { root: HTMLElement; bar: HTMLProgressElement; percent: HTMLElement; used: HTMLElement; limit: HTMLElement };
function createRow(label: string, accessibleLabel: string): BudgetRow {
  const root = el("div", "coco-budget-row"), bar = el("progress", "coco-budget-bar");
  bar.setAttribute("aria-label", accessibleLabel);
  const percent = el("span", "coco-budget-percent");
  const detail = el("span", "coco-budget-detail"), used = el("span"), limit = el("span");
  detail.append(used, document.createTextNode(" / "), limit, el("span", "coco-budget-unit", " tokens"));
  root.append(el("span", "coco-budget-label", label), bar, percent, detail);
  return { root, bar, percent, used, limit };
}

/** Keep live budget changes independent of the rest of the overview's render key. */
export class CocoBudgetView {
  readonly root = el("div", "coco-budget");
  readonly actions = el("div", "coco-overview-actions");
  private hourly = createRow("This hour", "Tokens used this hour");
  private daily = createRow("Today", "Tokens used today");

  constructor(budget: Budget, limits: Limits, onReset?: () => void) {
    this.root.append(el("h3", "coco-budget-heading", "Token usage"), this.hourly.root, this.daily.root, this.actions);
    if (onReset) {
      const reset = button("Reset budget", onReset);
      reset.classList.add("coco-budget-reset");
      this.actions.append(reset);
    }
    this.update(budget, limits);
  }
  update(budget: Budget, limits: Limits): void {
    this.updateRow(this.hourly, budget.hourly, limits.hourlyTokens, budget.estimated);
    this.updateRow(this.daily, budget.daily, limits.dailyTokens, budget.estimated);
  }
  private updateRow(row: BudgetRow, used: number, limit: number, estimated: boolean): void {
    const percentage = `${(used / limit * 100).toFixed(1)}%`;
    const description = `${exact.format(used)} / ${exact.format(limit)} tokens${estimated ? " · includes estimates" : ""}`;
    // The fill stops at 100%; the text still reports an operation's actual overrun.
    row.bar.setAttribute("max", String(limit));
    row.bar.setAttribute("value", String(Math.max(0, Math.min(used, limit))));
    row.bar.setAttribute("aria-valuetext", `${percentage} · ${description}`);
    row.bar.title = description;
    row.percent.textContent = percentage;
    row.used.textContent = tokenCount(used);
    row.limit.textContent = tokenCount(limit);
  }
}
