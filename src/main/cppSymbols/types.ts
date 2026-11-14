/**
 * Bump when the line scanner's stored shape changes — the next open rebuilds.
 * v2: the index grew from C++-only to C++ + TS/JS + CSS (scanIndexSymbols),
 * so every pre-v2 database rebuilds to pick up the new language files.
 * v3: file-scope free functions (headers + sources) and the one-line
 * `class X {};` container fix.
 */
export const CPP_SYMBOL_SCANNER_VERSION = 3;

export const CPP_SYMBOL_DB_FILENAME = "cpp-symbols.sqlite";

export const CPP_SYMBOL_GITIGNORE_COMMENT =
  "# C++ symbol index (local; do not commit)";

export const CPP_SYMBOL_GITIGNORE_LINES = [
  ".jellybot/cpp-symbols.sqlite",
  ".jellybot/cpp-symbols.sqlite-wal",
  ".jellybot/cpp-symbols.sqlite-shm",
] as const;

export type CppSymbolKind =
  | "class"
  | "interface"
  | "struct"
  | "enum"
  | "type"
  | "function"
  | "variable";

/** One definition row returned to F12. Optional fields are omitted when empty. */
export type CppSymbolHit = {
  name: string;
  kind: CppSymbolKind;
  path: string;
  line: number;
  container?: string;
  containerChain?: string;
  params?: string;
  returnType?: string;
  isImpl?: boolean;
};

export type CppSymbolProgressEvent = {
  rootPath: string;
  phase: "scanning" | "idle";
  filesDone: number;
  filesTotal: number;
};

export const CPP_SYMBOL_PROGRESS_CHANNEL = "cpp-symbols:progress";
export const CPP_SYMBOL_LOOKUP_CHANNEL = "cpp-symbols:lookup";
/** Text-index completion — fallback while clangd is absent or cold. */
export const CPP_SYMBOL_COMPLETE_CHANNEL = "cpp-symbols:complete";
export const CPP_USAGE_SEARCH_CHANNEL = "cpp-symbols:findUsages";

export type CppCompletionRequest = {
  /** Identifier typed so far (may be empty after `this->` / `.` / `::`). */
  prefix: string;
  /** Class enclosing the caret (`ANFCharacter::Foo` body / class body). */
  container?: string;
  /** Member access on this class (`this->`, `X::`, resolved receiver type). */
  memberOf?: string;
  /** Receiver identifier for `Name->` / `Name.` when its type is unknown. */
  receiver?: string;
  /**
   * Fields to walk after the starting type.
   * `Target->Audio->` with `Target`'s type already known is `["Audio"]`.
   * A chain of members on the enclosing class is the whole list.
   */
  chain?: string[];
  limit?: number;
};

const COMPLETION_IDENT = /^[A-Za-z_]\w*$/;

/** Identifier list for `CppCompletionRequest.chain` (1–6 names). */
export function parseCompletionChain(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 6) return undefined;
  const chain: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !COMPLETION_IDENT.test(item)) return undefined;
    chain.push(item);
  }
  return chain;
}

export type CppCompletionHit = CppSymbolHit & {
  /** 0 = own class, 1 = direct base, …; absent for non-members. */
  depth?: number;
};
export const CPP_USAGE_CANCEL_CHANNEL = "cpp-symbols:cancelFindUsages";

export type CppUsageSearchRequest = {
  queryId: string;
  word: string;
  overlay?: { path: string; text: string };
};

export type CppUsageCandidate = {
  path: string;
  line: number;
  column: number;
  lineText: string;
};

export type CppUsageSearchResult = {
  queryId: string;
  matches: CppUsageCandidate[];
  scannedFiles: number;
  truncated: boolean;
  cancelled?: boolean;
};

/** Query the user-added scan roots persisted for one workspace. */
export const CPP_SYMBOL_ROOTS_CHANNEL = "cpp-symbols:roots";
export const CPP_SYMBOL_ADD_ROOT_CHANNEL = "cpp-symbols:addRoot";
export const CPP_SYMBOL_REMOVE_ROOT_CHANNEL = "cpp-symbols:removeRoot";

export type CppSymbolRootsResult =
  | { ok: true; extraRoots: string[] }
  | { ok: false; message: string };

export type CppSymbolRootMutationResult =
  | { ok: true; extraRoots: string[]; restarted: boolean; message?: string }
  | { ok: false; message: string };
