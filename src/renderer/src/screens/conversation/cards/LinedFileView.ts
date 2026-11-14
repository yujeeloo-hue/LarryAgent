import { splitLines } from "./fileLines.js";
import {
  highlightCodeHtml,
  resolveHighlightLanguage,
} from "./codeHighlight.js";

export type LinedFileViewOptions = {
  /** File path or name used to pick a highlighter language. */
  pathOrName?: string;
  /** Explicit language override (fence tag). */
  language?: string;
};

type LinedFileState = {
  text: string;
  language: string | undefined;
  gutterWidth: number;
};

/** Last rendered text per view, so streaming updates can append instead of rebuild. */
const renderedState = new WeakMap<HTMLElement, LinedFileState>();

function createLineRow(
  line: string,
  index: number,
  gutterWidth: number,
  language: string | undefined,
): HTMLElement {
  const row = document.createElement("div");
  row.className = `tool-file-line ${index % 2 === 0 ? "is-odd" : "is-even"}`;

  const gutter = document.createElement("span");
  gutter.className = "tool-file-gutter";
  gutter.textContent = String(index + 1).padStart(gutterWidth, " ");

  const code = document.createElement("span");
  code.className = "tool-file-code hljs";
  code.innerHTML = highlightCodeHtml(line.length > 0 ? line : " ", language);

  row.append(gutter, code);
  return row;
}

function renderAllLines(
  wrap: HTMLElement,
  text: string,
  language: string | undefined,
): LinedFileState {
  const lines = splitLines(text);
  if (lines.length === 0) {
    const empty = document.createElement("div");
    empty.className = "tool-file-line is-empty";
    empty.textContent = "(empty)";
    wrap.replaceChildren(empty);
    return { text, language, gutterWidth: 0 };
  }

  const gutterWidth = String(lines.length).length;
  wrap.replaceChildren(
    ...lines.map((line, index) =>
      createLineRow(line, index, gutterWidth, language),
    ),
  );
  return { text, language, gutterWidth };
}

/** Line-numbered file body with zebra rows and per-line syntax highlighting. */
export function createLinedFileView(
  text: string,
  options?: LinedFileViewOptions,
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "tool-file-lines";

  const language = resolveHighlightLanguage({
    ...(options?.language !== undefined ? { language: options.language } : {}),
    ...(options?.pathOrName !== undefined
      ? { pathOrName: options.pathOrName }
      : {}),
    content: text,
  });

  renderedState.set(wrap, renderAllLines(wrap, text, language));
  return wrap;
}

/**
 * Update an existing lined view in place, appending only the lines that are
 * new when `text` extends what is already rendered.
 *
 * Streaming previews used to rebuild the whole view on every chunk, which
 * destroys and recreates the scroll container ~20 times a second. On platforms
 * with classic (non-overlay) scrollbars that reads as a flickering scrollbar,
 * and re-highlighting every line each chunk is what starves the frame budget
 * in the first place.
 */
export function updateLinedFileView(
  wrap: HTMLElement,
  text: string,
  options?: LinedFileViewOptions,
): void {
  const language = resolveHighlightLanguage({
    ...(options?.language !== undefined ? { language: options.language } : {}),
    ...(options?.pathOrName !== undefined
      ? { pathOrName: options.pathOrName }
      : {}),
    content: text,
  });

  const prev = renderedState.get(wrap);
  if (prev && prev.language === language && prev.text === text) return;

  const prevLines = prev ? splitLines(prev.text) : [];
  const canAppend =
    prev !== undefined &&
    prev.language === language &&
    prevLines.length > 0 &&
    text.startsWith(prev.text) &&
    wrap.childElementCount === prevLines.length;
  if (!canAppend) {
    renderedState.set(wrap, renderAllLines(wrap, text, language));
    return;
  }

  const lines = splitLines(text);
  const gutterWidth = String(lines.length).length;
  // The last rendered line may have grown mid-stream — re-render from there.
  const from = prevLines.length - 1;
  while (wrap.childElementCount > from) wrap.lastElementChild?.remove();
  const rows: HTMLElement[] = [];
  for (let index = from; index < lines.length; index += 1) {
    rows.push(createLineRow(lines[index]!, index, gutterWidth, language));
  }
  wrap.append(...rows);

  if (gutterWidth !== prev!.gutterWidth) {
    // Line count crossed a digit boundary — re-pad so the code column holds.
    wrap
      .querySelectorAll<HTMLElement>(".tool-file-gutter")
      .forEach((gutter, index) => {
        gutter.textContent = String(index + 1).padStart(gutterWidth, " ");
      });
  }

  renderedState.set(wrap, { text, language, gutterWidth });
}
