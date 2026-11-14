/**
 * Hermes-aligned multi-strategy find-and-replace. Tried in order:
 * exact → line-trimmed → whitespace-normalized → indentation-flexible →
 * escape-normalized → trimmed-boundary → unicode-normalized → block-anchor →
 * context-aware.
 */

export type MatchSpan = { start: number; end: number };

export type FuzzyReplaceResult = {
  content: string;
  matchCount: number;
  strategy: string | null;
  error: string | null;
};

const UNICODE_MAP: Record<string, string> = {
  "\u201c": '"',
  "\u201d": '"',
  "\u2018": "'",
  "\u2019": "'",
  "\u2014": "--",
  "\u2013": "-",
  "\u2026": "...",
  "\u00a0": " ",
  "\u2212": "-",
  "\u2000": " ",
  "\u2001": " ",
  "\u2002": " ",
  "\u2003": " ",
  "\u2004": " ",
  "\u2005": " ",
  "\u2006": " ",
  "\u2007": " ",
  "\u2008": " ",
  "\u2009": " ",
  "\u200a": " ",
  "\u202f": " ",
  "\u205f": " ",
  "\u3000": " ",
};

const IDENTICAL_STRINGS_ERROR =
  "No edit was applied because old_string and new_string are identical. " +
  "Provide the existing text to replace in old_string and the changed " +
  "replacement text in new_string.";

const SIMILARITY_STRATEGIES = new Set(["block_anchor", "context_aware"]);

export function unicodeNormalize(text: string): string {
  let out = text;
  for (const [ch, repl] of Object.entries(UNICODE_MAP)) {
    if (out.includes(ch)) out = out.split(ch).join(repl);
  }
  return out;
}

/**
 * Conservative already-applied check: new_string is present exactly, and
 * old_string is gone (unless they are identical). Tiny new_string is ignored.
 */
export function isAlreadyApplied(
  content: string,
  oldString: string,
  newString: string,
): boolean {
  if (!newString || newString.trim().length < 8) return false;
  if (!content.includes(newString)) return false;
  if (oldString === newString) return true;
  return !content.includes(oldString);
}

export function fuzzyFindAndReplace(
  content: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): FuzzyReplaceResult {
  if (!oldString) {
    return { content, matchCount: 0, strategy: null, error: "old_string cannot be empty" };
  }
  if (!oldString.trim()) {
    return {
      content,
      matchCount: 0,
      strategy: null,
      error: "old_string is only whitespace — provide non-blank text to match",
    };
  }
  if (oldString === newString) {
    return { content, matchCount: 0, strategy: null, error: IDENTICAL_STRINGS_ERROR };
  }

  const strategies: Array<[string, (c: string, p: string) => MatchSpan[]]> = [
    ["exact", strategyExact],
    ["line_trimmed", strategyLineTrimmed],
    ["whitespace_normalized", strategyWhitespaceNormalized],
    ["indentation_flexible", strategyIndentationFlexible],
    ["escape_normalized", strategyEscapeNormalized],
    ["trimmed_boundary", strategyTrimmedBoundary],
    ["unicode_normalized", strategyUnicodeNormalized],
    ["block_anchor", strategyBlockAnchor],
    ["context_aware", strategyContextAware],
  ];

  for (const [name, fn] of strategies) {
    const matches = fn(content, oldString);
    if (matches.length === 0) continue;

    if (matches.length > 1 && !replaceAll) {
      return {
        content,
        matchCount: 0,
        strategy: null,
        error:
          `Found ${matches.length} matches for old_string. ` +
          `Provide more context to make it unique, or use replace_all=true. ` +
          `Matches:\n${formatMatchLocations(content, matches)}`,
      };
    }
    if (replaceAll && matches.length > 1 && SIMILARITY_STRATEGIES.has(name)) {
      return {
        content,
        matchCount: 0,
        strategy: null,
        error:
          `Found ${matches.length} approximate matches via the '${name}' strategy; ` +
          `replace_all only applies to exact matches. Provide the precise text ` +
          `(whitespace included) so an exact/line-trimmed match can be made.`,
      };
    }

    if (name !== "exact") {
      const drift = detectEscapeDrift(content, matches, oldString, newString);
      if (drift) {
        return { content, matchCount: 0, strategy: null, error: drift };
      }
    }

    const effectiveNew = maybeUnescapeNewString(newString, content, matches);
    const next = applyReplacements(
      content,
      matches,
      effectiveNew,
      name === "exact" ? null : oldString,
    );
    return { content: next, matchCount: matches.length, strategy: name, error: null };
  }

  return {
    content,
    matchCount: 0,
    strategy: null,
    error: "Could not find a match for old_string in the file",
  };
}

