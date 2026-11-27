import { computerUseJevClient } from "./jevAccess.js";
import { checkScreen, screenElements } from "./jevScreen.js";
import { findTextInLines } from "./ocrMatch.js";
import type { CallOptions, ComputerUseService } from "./service.js";
import type { OcrLine, Rect, ScreenLine } from "./types.js";

const SHOWS_PROBABILITY = 0.8;

export type ScreenShows = {
  status: "yes" | "no" | "not_checkable";
  lines: ScreenLine[];
  matchedBy: "jev" | "ocr";
  fingerprint: string;
};

function lineBox(line: ScreenLine): OcrLine {
  return { text: line.text, ...line.frame };
}

function textFingerprint(lines: readonly ScreenLine[]): string {
  return lines.map((line) => line.text.replace(/\s+/g, "")).join("\n");
}

export async function screenShowsOnce(
  ocr: ComputerUseService["ocrScreen"],
  wanted: string,
  area: Rect | undefined,
  options: CallOptions,
  previous?: ScreenShows | null,
): Promise<ScreenShows> {
  const { lines, area: read } = await ocr(
    { lang: "zh-Hans", ...(area ? { region: area } : {}) },
    { ...options, avoidOcclusion: false },
  );
  const fingerprint = textFingerprint(lines);
  if (previous && previous.fingerprint === fingerprint) return { ...previous, lines };
  if (findTextInLines(lines.map(lineBox), wanted).length > 0) return { status: "yes", lines, matchedBy: "ocr", fingerprint };
  const client = await computerUseJevClient();
  if (!client) return { status: "no", lines, matchedBy: "ocr", fingerprint };
  const table = screenElements(lines, read);
  if (table.elements.length === 0) return { status: "no", lines, matchedBy: "jev", fingerprint };
  const check = await checkScreen(client, { expectation: wanted, table }, options.signal);
  if (check.checkable === false) return { status: "not_checkable", lines, matchedBy: "jev", fingerprint };
  return { status: (check.expectedProbability ?? 0) >= SHOWS_PROBABILITY ? "yes" : "no", lines, matchedBy: "jev", fingerprint };
}
