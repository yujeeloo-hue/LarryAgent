import type { SideBySideRow } from "./cards/sideBySidePair.js";

export type ChangesRailKind = "add" | "remove" | "modify";

/** One marker on the changes rail. `top` / `height` are fractions of the rendered row list. */
export type ChangesRailHunk = {
  index: number;
  kind: ChangesRailKind;
  row: number;
  rowCount: number;
  added: number;
  removed: number;
  startLine: number;
  endLine: number;
  sample: string;
  top: number;
  height: number;
};

export function planChangesRail(rows: readonly SideBySideRow[]): ChangesRailHunk[] {
  const total = Math.max(1, rows.length);
  const hunks: ChangesRailHunk[] = [];
  let index = 0;
  while (index < rows.length) {
    const first = rows[index]!;
    if (first.kind !== "change") {
      index += 1;
      continue;
    }
    let end = index;
    let added = 0;
    let removed = 0;
    let sample = "";
    const newLines: number[] = [];
    const oldLines: number[] = [];
    while (end < rows.length) {
      const row = rows[end]!;
      if (row.kind !== "change") break;
      if (row.right && row.right.kind === "add") {
        added += 1;
        if (!sample) sample = row.right.text;
      }
      if (row.left && row.left.kind === "del") {
        removed += 1;
        if (!sample) sample = row.left.text;
      }
      if (row.right?.newLine !== null && row.right?.newLine !== undefined) newLines.push(row.right.newLine);
      if (row.left?.oldLine !== null && row.left?.oldLine !== undefined) oldLines.push(row.left.oldLine);
      end += 1;
    }
    const rowCount = end - index;
    const lines = newLines.length > 0 ? newLines : oldLines;
    hunks.push({
      index: hunks.length,
      kind: added && removed ? "modify" : added ? "add" : "remove",
      row: index,
      rowCount,
      added,
      removed,
      startLine: lines[0] ?? 0,
      endLine: lines[lines.length - 1] ?? 0,
      sample,
      top: index / total,
      height: rowCount / total,
    });
    index = end;
  }
  return hunks;
}

export type ChangesRailOptions = {
  rail: HTMLElement;
  scroller: HTMLElement;
  /** Element that owns the rendered rows (`.tool-file-sbs`); resolved on demand. */
  getRowsHost: () => HTMLElement | null;
};

export type ChangesRailBinding = {
  render(hunks: readonly ChangesRailHunk[]): void;
  dispose(): void;
};

const HIT_CLASS = "is-rail-hit";
const HIT_MS = 1400;

const pct = (fraction: number): string => `${(fraction * 100).toFixed(4)}%`;

function label(hunk: ChangesRailHunk): string {
  const span = hunk.startLine === hunk.endLine ? `L${hunk.startLine}` : `L${hunk.startLine}–${hunk.endLine}`;
  const parts = [span];
  if (hunk.added) parts.push(`+${hunk.added}`);
  if (hunk.removed) parts.push(`−${hunk.removed}`);
  return parts.join(" ");
}

