import type { DiffLine } from "./diffTypes.js";
import {
  buildSideBySideSegments,
  pairSideBySideRows,
} from "./sideBySidePair.js";
import {
  highlightCodeHtml,
  resolveHighlightLanguage,
} from "./codeHighlight.js";

export type SideBySideFileViewOptions = {
  pathOrName?: string;
  language?: string;
  /** When false, render every line (default folds long unchanged runs). */
  foldUnchanged?: boolean;
};

function createCell(
  line: DiffLine | null,
  side: "old" | "new",
  gutterWidth: number,
  language: string | undefined,
): HTMLElement {
  const cell = document.createElement("div");
  const classes = ["tool-file-sbs-cell"];

  if (line === null) {
    classes.push("is-empty");
  } else if (line.kind === "del") {
    classes.push("is-del");
  } else if (line.kind === "add") {
    classes.push("is-add");
  } else {
    const n = (side === "old" ? line.oldLine : line.newLine) ?? 0;
    classes.push(n % 2 === 0 ? "is-even" : "is-odd");
  }
  cell.className = classes.join(" ");

  const num = document.createElement("span");
  num.className = "tool-file-sbs-num";
  const no =
    line === null
      ? ""
      : side === "old"
        ? line.oldLine !== null
          ? String(line.oldLine)
          : ""
        : line.newLine !== null
          ? String(line.newLine)
          : "";
  num.textContent = no ? no.padStart(gutterWidth, " ") : " ".repeat(gutterWidth);

  const code = document.createElement("span");
  code.className = "tool-file-sbs-code hljs";
  if (line === null) {
    code.textContent = " ";
  } else {
    code.innerHTML = highlightCodeHtml(
      line.text.length > 0 ? line.text : " ",
      language,
    );
  }

  cell.append(num, code);
  return cell;
}

function foldLabel(count: number): string {
  return count === 1
    ? "⋯ 1 unchanged line"
    : `⋯ ${count} unchanged lines`;
}

/** Twin fold buttons (one per pane) that expand together on click. */
function createFoldRowPair(
  lines: DiffLine[],
  gutterWidth: number,
  language: string | undefined,
): { left: HTMLButtonElement; right: HTMLButtonElement } {
  const make = (): HTMLButtonElement => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tool-file-fold tool-file-sbs-fold";
    btn.textContent = foldLabel(lines.length);
    btn.title = "Show unchanged lines";
    return btn;
  };
  const left = make();
  const right = make();

  const expand = (): void => {
    const fragLeft = document.createDocumentFragment();
    const fragRight = document.createDocumentFragment();
    for (const line of lines) {
      fragLeft.append(createCell(line, "old", gutterWidth, language));
      fragRight.append(createCell(line, "new", gutterWidth, language));
    }
    left.replaceWith(fragLeft);
    right.replaceWith(fragRight);
  };

  left.addEventListener("click", expand);
  right.addEventListener("click", expand);
  return { left, right };
}

/** Side-by-side diff: red deletes on the left pane, green adds on the right;
 *  each pane takes half the preview width and scrolls horizontally on its
 *  own; long equal runs fold (same rules as the unified view). */
export function createSideBySideFileView(
  lines: DiffLine[],
  options?: SideBySideFileViewOptions,
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "tool-file-lines tool-file-sbs";

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

  const headers = document.createElement("div");
  headers.className = "tool-file-sbs-headers";
  const oldHead = document.createElement("span");
  oldHead.textContent = "Original";
  const newHead = document.createElement("span");
  newHead.textContent = "Modified";
  headers.append(oldHead, newHead);

  const leftPane = document.createElement("div");
  leftPane.className = "tool-file-sbs-pane";
  const rightPane = document.createElement("div");
  rightPane.className = "tool-file-sbs-pane";
  const panes = document.createElement("div");
  panes.className = "tool-file-sbs-panes";
  panes.append(leftPane, rightPane);

  const appendRow = (
    left: DiffLine | null,
    right: DiffLine | null,
  ): void => {
    leftPane.append(createCell(left, "old", gutterWidth, language));
    rightPane.append(createCell(right, "new", gutterWidth, language));
  };

  const foldUnchanged = options?.foldUnchanged !== false;
  const segments = foldUnchanged
    ? buildSideBySideSegments(lines)
    : [{ type: "rows" as const, rows: pairSideBySideRows(lines) }];

  for (const segment of segments) {
    if (segment.type === "rows") {
      for (const row of segment.rows) {
        appendRow(row.left, row.right);
      }
    } else {
      const pair = createFoldRowPair(segment.lines, gutterWidth, language);
      leftPane.append(pair.left);
      rightPane.append(pair.right);
    }
  }

  wrap.append(headers, panes);
  return wrap;
}
