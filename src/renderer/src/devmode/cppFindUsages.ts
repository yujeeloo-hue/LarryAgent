import type { FindUsageRow } from "./FindUsagesView.js";

export function usageKind(
  line: string,
  column: number,
  word: string,
): FindUsageRow["kind"] {
  const start = Math.max(0, column - 1);
  const at = line.slice(start, start + word.length) === word
    ? start
    : line.indexOf(word);
  const begin = at < 0 ? start : at;
  const before = line.slice(0, begin);
  const after = line.slice(begin + word.length);
  if (/&\s*(?:[A-Za-z_]\w*\s*::\s*)?$/.test(before)) return "address";
  if (/^\s*(?:=(?!=)|\+=|-=|\*=|\/=|%=|\+\+|--|<<=|>>=|&=|\|=|\^=)/.test(after)) return "write";
  if (/(?:\+\+|--)\s*$/.test(before)) return "write";
  if (/^\s*(?:<[^;()]*>)?\s*\(/.test(after)) return "call";
  return "read";
}