/**
 * Above this many DP cells the exact LCS is abandoned for a bigram estimate.
 * 4M cells is ~2000x2000 characters and costs a few milliseconds; the strategy
 * loops below call this per candidate offset, so an unbounded exact metric
 * turns one oversized block into a multi-second freeze.
 */
const MAX_LCS_CELLS = 4_000_000;

/** Rolling DP row, reused across calls so hot match loops allocate nothing. */
let lcsRow = new Int32Array(0);

/**
 * Length of the longest common subsequence, in UTF-16 code units.
 *
 * Equivalent to summing the unchanged spans of a character-level Myers diff
 * (what this used to do via `diffChars`) but without building a Change object
 * graph: jsdiff's cost grows quadratically in practice — a 12KB block measured
 * at ~3s and tens of MB per call — which showed up as multi-second UI freezes
 * and gigabyte allocation spikes whenever a patch fell through to the fuzzy
 * strategies.
 */
function lcsLength(a: string, b: string): number {
  // Shared framing (indentation, identical head/tail lines) is the common case
  // and shrinks the DP rectangle for free. Greedily matching a common
  // prefix/suffix is always consistent with some optimal LCS alignment.
  const minLen = Math.min(a.length, b.length);
  let start = 0;
  while (start < minLen && a.charCodeAt(start) === b.charCodeAt(start)) {
    start += 1;
  }
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (
    endA >= start &&
    endB >= start &&
    a.charCodeAt(endA) === b.charCodeAt(endB)
  ) {
    endA -= 1;
    endB -= 1;
  }
  const trimmed = start + (a.length - 1 - endA);
  const midA = a.slice(start, endA + 1);
  const midB = b.slice(start, endB + 1);
  if (midA.length === 0 || midB.length === 0) return trimmed;

  if (midA.length * midB.length > MAX_LCS_CELLS) {
    return trimmed + estimateCommonByBigrams(midA, midB);
  }

  // Columns over the shorter side keeps the reused row small.
  const [rows, cols] = midA.length >= midB.length ? [midA, midB] : [midB, midA];
  const width = cols.length;
  if (lcsRow.length < width + 1) lcsRow = new Int32Array(width + 1);
  const row = lcsRow;
  row.fill(0, 0, width + 1);

  for (let i = 0; i < rows.length; i += 1) {
    const ca = rows.charCodeAt(i);
    // `diag` carries row[j] from the previous outer iteration, i.e. the
    // (i-1, j-1) cell, so one array is enough for the whole table.
    let diag = 0;
    for (let j = 0; j < width; j += 1) {
      const above = row[j + 1] as number;
      row[j + 1] =
        ca === cols.charCodeAt(j)
          ? diag + 1
          : Math.max(above, row[j] as number);
      diag = above;
    }
  }
  return trimmed + (row[width] as number);
}

/**
 * Cheap stand-in for the LCS on inputs too large to diff exactly: shared
 * character bigrams, which tracks the exact ratio closely enough for the
 * 0.5–0.8 thresholds these strategies use.
 */
function estimateCommonByBigrams(a: string, b: string): number {
  const counts = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i += 1) {
    const gram = a.slice(i, i + 2);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  let shared = 0;
  for (let i = 0; i < b.length - 1; i += 1) {
    const gram = b.slice(i, i + 2);
    const left = counts.get(gram);
    if (left) {
      counts.set(gram, left - 1);
      shared += 1;
    }
  }
  return Math.min(shared, Math.min(a.length, b.length));
}

/**
 * Sørensen–Dice style ratio over the longest common subsequence:
 * `2 * LCS / (|a| + |b|)`, in [0, 1].
 *
 * `minRatio` is an optional early-exit hint. Callers that only compare the
 * result against a threshold should pass it: a length mismatch alone can rule
 * a candidate out before any diffing happens. When it does, the return value
 * is only guaranteed to be below `minRatio`, not the true ratio.
 */
