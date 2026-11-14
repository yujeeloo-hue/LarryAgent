/**
 * Source-map consumer for Electron debug (generated JS ↔ original TS).
 * Built from the VLQ `mappings` field — Node's SourceMap has no reverse lookup.
 */
import { fileURLToPath, } from "node:url";

const VLQ =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export type GeneratedPosition = {
  line: number;
  column: number;
};

export type OriginalPosition = {
  source: string;
  line: number;
  column: number;
};

export type SourceMapPayload = {
  version?: number;
  file?: string;
  sourceRoot?: string;
  sources?: string[];
  sourcesContent?: Array<string | null>;
  names?: string[];
  mappings?: string;
};

function decodeVlq(map: string, i: { n: number }): number {
  let result = 0;
  let shift = 0;
  while (i.n < map.length) {
    const digit = VLQ.indexOf(map[i.n]!);
    i.n += 1;
    if (digit < 0) break;
    result += (digit & 31) << shift;
    if (digit & 32) {
      shift += 5;
      continue;
    }
    return result & 1 ? -(result >> 1) : result >> 1;
  }
  return result & 1 ? -(result >> 1) : result >> 1;
}

export function posixPath(path: string): string {
  return path.replace(/\\/g, "/");
}

export function pathKey(path: string): string {
  return posixPath(path).replace(/\/+$/, "").toLowerCase();
}

