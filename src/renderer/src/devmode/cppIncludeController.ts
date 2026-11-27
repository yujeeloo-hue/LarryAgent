
import {
  includeSpecifierFor,
  isHeaderPath,
  normalizeFsPath,
  planIncludeInsertion,
  type IncludeInsertion,
} from "../../../shared/cppIncludes.js";

export type CppIncludeSymbolHit = {
  name: string;
  kind: string;
  path: string;
  line: number;
};

export type CppIncludeDeps = {
  workspaceRoot: () => string | null;
  activeDocument: () => { path: string; text: string } | null;
  symbolAtCaret: () => string | null;
  lookupSymbols: (rootPath: string, word: string) => Promise<CppIncludeSymbolHit[]>;
  lookupIndexSymbols?: (rootPath: string, word: string) => Promise<CppIncludeSymbolHit[]>;
  includeDirs: (rootPath: string, filePath: string) => Promise<string[]>;
  applyInsertion: (path: string, insertion: IncludeInsertion) => boolean;
  notice: (message: string, ttlMs?: number) => void;
  log?: (entry: Record<string, unknown>) => void;
};

const CPP_FILE_RE = /\.(?:h|hh|hpp|hxx|inl|ipp|c|cc|cpp|cxx)$/i;
const TYPE_KINDS = new Set(["class", "struct", "enum", "interface", "type"]);
const GENERATED_RE = /\.(?:generated|gen)\.h$/i;

export function pickIncludeHeader(
  hits: readonly CppIncludeSymbolHit[],
  symbol: string,
  editedPath: string,
): CppIncludeSymbolHit | null {
  const normEdited = normalizeFsPath(editedPath);
  let best: CppIncludeSymbolHit | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const hit of hits) {
    if (hit.name !== symbol || !hit.path) continue;
    const path = normalizeFsPath(hit.path);
    if (path === normEdited || GENERATED_RE.test(path) || !isHeaderPath(path)) continue;
    const score = TYPE_KINDS.has(hit.kind) ? 0 : 1;
    if (score < bestScore) {
      bestScore = score;
      best = { ...hit, path };
    }
  }
  return best;
}

export async function addIncludeForSymbolAtCaret(deps: CppIncludeDeps): Promise<boolean> {
  const trace: Record<string, unknown> = {};
  const finish = (ok: boolean, message: string, ttlMs: number): boolean => {
    deps.notice(message, ttlMs);
    deps.log?.({ ...trace, ok, notice: message });
    return ok;
  };
  const doc = deps.activeDocument();
  if (!doc) return finish(false, "Open a C++ file first", 4000);
  trace.docPath = doc.path;
  if (!CPP_FILE_RE.test(doc.path)) return finish(false, "Not a C++ file — no include added", 4000);
  const symbol = deps.symbolAtCaret()?.trim();
  if (!symbol) return finish(false, "Put the caret on a type or function name", 4000);
  trace.symbol = symbol;
  const root = deps.workspaceRoot();
  if (!root) return finish(false, "Open a project to add includes", 4000);
  trace.root = root;
  let hits: CppIncludeSymbolHit[] = [];
  try {
    hits = await deps.lookupSymbols(root, symbol);
  } catch (err) {
    trace.textIndexError = String(err);
    hits = [];
  }
  trace.textIndexHits = traceHits(hits);
  let header = pickIncludeHeader(hits, symbol, doc.path);
  if (!header && deps.lookupIndexSymbols) {
    let indexHits: CppIncludeSymbolHit[] = [];
    try {
      indexHits = await deps.lookupIndexSymbols(root, symbol);
    } catch (err) {
      trace.clangdIndexError = String(err);
      indexHits = [];
    }
    trace.clangdIndexHits = traceHits(indexHits);
    header = pickIncludeHeader(indexHits, symbol, doc.path);
  }
  if (!header) return finish(false, `No header declares "${symbol}"`, 5000);
  trace.header = header.path;
  let dirs: string[] = [];
  try {
    dirs = await deps.includeDirs(root, doc.path);
  } catch (err) {
    trace.includeDirsError = String(err);
    dirs = [];
  }
  trace.includeDirCount = dirs.length;
  trace.includeDirSample = dirs.slice(0, 8);
  const specifier = includeSpecifierFor(header.path, dirs, doc.path);
  if (!specifier) {
    trace.includeDirs = dirs;
    return finish(false, `No include path for ${header.path.replace(/\\/g, "/").split("/").pop()}`, 5000);
  }
  trace.specifier = specifier;
  const insertion = planIncludeInsertion(doc.text, specifier, doc.path);
  if (!insertion) return finish(false, `#include "${specifier}" is already there`, 4000);
  if (!deps.applyInsertion(doc.path, insertion)) return finish(false, "Could not edit this buffer", 4000);
  return finish(true, `Added #include "${specifier}"`, 4000);
}

function traceHits(hits: readonly CppIncludeSymbolHit[]): { count: number; first: string[] } {
  return {
    count: hits.length,
    first: hits.slice(0, 6).map((hit) => `${hit.name} [${hit.kind}] ${hit.path}:${hit.line}`),
  };
}