export function similarityRatio(a: string, b: string, minRatio = 0): number {
  if (a === b) return 1;
  const la = a.length;
  const lb = b.length;
  if (la === 0 && lb === 0) return 1;
  if (la === 0 || lb === 0) return 0;
  const total = la + lb;
  if (minRatio > 0 && (2 * Math.min(la, lb)) / total < minRatio) return 0;
  return (2 * lcsLength(a, b)) / total;
}

function strategyExact(content: string, pattern: string): MatchSpan[] {
  const matches: MatchSpan[] = [];
  let start = 0;
  while (start <= content.length) {
    const pos = content.indexOf(pattern, start);
    if (pos < 0) break;
    matches.push({ start: pos, end: pos + pattern.length });
    start = pos + pattern.length;
  }
  return matches;
}

function strategyLineTrimmed(content: string, pattern: string): MatchSpan[] {
  const patternNormalized = pattern.split("\n").map((l) => l.trim()).join("\n");
  const contentLines = content.split("\n");
  const contentNormalized = contentLines.map((l) => l.trim());
  return findNormalizedMatches(content, contentLines, contentNormalized, patternNormalized);
}

function strategyWhitespaceNormalized(content: string, pattern: string): MatchSpan[] {
  const normalize = (s: string) => s.replace(/[ \t]+/g, " ");
  const patternNormalized = normalize(pattern);
  const contentNormalized = normalize(content);
  const inNorm = strategyExact(contentNormalized, patternNormalized);
  if (inNorm.length === 0) return [];
  return mapNormalizedPositions(content, contentNormalized, inNorm);
}

function strategyIndentationFlexible(content: string, pattern: string): MatchSpan[] {
  const contentLines = content.split("\n");
  const contentStripped = contentLines.map((l) => l.replace(/^[ \t]+/, ""));
  const patternNormalized = pattern.split("\n").map((l) => l.replace(/^[ \t]+/, "")).join("\n");
  return findNormalizedMatches(content, contentLines, contentStripped, patternNormalized);
}

function strategyEscapeNormalized(content: string, pattern: string): MatchSpan[] {
  const unescaped = pattern.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\r/g, "\r");
  if (unescaped === pattern) return [];
  return strategyExact(content, unescaped);
}

function strategyTrimmedBoundary(content: string, pattern: string): MatchSpan[] {
  const patternLines = pattern.split("\n");
  if (patternLines.length === 0) return [];
  const first = patternLines[0];
  const last = patternLines[patternLines.length - 1];
  if (first === undefined || last === undefined) return [];
  patternLines[0] = first.trim();
  if (patternLines.length > 1) patternLines[patternLines.length - 1] = last.trim();
  const modified = patternLines.join("\n");
  const contentLines = content.split("\n");
  const count = patternLines.length;
  const matches: MatchSpan[] = [];
  for (let i = 0; i <= contentLines.length - count; i++) {
    const block = contentLines.slice(i, i + count);
    const check = [...block];
    const checkFirst = check[0];
    const checkLast = check[check.length - 1];
    if (checkFirst === undefined || checkLast === undefined) continue;
    check[0] = checkFirst.trim();
    if (check.length > 1) check[check.length - 1] = checkLast.trim();
    if (check.join("\n") === modified) {
      matches.push(calculateLinePositions(contentLines, i, i + count, content.length));
    }
  }
  return matches;
}

function strategyUnicodeNormalized(content: string, pattern: string): MatchSpan[] {
  const normPattern = unicodeNormalize(pattern);
  const normContent = unicodeNormalize(content);
  if (normContent === content && normPattern === pattern) return [];
  let normMatches = strategyExact(normContent, normPattern);
  if (normMatches.length === 0) {
    normMatches = strategyLineTrimmed(normContent, normPattern);
  }
  if (normMatches.length === 0) return [];
  return mapPositionsNormToOrig(buildOrigToNormMap(content), normMatches);
}

