import type { ClangdSignature } from "../clangd/types.js";

export const TS_LS_DOC_CHANGED_CHANNEL = "tsLs:docChanged";
export const TS_LS_DOC_CLOSED_CHANNEL = "tsLs:docClosed";
export const TS_LS_COMPLETION_CHANNEL = "tsLs:completion";
export const TS_LS_RESOLVE_COMPLETION_CHANNEL = "tsLs:resolveCompletion";
export const TS_LS_HOVER_CHANNEL = "tsLs:hover";
export const TS_LS_SIGNATURE_HELP_CHANNEL = "tsLs:signatureHelp";
export const TS_LS_DEFINITION_CHANNEL = "tsLs:definition";
export const TS_LS_REFERENCES_CHANNEL = "tsLs:references";

export type TsLsPositionRequest = {
  path: string;
  line: number;
  column: number;
  text?: string;
  triggerCharacter?: string;
};

export type TsLsUnavailable = {
  ok: false;
  reason: "not_found" | "failed";
  message: string;
};

export type TsLsRange = { startLine: number; startColumn: number; endLine: number; endColumn: number };

export type TsLsTextEdit = { range: TsLsRange; text: string };

export type TsLsCompletionItem = {
  label: string;
  kind: number;
  insertText: string;
  isSnippet: boolean;
  range?: TsLsRange;
  detail?: string;
  documentation?: string;
  sortText?: string;
  filterText?: string;
  additionalEdits?: TsLsTextEdit[];
  resolveId?: string;
};

export type TsLsCompletionResult =
  | { ok: true; items: TsLsCompletionItem[]; isIncomplete: boolean }
  | TsLsUnavailable;

export type TsLsResolveRequest = { path: string; resolveId: string };

export type TsLsResolvedCompletion = {
  detail?: string;
  documentation?: string;
  additionalEdits?: TsLsTextEdit[];
};

export type TsLsResolveResult = ({ ok: true } & TsLsResolvedCompletion) | TsLsUnavailable;

export type TsLsHoverResult =
  | { ok: true; markdown: string | null }
  | TsLsUnavailable;

export type TsLsSignatureHelpResult =
  | { ok: true; signatures: ClangdSignature[]; activeSignature: number }
  | TsLsUnavailable;

export type TsLsLocation = { path: string; line: number; column: number };

export type TsLsLocationsResult =
  | { ok: true; locations: TsLsLocation[] }
  | TsLsUnavailable;
