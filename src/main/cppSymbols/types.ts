export const CPP_SYMBOL_SCANNER_VERSION = 4;

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
export const CPP_SYMBOL_SEARCH_CHANNEL = "cpp-symbols:search";
export const CPP_SYMBOL_COMPLETE_CHANNEL = "cpp-symbols:complete";

export type CppCompletionRequest = {
  prefix: string;
  container?: string;
  memberOf?: string;
  receiver?: string;
  chain?: string[];
  limit?: number;
};

const COMPLETION_IDENT = /^[A-Za-z_]\w*$/;

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
  depth?: number;
};

export const CPP_SYMBOL_ROOTS_CHANNEL = "cpp-symbols:roots";
export const CPP_SYMBOL_ADD_ROOT_CHANNEL = "cpp-symbols:addRoot";
export const CPP_SYMBOL_REMOVE_ROOT_CHANNEL = "cpp-symbols:removeRoot";

export type CppSymbolRootsResult =
  | { ok: true; extraRoots: string[] }
  | { ok: false; message: string };

export type CppSymbolRootMutationResult =
  | { ok: true; extraRoots: string[]; restarted: boolean; message?: string }
  | { ok: false; message: string };
