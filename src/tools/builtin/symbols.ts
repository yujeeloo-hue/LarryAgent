/**
 * `symbols` — name-based search over the workspace symbol index (SQLite,
 * built by the Dev Mode CppSymbolIndexService: C++ / TS / JS / CSS).
 *
 * Complements grep: this answers "where is X defined" in milliseconds
 * (indexed prefix/exact sweep), while grep stays the answer for arbitrary
 * text and references. The index is absent in fresh workspaces — the tool
 * then kicks off a background build and tells the model to use grep this
 * turn instead of retrying.
 *
 * The core search lives in {@link runSymbolSearch} so batch_search can mix
 * symbol lookups with content greps in one call.
 */

import { ToolReturnCode } from "../../session/returnCodes.js";
import {
  openCppSymbolDatabase,
  searchCppSymbols,
} from "../../main/cppSymbols/db.js";
import { cppSymbolDatabasePath } from "../../main/cppSymbols/paths.js";
import type { CppSymbolHit } from "../../main/cppSymbols/types.js";
import type {
  ToolDefinition,
  ToolExecuteContext,
  ToolHandler,
} from "../types.js";
import {
  abortIfSignaled,
  displayPath,
  textResult,
  workspaceRootAbsolute,
} from "../pathUtil.js";

const SYMBOL_KINDS = [
  "class",
  "interface",
  "struct",
  "enum",
  "type",
  "function",
  "variable",
] as const;

const SYMBOL_KIND_SET = new Set<string>(SYMBOL_KINDS);

const DEFAULT_LIMIT = 50;
/** Cap one output row so long selectors/signatures cannot blow the context. */
const MAX_ROW_CHARS = 300;

/** Structural slice of CppSymbolIndexService — injected by main at startup. */
type SymbolIndexServiceLike = {
  start(rootPath: string): void;
};

let indexService: SymbolIndexServiceLike | null = null;

/**
 * Wire the running CppSymbolIndexService singleton (Electron main) so the
 * tool can trigger background index builds. Unset in tests / headless hosts;
 * the tool still serves reads from any existing database file.
 */
export function configureSymbolIndexService(
  service: SymbolIndexServiceLike | null,
): void {
  indexService = service;
}

export const symbolsDefinition: ToolDefinition = {
  name: "symbols",
  description:
    "Search the workspace symbol index by name to find where classes, functions, " +
    "types, and variables are DEFINED (C++/TS/JS/CSS). Much faster and more complete " +
    "than grep on large trees. Matching is exact first, then same-prefix, then substring. " +
    "CSS names keep their prefix (.toolbar, --accent); @keyframes names are bare. " +
    "Use grep for references and arbitrary text instead.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Symbol name (e.g. createTurnHost, .toolbar, --accent).",
      },
      kind: {
        type: "string",
        description:
          'Optional kind filter: "class" | "interface" | "struct" | "enum" | "type" | "function" | "variable".',
      },
      path: {
        type: "string",
        description:
          "Optional absolute path prefix limiting the search to one directory.",
      },
    },
    required: ["query"],
  },
  defaultPermissionLevel: 0,
};

/** One compact symbol row (shared with grep's zero-hit fallback hint). */
export function formatSymbolHit(hit: CppSymbolHit): string {
  const bits: string[] = [hit.kind, hit.name];
  if (hit.container) bits.push(`in ${hit.container}`);
  let signature = bits.join(" ");
  if (hit.params !== undefined) signature += `(${hit.params})`;
  if (hit.returnType !== undefined) signature += `: ${hit.returnType}`;
  if (signature.length > MAX_ROW_CHARS) {
    signature = `${signature.slice(0, MAX_ROW_CHARS)}…`;
  }
  return `${displayPath(hit.path)}:${hit.line}: ${signature}`;
}

/**
 * Shared symbol-index search (symbols tool + batch_search symbol queries).
 * Accepts raw argument values; validation failures come back as
 * InvalidArguments results so batch callers can report per-query errors.
 */
export async function runSymbolSearch(input: {
  query: unknown;
  kind?: unknown;
  path?: unknown;
  context: ToolExecuteContext;
}): Promise<{ text: string; returnCode: number }> {
  const query =
    typeof input.query === "string" ? input.query.trim() : "";
  if (query.length < 2) {
    return {
      text: 'Invalid arguments: "query" (string, ≥2 chars) is required.',
      returnCode: ToolReturnCode.InvalidArguments,
    };
  }
  const kind =
    typeof input.kind === "string" && input.kind.trim().length > 0
      ? input.kind.trim()
      : undefined;
  if (kind !== undefined && !SYMBOL_KIND_SET.has(kind)) {
    return {
      text: `Invalid arguments: unknown kind "${kind}". Use one of ${SYMBOL_KINDS.join(", ")}.`,
      returnCode: ToolReturnCode.InvalidArguments,
    };
  }
  const pathPrefix =
    typeof input.path === "string" && input.path.trim().length > 0
      ? input.path.trim()
      : undefined;

  const context = input.context;
  const root = workspaceRootAbsolute(context.workspacePath);
  const shownRoot = displayPath(root);
  const dbPath = cppSymbolDatabasePath(root);

  let db;
  try {
    db = openCppSymbolDatabase(dbPath, { readOnly: true });
  } catch {
    // No database file → the workspace was never indexed (or the build has
    // not finished creating it). Trigger the background build and bail out
    // with guidance so the model does not retry into a wall.
    indexService?.start(root);
    return {
      text:
        `symbols "${query}" in ${shownRoot} — no symbol index for this workspace yet.\n` +
        "A background index build has been started; symbol search becomes available " +
        "once the scan completes. Use grep for this turn.",
      returnCode: ToolReturnCode.Success,
    };
  }

  let result;
  try {
    result = searchCppSymbols(db, {
      query,
      ...(kind !== undefined ? { kind } : {}),
      ...(pathPrefix !== undefined ? { pathPrefix } : {}),
      limit: DEFAULT_LIMIT,
    });
  } catch {
    // Present-but-incomplete database (worker still creating tables on the
    // first build). Same guidance path as a missing database.
    db.close();
    indexService?.start(root);
    return {
      text:
        `symbols "${query}" in ${shownRoot} — symbol index is still building.\n` +
        "Try again after the scan finishes, or use grep for this turn.",
      returnCode: ToolReturnCode.Success,
    };
  }
  db.close();

  const headerBase = `symbols "${query}" in ${shownRoot} — ${result.hits.length} hit(s) (${result.mode} match)`;
  if (result.hits.length === 0) {
    return {
      text: `${headerBase}\n(no matches)`,
      returnCode: ToolReturnCode.Success,
    };
  }
  const notes: string[] = [];
  if (result.truncated) notes.push(`showing first ${DEFAULT_LIMIT}`);
  const header =
    notes.length > 0 ? `${headerBase} (truncated: ${notes.join(", ")})` : headerBase;
  return {
    text: `${header}\n${result.hits.map(formatSymbolHit).join("\n")}`,
    returnCode: ToolReturnCode.Success,
  };
}

export const symbolsHandler: ToolHandler = async (args, context) => {
  const aborted = abortIfSignaled(context.signal);
  if (aborted) return aborted;

  const result = await runSymbolSearch({
    query: args.query,
    kind: args.kind,
    path: args.path,
    context,
  });
  return textResult(result.text, result.returnCode);
};
