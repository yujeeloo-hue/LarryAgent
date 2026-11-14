/**
 * Find / replace helpers — shortcut routing and regex replacement expansion.
 * DOM-free so tests do not need the widget chrome.
 */

export type FindWidgetMode = "find" | "replace";

/**
 * Dev Mode overlay hotkeys. Cmd+H is left alone (macOS Hide); Windows
 * Ctrl+H and Mac Cmd+Alt+F open replace. Cmd/Ctrl+F opens find.
 */
export function findWidgetHotkey(event: {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): FindWidgetMode | null {
  if (!(event.metaKey || event.ctrlKey)) return null;
  const key = event.key.toLowerCase();
  const isF = key === "f" || event.code === "KeyF";
  const isH = key === "h" || event.code === "KeyH";
  if (
    isH &&
    event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.shiftKey
  ) {
    return "replace";
  }
  if (isF && event.altKey && !event.shiftKey) return "replace";
  if (isF && !event.altKey) return "find";
  return null;
}

/**
 * Expand `$1` / `$&` / `$$` when replacing with a regex. Literal mode
 * returns `template` unchanged.
 */
export function expandReplacePattern(
  template: string,
  matchText: string,
  groups: readonly string[] | null,
  isRegex: boolean,
): string {
  if (!isRegex) return template;
  return template.replace(/\$(\$|&|\d+)/g, (whole, token: string) => {
    if (token === "$") return "$";
    if (token === "&") return matchText;
    const n = Number(token);
    if (!Number.isFinite(n) || n < 0) return whole;
    if (!groups) return n === 0 ? matchText : "";
    return groups[n] ?? "";
  });
}

/** Caret after inserting `text` at a 1-based Monaco position. */
export function positionAfterInsert(
  startLine: number,
  startColumn: number,
  text: string,
): { lineNumber: number; column: number } {
  const lines = text.split("\n");
  if (lines.length === 1) {
    return { lineNumber: startLine, column: startColumn + text.length };
  }
  return {
    lineNumber: startLine + lines.length - 1,
    column: (lines[lines.length - 1] ?? "").length + 1,
  };
}
