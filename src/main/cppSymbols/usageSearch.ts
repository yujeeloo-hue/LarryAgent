import type { CppUsageCandidate } from "./types.js";

export function escapeCppUsageWord(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function scanCppUsageText(
  path: string,
  text: string,
  word: string,
  limit = 5000,
): { matches: CppUsageCandidate[]; truncated: boolean } {
  if (!/^[A-Za-z_]\w*$/.test(word) || limit <= 0) {
    return { matches: [], truncated: false };
  }
  const pattern = new RegExp(`\\b${escapeCppUsageWord(word)}\\b`, "g");
  const matches: CppUsageCandidate[] = [];
  const lines = text.split(/\r?\n/);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const lineText = lines[lineIndex]!;
    pattern.lastIndex = 0;
    let hit: RegExpExecArray | null;
    while ((hit = pattern.exec(lineText)) !== null) {
      matches.push({
        path,
        line: lineIndex + 1,
        column: hit.index + 1,
        lineText: lineText.trim(),
      });
      if (matches.length >= limit) {
        return { matches, truncated: true };
      }
    }
  }
  return { matches, truncated: false };
}