export function mountChangesRail(options: ChangesRailOptions): ChangesRailBinding {
  const { rail, scroller } = options;
  const doc = rail.ownerDocument;

  const card = doc.createElement("div");
  card.className = "workspace-changes-rail-card";
  const head = doc.createElement("div");
  head.className = "workspace-changes-rail-card-head";
  const lines = doc.createElement("span");
  const added = doc.createElement("span");
  added.className = "is-add";
  const removed = doc.createElement("span");
  removed.className = "is-remove";
  const sample = doc.createElement("code");
  sample.className = "workspace-changes-rail-card-code";
  head.append(lines, added, removed);
  card.append(head, sample);
  rail.replaceChildren(card);

  let marks: HTMLElement[] = [];
  let flashTimer: ReturnType<typeof setTimeout> | null = null;

  // The rail hugs the right edge of the code but must leave the native scrollbar alone.
  const syncOffset = (): void => {
    const scrollbar = scroller.offsetWidth - scroller.clientWidth;
    rail.style.right = `${Number.isFinite(scrollbar) && scrollbar > 0 ? scrollbar : 0}px`;
  };

  const rowCells = (row: number): HTMLElement[] => {
    const host = options.getRowsHost();
    if (!host) return [];
    const cells: HTMLElement[] = [];
    for (const pane of Array.from(host.querySelectorAll(".tool-file-sbs-pane"))) {
      const cell = (pane as Element).children[row] as HTMLElement | undefined;
      if (cell) cells.push(cell);
    }
    return cells;
  };

  const highlight = (hunk: ChangesRailHunk | null): void => {
    const host = options.getRowsHost();
    if (!host) return;
    for (const cell of Array.from(host.querySelectorAll(`.${HIT_CLASS}`))) {
      cell.classList.remove(HIT_CLASS);
    }
    if (!hunk) return;
    for (let row = hunk.row; row < hunk.row + hunk.rowCount; row += 1) {
      for (const cell of rowCells(row)) cell.classList.add(HIT_CLASS);
    }
  };

  const placeCard = (mark: HTMLElement, hunk: ChangesRailHunk): void => {
    card.style.top = pct(hunk.top + hunk.height / 2);
    card.style.transform = "translateY(-50%)";
    const railHeight = rail.clientHeight;
    const cardHeight = card.offsetHeight;
    if (!railHeight || !cardHeight) return;
    const center = mark.offsetTop + mark.offsetHeight / 2;
    let shift = 0;
    if (center - cardHeight / 2 < 0) shift = -center + cardHeight / 2;
    else if (center + cardHeight / 2 > railHeight) shift = railHeight - center - cardHeight / 2;
    if (shift) card.style.transform = `translateY(calc(-50% + ${shift.toFixed(1)}px))`;
  };

  const show = (hunk: ChangesRailHunk, mark: HTMLElement): void => {
    lines.textContent = hunk.startLine === hunk.endLine
      ? `L${hunk.startLine}`
      : `L${hunk.startLine}–${hunk.endLine}`;
    added.textContent = hunk.added ? `+${hunk.added}` : "";
    removed.textContent = hunk.removed ? `−${hunk.removed}` : "";
    const text = hunk.sample.trim();
    sample.textContent = text.length > 46 ? `${text.slice(0, 46)}…` : text;
    placeCard(mark, hunk);
    card.classList.add("is-visible");
    highlight(hunk);
  };

  const hide = (): void => {
    card.classList.remove("is-visible");
    highlight(null);
  };

  const jump = (hunk: ChangesRailHunk): void => {
    const cells = rowCells(hunk.row);
    const target = cells[0] ?? null;
    const cellRect = target?.getBoundingClientRect?.();
    const hostRect = scroller.getBoundingClientRect?.();
    const centered = cellRect && hostRect && Number.isFinite(cellRect.top) && Number.isFinite(hostRect.top)
      ? scroller.scrollTop + (cellRect.top - hostRect.top) - Math.max(0, (scroller.clientHeight - cellRect.height) / 2)
      : hunk.top * scroller.scrollHeight;
    scroller.scrollTo?.({ top: Number.isFinite(centered) ? Math.max(0, centered) : 0, behavior: "smooth" });
    highlight(hunk);
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      flashTimer = null;
      hide();
    }, HIT_MS);
  };

  const render = (hunks: readonly ChangesRailHunk[]): void => {
    hide();
    for (const mark of marks) mark.remove();
    marks = [];
    rail.hidden = hunks.length === 0;
    if (!hunks.length) return;
    syncOffset();
    for (const hunk of hunks) {
      const mark = doc.createElement("button");
      mark.type = "button";
      mark.className = `workspace-changes-rail-mark is-${hunk.kind}`;
      mark.style.top = pct(hunk.top);
      mark.style.height = pct(hunk.height);
      mark.setAttribute("aria-label", label(hunk));
      mark.addEventListener("mouseenter", () => show(hunk, mark));
      mark.addEventListener("focus", () => show(hunk, mark));
      mark.addEventListener("mouseleave", hide);
      mark.addEventListener("blur", hide);
      mark.addEventListener("click", () => jump(hunk));
      rail.appendChild(mark);
      marks.push(mark);
    }
  };

  const resizeObserver = typeof ResizeObserver === "function"
    ? new ResizeObserver(() => syncOffset())
    : null;
  resizeObserver?.observe(scroller);

  return {
    render,
    dispose: () => {
      if (flashTimer) clearTimeout(flashTimer);
      flashTimer = null;
      resizeObserver?.disconnect();
      for (const mark of marks) mark.remove();
      marks = [];
      highlight(null);
      card.remove();
    },
  };
}