function resolveSource(
  source: string,
  sourceRoot: string | undefined,
  mapBase: string | undefined,
): string {
  const rooted = sourceRoot
    ? posixPath(sourceRoot).replace(/\/+$/, "") + "/" + source.replace(/^\.\//, "")
    : source;
  if (/^[a-z]+:\/\//i.test(rooted) || /^[a-z]+:\/\//i.test(source)) {
    return rooted;
  }
  if (!mapBase) return posixPath(rooted);
  try {
    return new URL(rooted, mapBase.endsWith("/") ? mapBase : `${mapBase}`).href;
  } catch {
    return posixPath(rooted);
  }
}

export class SourceMapIndex {
  /** original pathKey:line(1-based) → first generated position (0-based line). */
  private readonly origToGen = new Map<string, GeneratedPosition>();
  /** generated 0-based line → original segments sorted by column */
  private readonly genLine = new Map<number, Array<OriginalPosition & { column: number }>>();
  readonly sources: string[] = [];

  static parse(payload: SourceMapPayload, mapUrl?: string): SourceMapIndex {
    const index = new SourceMapIndex();
    const sources = payload.sources ?? [];
    const sourceRoot = payload.sourceRoot;
    const mapBase = mapUrl
      ? mapUrl.endsWith("/")
        ? mapUrl
        : mapUrl.replace(/[^/]+$/, "")
      : undefined;
    index.sources.push(
      ...sources.map((source) => resolveSource(source, sourceRoot, mapBase)),
    );
    const mappings = payload.mappings ?? "";
    let genLine = 0;
    let genCol = 0;
    let srcIndex = 0;
    let origLine = 0;
    let origCol = 0;
    const cursor = { n: 0 };
    while (cursor.n <= mappings.length) {
      const ch = mappings[cursor.n];
      if (ch === undefined || ch === ";") {
        genLine += 1;
        genCol = 0;
        if (ch === undefined) break;
        cursor.n += 1;
        continue;
      }
      if (ch === ",") {
        cursor.n += 1;
        continue;
      }
      genCol += decodeVlq(mappings, cursor);
      if (mappings[cursor.n] !== "," && mappings[cursor.n] !== ";" && mappings[cursor.n] !== undefined) {
        srcIndex += decodeVlq(mappings, cursor);
        origLine += decodeVlq(mappings, cursor);
        origCol += decodeVlq(mappings, cursor);
        if (
          mappings[cursor.n] !== "," &&
          mappings[cursor.n] !== ";" &&
          mappings[cursor.n] !== undefined
        ) {
          decodeVlq(mappings, cursor);
        }
        const source = index.sources[srcIndex];
        if (source) {
          const orig: OriginalPosition = {
            source,
            line: origLine + 1,
            column: origCol,
          };
          const rows = index.genLine.get(genLine) ?? [];
          rows.push({ ...orig, column: genCol });
          index.genLine.set(genLine, rows);
          const key = `${pathKey(sourceFilePath(source))}:${orig.line}`;
          if (!index.origToGen.has(key)) {
            index.origToGen.set(key, { line: genLine, column: genCol });
          }
        }
      }
    }
    return index;
  }

  generatedPositionFor(originalPath: string, originalLine: number): GeneratedPosition | null {
    const exact = this.origToGen.get(
      `${pathKey(sourceFilePath(originalPath))}:${originalLine}`,
    );
    if (exact) return exact;
    for (const source of this.sources) {
      if (!debugPathsReferToSameFile(source, originalPath)) continue;
      const hit = this.origToGen.get(
        `${pathKey(sourceFilePath(source))}:${originalLine}`,
      );
      if (hit) return hit;
    }
    return null;
  }

  originalPositionFor(generatedLine0: number, generatedColumn = 0): OriginalPosition | null {
    const rows = this.genLine.get(generatedLine0);
    if (!rows || rows.length === 0) return null;
    let best = rows[0]!;
    for (const row of rows) {
      if (row.column <= generatedColumn) best = row;
      else break;
    }
    return { source: best.source, line: best.line, column: best.column };
  }

  containsOriginal(originalPath: string): boolean {
    return this.sources.some((source) =>
      debugPathsReferToSameFile(source, originalPath),
    );
  }
}

/** `file://` URLs and bare paths both become a filesystem path key. */
export function sourceFilePath(source: string): string {
  if (source.startsWith("file:")) {
    try {
      return fileURLToPath(source);
    } catch {
      return source.replace(/^file:\/\//, "");
    }
  }
  return source;
}

/** Pathname / filesystem form without lowercasing (keeps editor-openable paths). */
export function debugPathFromUrl(path: string): string {
  let s = path.trim();
  try {
    if (/^[a-z]+:\/\//i.test(s)) {
      const url = new URL(s);
      if (url.protocol === "file:") {
        s = fileURLToPath(url.href);
      } else {
        s = decodeURIComponent(url.pathname);
      }
    }
  } catch {
    /* keep the raw string */
  }
  s = s.replace(/\\/g, "/");
  const fsAt = s.toLowerCase().indexOf("/@fs/");
  if (fsAt >= 0) s = s.slice(fsAt + "/@fs/".length);
  if (/^\/[a-zA-Z]:\//.test(s)) s = s.slice(1);
  return s.replace(/\/+$/, "");
}

/**
 * Strip URLs / slashes into a comparable posix path (no query, lowercased).
 * Vite renderer scripts are `http://localhost:5173/src/screens/foo.ts` while
 * the editor path is `…/src/renderer/src/screens/foo.ts`.
 */
export function debugPathForCompare(path: string): string {
  return debugPathFromUrl(path).toLowerCase();
}

/**
 * True when a source-map source, script URL, or editor path names the same
 * file — including Vite HTTP URLs nested under `src/renderer`.
 */
export function debugPathsReferToSameFile(a: string, b: string): boolean {
  const left = debugPathForCompare(a);
  const right = debugPathForCompare(b);
  if (!left || !right) return false;
  if (left === right) return true;
  const longer = left.length >= right.length ? left : right;
  const shorter = left.length >= right.length ? right : left;
  if (longer.endsWith(`/${shorter}`)) return true;
  const leftParts = left.split("/");
  const rightParts = right.split("/");
  const leftBase = leftParts[leftParts.length - 1];
  const rightBase = rightParts[rightParts.length - 1];
  if (!leftBase || leftBase !== rightBase) return false;
  if (leftParts.length < 2 || rightParts.length < 2) return false;
  return leftParts[leftParts.length - 2] === rightParts[rightParts.length - 2];
}
