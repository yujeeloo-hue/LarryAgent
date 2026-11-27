import { round1 } from "./motion.js";
import type { OcrBox, OcrLine, Rect } from "./types.js";

export type OcrMatch = { text: string; box: Rect };

function compact(text: string): string {
  return text.toLowerCase().replace(/\s+/g, "");
}

function unionBoxes(boxes: readonly Rect[]): Rect {
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.width));
  const y1 = Math.max(...boxes.map((b) => b.y + b.height));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function matchWords(words: readonly OcrBox[], query: string): Rect | null {
  let joined = "";
  const spans: Array<{ start: number; end: number; box: OcrBox }> = [];
  for (const word of words) {
    const piece = compact(word.text);
    if (!piece) continue;
    spans.push({ start: joined.length, end: joined.length + piece.length, box: word });
    joined += piece;
  }
  const at = joined.indexOf(query);
  if (at < 0) return null;
  const end = at + query.length;
  const covered = spans.filter((s) => s.start < end && s.end > at).map((s) => s.box);
  return covered.length > 0 ? unionBoxes(covered) : null;
}

// Without word boxes, estimate the substring's horizontal slice of the line box.
function matchLine(line: OcrLine, query: string, rawQuery: string): Rect | null {
  const lower = line.text.toLowerCase();
  let at = lower.indexOf(rawQuery);
  let length = rawQuery.length;
  let total = lower.length;
  if (at < 0) {
    const packed = compact(line.text);
    at = packed.indexOf(query);
    length = query.length;
    total = packed.length;
  }
  if (at < 0 || total === 0) return null;
  return {
    x: line.x + (line.width * at) / total,
    y: line.y,
    width: Math.max(1, (line.width * length) / total),
    height: line.height,
  };
}

/** Case-insensitive substring search that tolerates OCR spacing (Windows splits CJK lines per character). */
export function findTextInLines(lines: readonly OcrLine[], text: string): OcrMatch[] {
  const rawQuery = text.trim().toLowerCase();
  const query = compact(text);
  if (!query) return [];
  const matches: OcrMatch[] = [];
  for (const line of lines) {
    if (!compact(line.text).includes(query)) continue;
    const box =
      (line.words && line.words.length > 0 ? matchWords(line.words, query) : null) ??
      matchLine(line, query, rawQuery) ??
      line;
    matches.push({ text: line.text, box });
  }
  return matches;
}

/** Converts a box in image pixels to global screen coordinates of the captured rect. */
export function imageBoxToScreen(
  box: Rect,
  capture: { rect: Rect; width: number; height: number },
): Rect {
  const sx = capture.rect.width > 0 ? capture.width / capture.rect.width : 1;
  const sy = capture.rect.height > 0 ? capture.height / capture.rect.height : sx;
  return {
    x: round1(capture.rect.x + box.x / sx),
    y: round1(capture.rect.y + box.y / sy),
    width: round1(box.width / sx),
    height: round1(box.height / sy),
  };
}
