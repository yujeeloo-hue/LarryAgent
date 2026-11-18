
export const CLANGD_STATUS_CHANNEL = "clangd:status";
export const CLANGD_CANCEL_QUERY_CHANNEL = "clangd:cancelQuery";
export const CLANGD_WORKSPACE_SYMBOLS_CHANNEL = "clangd:workspaceSymbols";
export const CLANGD_REFERENCES_CHANNEL = "clangd:references";
export const CLANGD_DEFINITION_CHANNEL = "clangd:definition";
export const CLANGD_HOVER_CHANNEL = "clangd:hover";
export const CLANGD_COMPLETION_CHANNEL = "clangd:completion";
export const CLANGD_INDEX_COMPLETE_CHANNEL = "clangd:indexComplete";
export const CLANGD_SIGNATURE_HELP_CHANNEL = "clangd:signatureHelp";
export const CLANGD_INCLUDE_DIRS_CHANNEL = "clangd:includeDirs";
export const CLANGD_INCLUDE_LOG_CHANNEL = "clangd:includeLog";
export const CLANGD_DOC_CHANGED_CHANNEL = "clangd:docChanged";
export const CLANGD_DOC_CLOSED_CHANNEL = "clangd:docClosed";
export const CLANGD_PROGRESS_CHANNEL = "clangd:progress";
export const CLANGD_ENSURE_CHANNEL = "clangd:ensure";
export const CLANGD_INSTALL_CHANNEL = "clangd:install";
export const CLANGD_INDEXING_SPEED_CHANNEL = "clangd:indexingSpeed";

export type ClangdIndexingSpeed = "normal" | "full";
export type ClangdIndexingSpeedResult =
  | { ok: true; speed: ClangdIndexingSpeed }
  | { ok: false; message: string };

export type ClangdStatus =
  | {
      ok: true;
      clangdPath: string;
      compileCommandsDir: string;
      engineRoot: string | null;
      running: boolean;
      indexingSpeed: ClangdIndexingSpeed;
    }
  | { ok: false; message: string };

export type ClangdIndexProgressEvent =
  | { rootPath: string; phase: "indexing_speed"; speed: ClangdIndexingSpeed }
  | {
      rootPath: string;
      phase: "indexing" | "idle";
      percent?: number;
      message?: string;
    }
  | {
      rootPath: string;
      phase: "starting" | "ready" | "failed" | "index_loading" | "index_ready" | "generating";
      message?: string;
    }
  | {
      rootPath: string;
      phase: "file";
      path: string;
      state: ClangdFileBuildState;
    };

export type ClangdFileBuildState = "preamble" | "parsing" | "idle";

export type ClangdPositionRequest = {
  path: string;
  line: number;
  column?: number;
  symbol?: string;
  text?: string;
  triggerCharacter?: string;
};

export type ClangdLocation = {
  path: string;
  line: number;
  column: number;
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

export type ClangdTextEdit = {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  newText: string;
};

export type ClangdIncludeDirsResult =
  | { ok: true; dirs: string[] }
  | { ok: false; message: string };

export type ClangdCompletionItem = {
  label: string;
  kind: number;
  detail?: string;
  documentation?: string;
  signature?: string;
  insertText?: string;
  isSnippet?: boolean;
  additionalTextEdits?: ClangdTextEdit[];
  sortText?: string;
  filterText?: string;
};

export type ClangdCompletionResult =
  | { ok: true; items: ClangdCompletionItem[]; isIncomplete: boolean }
  | { ok: false; message: string };

export type ClangdSignature = {
  label: string;
  activeParameter: number;
  parameters: string[];
  documentation?: string;
  parameterDocumentation?: string[];
};

export type ClangdSignatureHelpResult =
  | { ok: true; signatures: ClangdSignature[]; activeSignature: number }
  | { ok: false; message: string };

export type ClangdWorkspaceSymbol = {
  name: string;
  path: string;
  line: number;
  column: number;
  symbolKind: string;
  container?: string;
};

export type ClangdWorkspaceSymbolsResult =
  | { ok: true; symbols: ClangdWorkspaceSymbol[] }
  | { ok: false; message: string };
