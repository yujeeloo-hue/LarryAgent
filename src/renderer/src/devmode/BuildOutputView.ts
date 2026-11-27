import type { BuildLogEntry, BuildLogModel } from "./buildLogModel.js";
import { measureMono, visualColumns, wrappedRows, type MonoMetrics } from "./monoMetrics.js";
import { VirtualList } from "./virtualList.js";

const INSET_Y = 10;
const DIVIDER_HEIGHT = 13;
const FALLBACK_METRICS: MonoMetrics = { charWidth: 7, lineHeight: 17 };

export class BuildOutputView {
  readonly root = document.createElement("div");
  private readonly list: VirtualList;
  private readonly columns = new WeakMap<BuildLogEntry, { rev: number; cols: number }>();
  private metrics = FALLBACK_METRICS;

  constructor(private readonly model: BuildLogModel) {
    this.root.className = "devmode-panel-build-output";
    this.root.setAttribute("role", "region");
    this.root.setAttribute("aria-label", "Build output");
    this.list = new VirtualList(this.root, {
      count: () => model.length,
      key: (i) => model.at(i).id,
      version: (i) => model.at(i).rev,
      type: (i) => (model.at(i).kind === "divider" ? "divider" : "line"),
      create: (type) => this.createRow(type),
      bind: (el, i) => this.bindRow(el, model.at(i)),
      estimate: (i, width) => this.estimate(model.at(i), width),
      remeasure: () => {
        this.metrics = measureMono(this.root, FALLBACK_METRICS);
      },
    }, { followTail: true, insetTop: INSET_Y, insetBottom: INSET_Y });
    model.onChange(() => this.list.invalidate());
  }

  destroy(): void {
    this.model.onChange(null);
    this.list.destroy();
  }

  private createRow(type: string): HTMLElement {
    const el = document.createElement("span");
    if (type === "divider") {
      el.className = "terminal-pane-divider";
      el.setAttribute("role", "separator");
      el.setAttribute("aria-hidden", "true");
    }
    return el;
  }

  private bindRow(el: HTMLElement, entry: BuildLogEntry): void {
    if (entry.kind === "divider") return;
    el.className = `terminal-pane-chunk is-${entry.kind}`;
    el.textContent = entry.text;
    if (entry.tone) el.dataset.buildTone = entry.tone;
    else el.removeAttribute("data-build-tone");
  }

  private estimate(entry: BuildLogEntry, width: number): number {
    if (entry.kind === "divider") return DIVIDER_HEIGHT;
    let cached = this.columns.get(entry);
    if (!cached || cached.rev !== entry.rev) {
      cached = { rev: entry.rev, cols: visualColumns(entry.text) };
      this.columns.set(entry, cached);
    }
    return wrappedRows(cached.cols, width, this.metrics.charWidth) * this.metrics.lineHeight;
  }
}
