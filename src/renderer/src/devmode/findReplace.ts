
export type FindWidgetMode = "find" | "replace";

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