function strategyBlockAnchor(content: string, pattern: string): MatchSpan[] {
  const normPattern = unicodeNormalize(pattern);
  const normContent = unicodeNormalize(content);
  const patternLines = normPattern.split("\n");
  if (patternLines.length < 2) return [];
  const firstLine = (patternLines[0] ?? "").trim();
  const lastLine = (patternLines[patternLines.length - 1] ?? "").trim();
  const normContentLines = normContent.split("\n");
  const origContentLines = content.split("\n");
  const count = patternLines.length;
  const potential: number[] = [];
  for (let i = 0; i <= normContentLines.length - count; i++) {
    if (
      (normContentLines[i] ?? "").trim() === firstLine &&
      (normContentLines[i + count - 1] ?? "").trim() === lastLine
    ) {
      potential.push(i);
    }
  }
  const threshold = potential.length === 1 ? 0.5 : 0.7;
  const matches: MatchSpan[] = [];
  for (const i of potential) {
    let similarity = 1;
    if (count > 2) {
      const contentMiddle = normContentLines.slice(i + 1, i + count - 1).join("\n");
      const patternMiddle = patternLines.slice(1, -1).join("\n");
      similarity = similarityRatio(contentMiddle, patternMiddle, threshold);
    }
    if (similarity >= threshold) {
      matches.push(calculateLinePositions(origContentLines, i, i + count, content.length));
    }
  }
  return matches;
}

function strategyContextAware(content: string, pattern: string): MatchSpan[] {
  const patternLines = pattern.split("\n");
  const contentLines = content.split("\n");
  if (patternLines.length === 0 || patternLines.length > contentLines.length) return [];
  const count = patternLines.length;
  const firstPat = (patternLines[0] ?? "").trim();
  const lastPat = (patternLines[count - 1] ?? "").trim();
  const matches: MatchSpan[] = [];
  for (let i = 0; i <= contentLines.length - count; i++) {
    const block = contentLines.slice(i, i + count);
    const blockFirst = block[0];
    const blockLast = block[block.length - 1];
    if (blockFirst === undefined || blockLast === undefined) continue;
    if (similarityRatio(firstPat, blockFirst.trim(), 0.8) < 0.8) continue;
    if (similarityRatio(lastPat, blockLast.trim(), 0.8) < 0.8) continue;
    let allMatch = true;
    for (let k = 0; k < count; k++) {
      const p = (patternLines[k] ?? "").trim();
      if (!p) continue;
      if (similarityRatio(p, (block[k] ?? "").trim(), 0.8) < 0.8) {
        allMatch = false;
        break;
      }
    }
    if (allMatch) {
      matches.push(calculateLinePositions(contentLines, i, i + count, content.length));
    }
  }
  return matches;
}

function findNormalizedMatches(
  content: string,
  contentLines: string[],
  contentNormalizedLines: string[],
  patternNormalized: string,
): MatchSpan[] {
  const patternNormLines = patternNormalized.split("\n");
  const n = patternNormLines.length;
  const matches: MatchSpan[] = [];
  for (let i = 0; i <= contentNormalizedLines.length - n; i++) {
    const block = contentNormalizedLines.slice(i, i + n).join("\n");
    if (block === patternNormalized) {
      matches.push(calculateLinePositions(contentLines, i, i + n, content.length));
    }
  }
  return matches;
}

function calculateLinePositions(
  contentLines: string[],
  startLine: number,
  endLine: number,
  contentLength: number,
): MatchSpan {
  let start = 0;
  for (let i = 0; i < startLine; i++) start += (contentLines[i]?.length ?? 0) + 1;
  let end = 0;
  for (let i = 0; i < endLine; i++) end += (contentLines[i]?.length ?? 0) + 1;
  end = Math.min(contentLength, end - 1);
  return { start, end };
}

function mapNormalizedPositions(
  original: string,
  normalized: string,
  normalizedMatches: MatchSpan[],
): MatchSpan[] {
  if (normalizedMatches.length === 0) return [];
  const origToNorm: number[] = [];
  let origIdx = 0;
  let normIdx = 0;
  while (origIdx < original.length && normIdx < normalized.length) {
    const oc = original[origIdx];
    const nc = normalized[normIdx];
    if (oc === nc) {
      origToNorm.push(normIdx);
      origIdx += 1;
      normIdx += 1;
    } else if ((oc === " " || oc === "\t") && nc === " ") {
      origToNorm.push(normIdx);
      origIdx += 1;
      if (origIdx < original.length && original[origIdx] !== " " && original[origIdx] !== "\t") {
        normIdx += 1;
      }
    } else if (oc === " " || oc === "\t") {
      origToNorm.push(normIdx);
      origIdx += 1;
    } else {
      origToNorm.push(normIdx);
      origIdx += 1;
    }
  }
  while (origIdx < original.length) {
    origToNorm.push(normalized.length);
    origIdx += 1;
  }

  const normToOrigStart = new Map<number, number>();
  const normToOrigEnd = new Map<number, number>();
  for (let origPos = 0; origPos < origToNorm.length; origPos++) {
    const normPos = origToNorm[origPos] ?? 0;
    if (!normToOrigStart.has(normPos)) normToOrigStart.set(normPos, origPos);
    normToOrigEnd.set(normPos, origPos);
  }

  const out: MatchSpan[] = [];
  for (const m of normalizedMatches) {
    let origStart: number;
    const mappedStart = normToOrigStart.get(m.start);
    if (mappedStart !== undefined) {
      origStart = mappedStart;
    } else {
      origStart = origToNorm.findIndex((n) => n >= m.start);
      if (origStart < 0) origStart = 0;
    }
    let origEnd: number;
    const mappedEnd = normToOrigEnd.get(m.end - 1);
    if (mappedEnd !== undefined) {
      origEnd = mappedEnd + 1;
    } else {
      origEnd = origStart + (m.end - m.start);
    }
    if (m.end < normalized.length && normalized[m.end - 1] === " ") {
      while (origEnd < original.length && (original[origEnd] === " " || original[origEnd] === "\t")) {
        origEnd += 1;
      }
    }
    out.push({ start: origStart, end: Math.min(origEnd, original.length) });
  }
  return out;
}

