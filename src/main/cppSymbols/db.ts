import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CppSymbolHit, CppSymbolKind } from "./types.js";
import { CPP_SYMBOL_SCANNER_VERSION } from "./types.js";
import { normalizeSymbolPath } from "./paths.js";

export type CppSymbolDatabase = DatabaseSync;

const KINDS = new Set<CppSymbolKind>([
  "class",
  "interface",
  "struct",
  "enum",
  "type",
  "function",
  "variable",
]);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  mtime_ms INTEGER NOT NULL,
  size_bytes INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS symbols (
  name TEXT NOT NULL,
  name_lower TEXT NOT NULL,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  line INTEGER NOT NULL,
  container TEXT,
  container_chain TEXT,
  params TEXT,
  return_type TEXT,
  is_impl INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name_lower);
CREATE INDEX IF NOT EXISTS idx_symbols_path ON symbols(path);
CREATE INDEX IF NOT EXISTS idx_symbols_container ON symbols(container);
`;

export type FileStamp = { mtimeMs: number; sizeBytes: number };

export function openCppSymbolDatabase(
  dbPath: string,
  options?: { readOnly?: boolean },
): CppSymbolDatabase {
  if (!options?.readOnly) mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath, { readOnly: options?.readOnly === true });
  db.exec("PRAGMA busy_timeout = 5000;");
  if (!options?.readOnly) {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec(SCHEMA);
  }
  return db;
}

export function readScannerVersion(db: CppSymbolDatabase): number | null {
  const row = db
    .prepare("SELECT value FROM meta WHERE key = 'scanner_version'")
    .get() as { value: string } | undefined;
  if (!row) return null;
  const version = Number(row.value);
  return Number.isFinite(version) ? version : null;
}

export function writeScannerVersion(db: CppSymbolDatabase): void {
  db.prepare(
    "INSERT INTO meta (key, value) VALUES ('scanner_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(String(CPP_SYMBOL_SCANNER_VERSION));
}

const EXTRA_ROOTS_META_KEY = "extra_roots";

/**
 * User-added scan roots (absolute, forward-slash paths) persisted beside
 * the symbols so a workspace re-open keeps the engine-directory indexing.
 * Stored in `meta`, which scanner-version rebuilds never clear.
 */
export function readCppExtraRoots(db: CppSymbolDatabase): string[] {
  const row = db
    .prepare("SELECT value FROM meta WHERE key = ?")
    .get(EXTRA_ROOTS_META_KEY) as { value: string } | undefined;
  if (!row) return [];
  try {
    const parsed: unknown = JSON.parse(row.value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (path): path is string => typeof path === "string" && path.length > 0,
    );
  } catch {
    return [];
  }
}

export function writeCppExtraRoots(
  db: CppSymbolDatabase,
  roots: readonly string[],
): void {
  db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(EXTRA_ROOTS_META_KEY, JSON.stringify(roots));
}

export function clearCppSymbols(db: CppSymbolDatabase): void {
  db.exec("DELETE FROM symbols; DELETE FROM files;");
}

export function listIndexedPaths(db: CppSymbolDatabase): string[] {
  const rows = db.prepare("SELECT path FROM files").all() as Array<{
    path: string;
  }>;
  return rows.map((row) => row.path);
}

export function readFileStamp(
  db: CppSymbolDatabase,
  path: string,
): FileStamp | null {
  const row = db
    .prepare("SELECT mtime_ms, size_bytes FROM files WHERE path = ?")
    .get(normalizeSymbolPath(path)) as
    | { mtime_ms: number; size_bytes: number }
    | undefined;
  if (!row) return null;
  return { mtimeMs: row.mtime_ms, sizeBytes: row.size_bytes };
}

export function removeCppFileSymbols(db: CppSymbolDatabase, path: string): void {
  const norm = normalizeSymbolPath(path);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM symbols WHERE path = ?").run(norm);
    db.prepare("DELETE FROM files WHERE path = ?").run(norm);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function replaceCppFileSymbols(
  db: CppSymbolDatabase,
  path: string,
  stamp: FileStamp,
  entries: readonly CppSymbolHit[],
): void {
  const norm = normalizeSymbolPath(path);
  const delSym = db.prepare("DELETE FROM symbols WHERE path = ?");
  const delFile = db.prepare("DELETE FROM files WHERE path = ?");
  const insFile = db.prepare(
    "INSERT INTO files (path, mtime_ms, size_bytes) VALUES (?, ?, ?)",
  );
  const insSym = db.prepare(
    `INSERT INTO symbols (
      name, name_lower, kind, path, line, container, container_chain, params, return_type, is_impl
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  db.exec("BEGIN IMMEDIATE");
  try {
    delSym.run(norm);
    delFile.run(norm);
    insFile.run(norm, stamp.mtimeMs, stamp.sizeBytes);
    for (const entry of entries) {
      insSym.run(
        entry.name,
        entry.name.toLowerCase(),
        entry.kind,
        norm,
        entry.line,
        entry.container ?? null,
        entry.containerChain ?? null,
        entry.params ?? null,
        entry.returnType ?? null,
        entry.isImpl ? 1 : 0,
      );
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function lookupCppSymbols(
  db: CppSymbolDatabase,
  word: string,
): CppSymbolHit[] {
  const rows = db
    .prepare(
      `SELECT name, kind, path, line, container, container_chain, params, return_type, is_impl
       FROM symbols WHERE name_lower = ?`,
    )
    .all(word.toLowerCase()) as Array<{
    name: string;
    kind: string;
    path: string;
    line: number;
    container: string | null;
    container_chain: string | null;
    params: string | null;
    return_type: string | null;
    is_impl: number;
  }>;
  const out: CppSymbolHit[] = [];
  for (const row of rows) {
    if (!KINDS.has(row.kind as CppSymbolKind)) continue;
    const hit: CppSymbolHit = {
      name: row.name,
      kind: row.kind as CppSymbolKind,
      path: row.path,
      line: row.line,
    };
    if (row.container) hit.container = row.container;
    if (row.container_chain) hit.containerChain = row.container_chain;
    if (row.params) hit.params = row.params;
    if (row.return_type) hit.returnType = row.return_type;
    if (row.is_impl) hit.isImpl = true;
    out.push(hit);
  }
  return out;
}

export function lookupCppSymbolsFromFile(
  dbPath: string,
  word: string,
): CppSymbolHit[] {
  const trimmed = word.trim();
  if (trimmed.length < 2) return [];
  let db: CppSymbolDatabase;
  try {
    db = openCppSymbolDatabase(dbPath, { readOnly: true });
  } catch {
    return [];
  }
  try {
    return lookupCppSymbols(db, trimmed);
  } catch {
    return [];
  } finally {
    db.close();
  }
}

// ------------------------------------------------------------------ search

export type CppSymbolSearchOptions = {
  query: string;
  /** Limit to one kind (class/function/…). */
  kind?: string;
  /** Only rows whose path starts with this prefix (normalized, no trailing /). */
  pathPrefix?: string;
  /** Row cap; the caller reports truncation. Default 50. */
  limit?: number;
};

export type CppSymbolSearchResult = {
  hits: CppSymbolHit[];
  /** How the query matched: "exact" | "prefix" | "substring". */
  mode: "exact" | "prefix" | "substring";
  truncated: boolean;
};

type SymbolRow = {
  name: string;
  kind: string;
  path: string;
  line: number;
  container: string | null;
  container_chain: string | null;
  params: string | null;
  return_type: string | null;
  is_impl: number;
};

const SYMBOL_COLUMNS = `name, kind, path, line, container, container_chain, params, return_type, is_impl`;

function rowsToHits(rows: SymbolRow[]): CppSymbolHit[] {
  const out: CppSymbolHit[] = [];
  for (const row of rows) {
    if (!KINDS.has(row.kind as CppSymbolKind)) continue;
    const hit: CppSymbolHit = {
      name: row.name,
      kind: row.kind as CppSymbolKind,
      path: row.path,
      line: row.line,
    };
    if (row.container) hit.container = row.container;
    if (row.container_chain) hit.containerChain = row.container_chain;
    if (row.params) hit.params = row.params;
    if (row.return_type) hit.returnType = row.return_type;
    if (row.is_impl) hit.isImpl = true;
    out.push(hit);
  }
  return out;
}

function searchFilters(options: CppSymbolSearchOptions): {
  clause: string;
  args: Record<string, string>;
} {
  const conditions: string[] = [];
  const args: Record<string, string> = {};
  if (options.kind) {
    conditions.push("kind = :kind");
    args.kind = options.kind;
  }
  if (options.pathPrefix) {
    conditions.push("path LIKE :pathPrefix");
    args.pathPrefix = `${options.pathPrefix.replace(/\\/g, "/")}%`;
  }
  const clause = conditions.length > 0 ? ` AND ${conditions.join(" AND ")}` : "";
  return { clause, args };
}

/**
 * Progressive symbol search: one indexed prefix sweep (`LIKE 'q%'`) with
 * exact-name rows sorted first; only when that misses, a substring sweep
 * (full scan, tens of ms on a warm cache).
 */
export function searchCppSymbols(
  db: CppSymbolDatabase,
  options: CppSymbolSearchOptions,
): CppSymbolSearchResult {
  const query = options.query.trim().toLowerCase();
  if (!query) return { hits: [], mode: "exact", truncated: false };
  const limit = Math.max(1, options.limit ?? 50);
  const { clause, args } = searchFilters(options);

  const ask = (
    like: string,
    order: string,
    extra: Record<string, string> = {},
  ): CppSymbolHit[] =>
    rowsToHits(
      db
        .prepare(
          `SELECT ${SYMBOL_COLUMNS} FROM symbols
           WHERE name_lower LIKE :like${clause}
           ORDER BY ${order}
           LIMIT :limit`,
        )
        .all({ like, ...extra, ...args, limit: limit + 1 }) as SymbolRow[],
    );

  let hits = ask(
    `${query}%`,
    "CASE WHEN name_lower = :exact THEN 0 ELSE 1 END, name, path",
    { exact: query },
  );
  let mode: CppSymbolSearchResult["mode"] = hits.some(
    (hit) => hit.name.toLowerCase() === query,
  )
    ? "exact"
    : "prefix";
  if (hits.length === 0) {
    hits = ask(`%${query}%`, "name, path");
    mode = "substring";
  }
  const truncated = hits.length > limit;
  return { hits: hits.slice(0, limit), mode, truncated };
}
