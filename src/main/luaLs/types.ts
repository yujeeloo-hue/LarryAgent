import type { ClangdSignature } from "../clangd/types.js";
import type { LspFileEdit, LspRange } from "../../shared/lspEdits.js";

export const LUA_LS_DOC_CHANGED_CHANNEL = "luaLs:docChanged";
export const LUA_LS_PREPARE_RENAME_CHANNEL = "luaLs:prepareRename";
export const LUA_LS_RENAME_CHANNEL = "luaLs:rename";
export const LUA_LS_DOC_CLOSED_CHANNEL = "luaLs:docClosed";
export const LUA_LS_COMPLETION_CHANNEL = "luaLs:completion";
export const LUA_LS_HOVER_CHANNEL = "luaLs:hover";
export const LUA_LS_SIGNATURE_HELP_CHANNEL = "luaLs:signatureHelp";
export const LUA_LS_DEFINITION_CHANNEL = "luaLs:definition";
export const LUA_LS_SCRIPT_ROOTS_CHANNEL = "luaLs:scriptRoots";
export const LUA_LS_SEMANTIC_TOKENS_CHANNEL = "luaLs:semanticTokens";

export type LuaLsPositionRequest = {
  path: string;
  line: number;
  column: number;
  text?: string;
  triggerCharacter?: string;
};

export type LuaLsUnavailable = {
  ok: false;
  reason: "not_found" | "failed";
  message: string;
};

export type LuaLsProgressEvent =
  | { rootPath: string; phase: "starting" | "idle" }
  | { rootPath: string; phase: "loading"; message?: string }
  | { rootPath: string; phase: "diagnosing"; percent?: number }
  | { rootPath: string; phase: "failed"; message: string };

export type LuaLsCompletionItem = {
  label: string;
  kind: number;
  insertText: string;
  isSnippet: boolean;
  detail?: string;
  documentation?: string;
  sortText?: string;
  filterText?: string;
};

export type LuaLsCompletionResult =
  | { ok: true; items: LuaLsCompletionItem[]; isIncomplete: boolean }
  | LuaLsUnavailable;

export type LuaLsHoverResult =
  | { ok: true; markdown: string | null }
  | LuaLsUnavailable;

export type LuaLsSignatureHelpResult =
  | { ok: true; signatures: ClangdSignature[]; activeSignature: number }
  | LuaLsUnavailable;

export type LuaLsLocation = { path: string; line: number; column: number };

export type LuaLsDefinitionResult =
  | { ok: true; definitions: LuaLsLocation[] }
  | LuaLsUnavailable;

export type LuaLsPrepareRenameResult =
  | { ok: true; range: LspRange | null }
  | LuaLsUnavailable;

export type LuaLsRenameResult =
  | { ok: true; files: LspFileEdit[] }
  | LuaLsUnavailable;

export type LuaLsSemanticTokensRequest = { path: string; text?: string };

export type LuaLsSemanticTokensResult =
  | { ok: true; data: number[]; ready: boolean }
  | LuaLsUnavailable;