function buildOrigToNormMap(original: string): number[] {
  const result: number[] = [];
  let normPos = 0;
  for (const char of original) {
    result.push(normPos);
    const repl = UNICODE_MAP[char];
    normPos += repl !== undefined ? repl.length : 1;
  }
  result.push(normPos);
  return result;
}

function mapPositionsNormToOrig(origToNorm: number[], normMatches: MatchSpan[]): MatchSpan[] {
  const normToOrigStart = new Map<number, number>();
  for (let origPos = 0; origPos < origToNorm.length - 1; origPos++) {
    const normPos = origToNorm[origPos];
    if (normPos !== undefined && !normToOrigStart.has(normPos)) {
      normToOrigStart.set(normPos, origPos);
    }
  }
  const origLen = origToNorm.length - 1;
  const results: MatchSpan[] = [];
  for (const m of normMatches) {
    const origStart = normToOrigStart.get(m.start);
    if (origStart === undefined) continue;
    let origEnd = origStart;
    while (origEnd < origLen && (origToNorm[origEnd] ?? 0) < m.end) origEnd += 1;
    results.push({ start: origStart, end: origEnd });
  }
  return results;
}

function leadingWhitespace(line: string): string {
  const m = /^[ \t]*/.exec(line);
  return m?.[0] ?? "";
}

function firstMeaningfulLine(text: string): string | null {
  for (const line of text.split("\n")) {
    if (line.trim().length > 0) return line;
  }
  return null;
}

function reindentReplacement(fileRegion: string, oldString: string, newString: string): string {
  const oldFirst = firstMeaningfulLine(oldString);
  const fileFirst = firstMeaningfulLine(fileRegion);
  if (!oldFirst || !fileFirst) return newString;
  const oldIndent = leadingWhitespace(oldFirst);
  const fileIndent = leadingWhitespace(fileFirst);
  if (oldIndent === fileIndent) return newString;
  return newString
    .split("\n")
    .map((line) => {
      if (line.length === 0) return line;
      const lineIndent = leadingWhitespace(line);
      if (oldIndent.length > 0 && lineIndent.startsWith(oldIndent)) {
        return fileIndent + line.slice(oldIndent.length);
      }
      return fileIndent + line.replace(/^[ \t]+/, "");
    })
    .join("\n");
}

function maybeUnescapeNewString(
  newString: string,
  content: string,
  matches: MatchSpan[],
): string {
  const region = matches.map((m) => content.slice(m.start, m.end)).join("");
  let out = newString;
  if (region.includes("\t") && out.includes("\\t") && !region.includes("\\t")) {
    out = out.replace(/\\t/g, "\t");
  }
  if (region.includes("\r") && out.includes("\\r") && !region.includes("\\r")) {
    out = out.replace(/\\r/g, "\r");
  }
  return out;
}

function applyReplacements(
  content: string,
  matches: MatchSpan[],
  newString: string,
  oldString: string | null,
): string {
  const sorted = [...matches].sort((a, b) => b.start - a.start);
  let out = content;
  for (const m of sorted) {
    const region = out.slice(m.start, m.end);
    const replacement =
      oldString !== null ? reindentReplacement(region, oldString, newString) : newString;
    out = out.slice(0, m.start) + replacement + out.slice(m.end);
  }
  return out;
}

