/**
 * clangd (LSP) semantic engine for Unreal C++ workspaces.
 *
 * Channels & shapes shared between the Electron main service, the preload
 * bridge and the renderer devmode feature adapters. The text-level
 * cppSymbols index stays the fallback; clangd answers first when its
 * compile database exists (UBT `-Mode=GenerateClangDatabase`).
 */

export const CLANGD_STATUS_CHANNEL = "clangd:status";
export const CLANGD_CANCEL_QUERY_CHANNEL = "clangd:cancelQuery";
export const CLANGD_WORKSPACE_SYMBOLS_CHANNEL = "clangd:workspaceSymbols";
export const CLANGD_REFERENCES_CHANNEL = "clangd:references";
export const CLANGD_DEFINITION_CHANNEL = "clangd:definition";
export const CLANGD_HOVER_CHANNEL = "clangd:hover";
export const CLANGD_COMPLETION_CHANNEL = "clangd:completion";
/**
 * Semantic member completion from clangd's persistent background index
 * (`workspace/symbol` scope queries) — answers while a file's own preamble
 * is still building.
 */
export const CLANGD_INDEX_COMPLETE_CHANNEL = "clangd:indexComplete";
export const CLANGD_SIGNATURE_HELP_CHANNEL = "clangd:signatureHelp";
export const CLANGD_DOC_CHANGED_CHANNEL = "clangd:docChanged";
export const CLANGD_DOC_CLOSED_CHANNEL = "clangd:docClosed";
/** clangd background-index progress (LSP $/progress), pushed to renderer. */
export const CLANGD_PROGRESS_CHANNEL = "clangd:progress";
/** Fire-and-forget: spawn clangd + start the background index early. */
export const CLANGD_ENSURE_CHANNEL = "clangd:ensure";
/** Download the standalone clangd zip into the JellyBot tools dir. */
export const CLANGD_DOWNLOAD_CHANNEL = "clangd:download";

export type ClangdStatus =
  | {
      ok: true;
      clangdPath: string;
      /** Directory containing compile_commands.json. */
      compileCommandsDir: string;
      engineRoot: string | null;
      /** True while a clangd child process is running for this root. */
      running: boolean;
    }
  | { ok: false; message: string };

/**
 * clangd warm-up / index progress pushed to the renderer status bar.
 * - `indexing` / `idle`: background index (LSP $/progress)
 * - `starting` / `ready` / `failed`: server spawn + initialize
 * - `index_loading` / `index_ready`: persistent index load after start
 * - `file`: per-document build state (`textDocument/clangd.fileStatus`)
 */
export type ClangdIndexProgressEvent =
  | {
      rootPath: string;
      phase: "indexing" | "idle";
      /** 0–100 when clangd reports a percentage. */
      percent?: number;
      /** Raw clangd message, e.g. "12/27000". */
      message?: string;
    }
  | {
      rootPath: string;
      /** `index_loading` / `index_ready`: on-disk index shards → memory (~30s on UE). */
      phase: "starting" | "ready" | "failed" | "index_loading" | "index_ready";
      message?: string;
    }
  | {
      rootPath: string;
      phase: "file";
      /** Absolute document path. */
      path: string;
      /** `preamble` = parsing includes (the slow UE part); `parsing` = main file. */
      state: ClangdFileBuildState;
    };

export type ClangdFileBuildState = "preamble" | "parsing" | "idle";

/** 1-based position of the symbol under investigation. */
export type ClangdPositionRequest = {
  /** Absolute file path (editor file / tool read target). */
  path: string;
  /** 1-based line. */
  line: number;
  /** 1-based column in UTF-16 units (Monaco column). Optional: pass `symbol`
   * to auto-locate the first occurrence on the line instead. */
  column?: number;
  /** Symbol name to locate on the line when `column` is omitted. */
  symbol?: string;
  /** Live buffer text (unsaved edits) — synced via didOpen/didChange. */
  text?: string;
  /**
   * Completion only: the trigger character the editor reported (`.` `:` `>`
   * `#` `<` `/`). Maps to LSP triggerKind 2 + triggerCharacter so clangd
   * scopes the result (member access after `.`/`->`, includes after `<`).
   */
  triggerCharacter?: string;
};

export type ClangdLocation = {
  path: string;
  /** 1-based. */
  line: number;
  /** 1-based. */
  column: number;
  /** 1-based end; equals start when the server omitted a range end. */
  endLine: number;
  endColumn: number;
};

export type ClangdReferencesResult =
  | { ok: true; references: ClangdLocation[] }
  | { ok: false; message: string };

export type ClangdDefinitionResult =
  | { ok: true; definitions: ClangdLocation[] }
  | { ok: false; message: string };

export type ClangdHoverResult =
  | { ok: true; markdown: string | null }
  | { ok: false; message: string };

export type ClangdCompletionItem = {
  /** Bare symbol name (header-insertion decorator stripped). */
  label: string;
  kind: number;
  /** Return / variable type (clangd `detail`). */
  detail?: string;
  documentation?: string;
  /**
   * Signature suffix shown after the name — clangd `labelDetails.detail`,
   * e.g. `(float Damage, int32 Count) const`.
   */
  signature?: string;
  /** Text clangd would insert (`textEdit.newText` ?? `insertText`). */
  insertText?: string;
  /** True when `insertText` is an LSP snippet (insertTextFormat 2). */
  isSnippet?: boolean;
  /** Server ranking hint — clangd preorders items by relevance. */
  sortText?: string;
  /** Server filter hint — wins over the plain label when filtering. */
  filterText?: string;
};

export type ClangdCompletionResult =
  /** `isIncomplete`: clangd truncated the list — re-query as the user types. */
  | { ok: true; items: ClangdCompletionItem[]; isIncomplete: boolean }
  | { ok: false; message: string };

export type ClangdSignature = {
  label: string;
  /** 0-based active parameter index (0 when unknown). */
  activeParameter: number;
  parameters: string[];
};

export type ClangdSignatureHelpResult =
  | { ok: true; signatures: ClangdSignature[]; activeSignature: number }
  | { ok: false; message: string };

/** One `workspace/symbol` hit — Quick Open semantic symbol rows. */
export type ClangdWorkspaceSymbol = {
  name: string;
  path: string;
  /** 1-based. */
  line: number;
  /** 1-based. */
  column: number;
  /** Scanner-style kind string ("class" | "struct" | "enum" | …). */
  symbolKind: string;
  container?: string;
};

export type ClangdWorkspaceSymbolsResult =
  | { ok: true; symbols: ClangdWorkspaceSymbol[] }
  | { ok: false; message: string };
