import type { DiffLine } from "./diffTypes.js";
import { segmentDiffLines } from "./diffFold.js";
import {
  highlightCodeHtml,
  resolveHighlightLanguage,
} from "./codeHighlight.js";

export type DiffLinedFileViewOptions = {
  pathOrName?: string;
  language?: string;
  /** When false, render every line (default folds long unchanged runs). */
  foldUnchanged?: boolean;
};

function createDiffLineRow(
  line: DiffLine,
  gutterWidth: number,
  language: string | undefined,
): HTMLElement {
  const row = document.createElement("div");
  const classes = [`tool-file-line`, `is-${line.kind}`];
  if (line.kind === "equal") {
    const n = line.oldLine ?? line.newLine ?? 0;
    classes.push(n % 2 === 0 ? "is-even" : "is-odd");
  }
  row.className = classes.join(" ");

  const gutter = document.createElement("span");
  gutter.className = "tool-file-gutter tool-file-gutter-diff";

  const oldG = document.createElement("span");
  oldG.className = "tool-file-gutter-old";
  oldG.textContent =
    line.oldLine !== null
      ? String(line.oldLine).padStart(gutterWidth, " ")
      : " ".repeat(gutterWidth);

  const newG = document.createElement("span");
  newG.className = "tool-file-gutter-new";
  newG.textContent =
    line.newLine !== null
      ? String(line.newLine).padStart(gutterWidth, " ")
      : " ".repeat(gutterWidth);

  const mark = document.createElement("span");
  mark.className = "tool-file-diff-mark";
  mark.textContent =
    line.kind === "add" ? "+" : line.kind === "del" ? "−" : " ";

  gutter.append(oldG, newG, mark);

  const code = document.createElement("span");
  code.className = "tool-file-code hljs";
  code.innerHTML = highlightCodeHtml(
    line.text.length > 0 ? line.text : " ",
    language,
  );

  row.append(gutter, code);
  return row;
}

function foldLabel(count: number): string {
  return count === 1
    ? "⋯ 1 unchanged line"
    : `⋯ ${count} unchanged lines`;
}

const expandedFolds = new WeakMap<HTMLElement, Set<string>>();

/** Serializable expanded-hunk state for offscreen card reconstruction. */
export function captureDiffFoldState(view: HTMLElement): string[] {
  return [...(expandedFolds.get(view) ?? [])];
}

export function restoreDiffFoldState(view: HTMLElement, keys: string[]): void {
  const expanded = new Set(keys);
  for (const button of view.querySelectorAll<HTMLButtonElement>("[data-diff-fold]")) {
    if (expanded.has(button.dataset.diffFold!)) button.click();
  }
}

/** Line-numbered diff: green adds, red deletes; long equal runs are folded. */
export function createDiffLinedFileView(
  lines: DiffLine[],
  options?: DiffLinedFileViewOptions,
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "tool-file-lines tool-file-diff";

  if (lines.length === 0) {
    const empty = document.createElement("div");
    empty.className = "tool-file-line is-empty";
    empty.textContent = "(empty)";
    wrap.append(empty);
    return wrap;
  }

  const language = resolveHighlightLanguage({
    ...(options?.language !== undefined ? { language: options.language } : {}),
    ...(options?.pathOrName !== undefined
      ? { pathOrName: options.pathOrName }
      : {}),
    content: lines.map((l) => l.text).join("\n"),
  });

  const gutterWidth = String(
    Math.max(
      1,
      ...lines.map((l) => l.oldLine ?? 0),
      ...lines.map((l) => l.newLine ?? 0),
    ),
  ).length;

  const foldUnchanged = options?.foldUnchanged !== false;
  const segments = foldUnchanged
    ? segmentDiffLines(lines)
    : [{ type: "lines" as const, lines }];

  for (const segment of segments) {
    if (segment.type === "lines") {
      for (const line of segment.lines) {
        wrap.append(createDiffLineRow(line, gutterWidth, language));
      }
      continue;
    }

    const foldRow = document.createElement("button");
    foldRow.type = "button";
    foldRow.className = "tool-file-line tool-file-fold";
    foldRow.textContent = foldLabel(segment.lines.length);
    foldRow.title = "Show unchanged lines";
    const first = segment.lines[0]!;
    const last = segment.lines[segment.lines.length - 1]!;
    const key = `${first.oldLine}:${first.newLine}-${last.oldLine}:${last.newLine}`;
    foldRow.dataset.diffFold = key;

    foldRow.addEventListener("click", () => {
      let expanded = expandedFolds.get(wrap);
      if (!expanded) expandedFolds.set(wrap, (expanded = new Set()));
      expanded.add(key);
      const frag = document.createDocumentFragment();
      for (const line of segment.lines) {
        frag.append(createDiffLineRow(line, gutterWidth, language));
      }
      foldRow.replaceWith(frag);
    });

    wrap.append(foldRow);
  }

  return wrap;
}