function detectEscapeDrift(
  content: string,
  matches: MatchSpan[],
  oldString: string,
  newString: string,
): string | null {
  const hasQuoteSuspects = newString.includes("\\'") || newString.includes('\\"');
  if (!hasQuoteSuspects && !oldString.includes("\\")) return null;
  const matchedRegions = matches.map((m) => content.slice(m.start, m.end)).join("");
  if (hasQuoteSuspects) {
    for (const suspect of ["\\'", '\\"'] as const) {
      if (
        newString.includes(suspect) &&
        oldString.includes(suspect) &&
        !matchedRegions.includes(suspect)
      ) {
        const plain = suspect.slice(1);
        return (
          `Escape-drift detected: old_string and new_string contain the literal ` +
          `sequence ${JSON.stringify(suspect)} but the matched region of the file does not. ` +
          `Re-read the file and pass old_string/new_string without backslash-escaping ${JSON.stringify(plain)}.`
        );
      }
    }
  }
  return null;
}

function formatMatchLocations(content: string, matches: MatchSpan[], cap = 5): string {
  const rows: string[] = [];
  for (const m of matches.slice(0, cap)) {
    const lineNo = content.slice(0, m.start).split("\n").length;
    const lineStart = content.lastIndexOf("\n", m.start - 1) + 1;
    let lineEnd = content.indexOf("\n", lineStart);
    if (lineEnd < 0) lineEnd = content.length;
    let snippet = content.slice(lineStart, lineEnd).trim();
    if (snippet.length > 80) snippet = `${snippet.slice(0, 77)}...`;
    rows.push(`  L${lineNo}: ${snippet}`);
  }
  if (matches.length > cap) rows.push(`  ... and ${matches.length - cap} more`);
  return rows.join("\n");
}

function visualizeWhitespace(line: string): string {
  const m = /^[ \t]*/.exec(line);
  const prefix = m?.[0] ?? "";
  const rest = line.slice(prefix.length);
  const shown = prefix.replace(/\t/g, "→").replace(/ /g, "·");
  return shown + rest;
}

/**
 * Closest-line "Did you mean?" snippet for a failed old_string match.
 */
export function findClosestLines(
  oldString: string,
  content: string,
  contextLines = 2,
  maxResults = 3,
): string {
  const oldLines = oldString.split("\n");
  const contentLines = content.split("\n");
  const anchor = (oldLines[0] ?? "").trim();
  if (!anchor || contentLines.length === 0) return "";

  const scored: Array<[number, number]> = [];
  for (let i = 0; i < contentLines.length; i++) {
    const line = contentLines[i] ?? "";
    scored.push([similarityRatio(anchor, line.trim()), i]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  const top = scored.filter((s) => s[0] > 0).slice(0, maxResults);
  if (top.length === 0) return "";

  const parts: string[] = [];
  const seen = new Set<string>();
  const width = String(contentLines.length).length;
  for (const [, lineIdx] of top) {
    const start = Math.max(0, lineIdx - contextLines);
    const end = Math.min(contentLines.length, lineIdx + oldLines.length + contextLines);
    const key = `${start}:${end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const snippet = contentLines.slice(start, end).map((line, j) => {
      const n = String(start + j + 1).padStart(width, " ");
      return `${n}|${line}`;
    });
    parts.push(`Lines ${start + 1}-${end} of ${contentLines.length}\n${snippet.join("\n")}`);
  }
  if (parts.length === 0) return "";
  let result = parts.join("\n---\n");
  const bestLine = contentLines[top[0]?.[1] ?? 0] ?? "";
  if (bestLine.trim() === anchor && bestLine !== oldLines[0]) {
    result +=
      `\n\nWhitespace difference detected (→ = tab, · = space):\n` +
      `  file has: ${visualizeWhitespace(bestLine)}\n` +
      `  you sent: ${visualizeWhitespace(oldLines[0] ?? "")}\n` +
      `Use the exact whitespace shown in 'file has'.`;
  }
  return result;
}

export function formatNoMatchHint(
  error: string | null,
  matchCount: number,
  oldString: string,
  content: string,
): string {
  if (matchCount !== 0) return "";
  if (!error || !error.startsWith("Could not find")) return "";
  const hint = findClosestLines(oldString, content);
  if (!hint) return "";
  return `\n\nDid you mean one of these sections?\n${hint}`;
}
