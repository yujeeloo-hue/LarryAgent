import type {
  TsLsCompletionItem,
  TsLsCompletionResult,
  TsLsHoverResult,
  TsLsLocation,
  TsLsLocationsResult,
  TsLsPositionRequest,
  TsLsRange,
  TsLsResolveRequest,
  TsLsResolveResult,
  TsLsSignatureHelpResult,
  TsLsTextEdit,
  TsLsUnavailable,
} from "../../../main/tsLs/types.js";
import { COMPLETION_KIND_MAP, compactSignatureInformation } from "./clangdFeatures.js";
import { modelUriToPath } from "./cppLanguageFeatures.js";

export const TS_LANGUAGE_IDS = ["typescript", "javascript"] as const;

export const TS_WORKER_MODE_CONFIGURATION = {
  completionItems: false,
  hovers: false,
  documentSymbols: true,
  definitions: false,
  references: false,
  documentHighlights: true,
  rename: false,
  diagnostics: false,
  documentRangeFormattingEdits: true,
  signatureHelp: false,
  onTypeFormattingEdits: true,
  codeActions: false,
  inlayHints: false,
} as const;

const TEXT_KIND = 18;
const INSERT_AS_SNIPPET = 4;

type TsBridge = {
  tsLsCompletion: (rootPath: string, request: TsLsPositionRequest) => Promise<TsLsCompletionResult>;
  tsLsResolveCompletion: (rootPath: string, request: TsLsResolveRequest) => Promise<TsLsResolveResult>;
  tsLsHover: (rootPath: string, request: TsLsPositionRequest) => Promise<TsLsHoverResult>;
  tsLsSignatureHelp: (rootPath: string, request: TsLsPositionRequest) => Promise<TsLsSignatureHelpResult>;
  tsLsDefinition: (rootPath: string, request: TsLsPositionRequest) => Promise<TsLsLocationsResult>;
  tsLsReferences: (rootPath: string, request: TsLsPositionRequest) => Promise<TsLsLocationsResult>;
  tsLsDocChanged: (rootPath: string, path: string, text: string) => Promise<{ ok: true }>;
  tsLsDocClosed: (rootPath: string, path: string) => Promise<{ ok: true }>;
};

function bridge(): Partial<TsBridge> | null {
  return (window as { jellybot?: Partial<TsBridge> }).jellybot ?? null;
}

export type TsModel = {
  getValue(): string;
  getWordUntilPosition(position: TsPosition): { startColumn: number; endColumn: number };
  uri: { scheme: string; path: string };
};

export type TsPosition = { lineNumber: number; column: number };

type MonacoRange = { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number };

export type TsMonacoLike = {
  languages: {
    registerCompletionItemProvider(languageId: string, provider: unknown): { dispose(): void };
    registerHoverProvider(languageId: string, provider: unknown): { dispose(): void };
    registerSignatureHelpProvider(languageId: string, provider: unknown): { dispose(): void };
    registerDefinitionProvider(languageId: string, provider: unknown): { dispose(): void };
    registerReferenceProvider(languageId: string, provider: unknown): { dispose(): void };
  };
  Uri: { file(path: string): unknown };
};

export type TsProviderDeps = {
  getWorkspaceRoot: () => string | null;
  onUnavailable?: (message: string) => void;
};

type TsSuggestion = {
  label: string;
  kind: number;
  insertText: string;
  range: MonacoRange;
  insertTextRules?: number;
  detail?: string;
  documentation?: { value: string };
  sortText?: string;
  filterText?: string;
  additionalTextEdits?: { range: MonacoRange; text: string }[];
  tsResolve?: { root: string; path: string; resolveId: string };
};

export function isTypeScriptPath(path: string): boolean {
  return /\.(?:[cm]?[jt]s|[jt]sx)$/i.test(path);
}

function requestFor(model: TsModel, position: TsPosition, triggerCharacter?: string): TsLsPositionRequest | null {
  const path = modelUriToPath(model.uri);
  if (!path) return null;
  return {
    path,
    line: position.lineNumber,
    column: position.column,
    text: model.getValue(),
    ...(triggerCharacter ? { triggerCharacter } : {}),
  };
}

function toMonacoRange(range: TsLsRange): MonacoRange {
  return {
    startLineNumber: range.startLine,
    startColumn: range.startColumn,
    endLineNumber: range.endLine,
    endColumn: range.endColumn,
  };
}

function toMonacoEdits(edits: readonly TsLsTextEdit[] | undefined) {
  return (edits ?? []).map((edit) => ({ range: toMonacoRange(edit.range), text: edit.text }));
}

export function suggestionRange(item: TsLsCompletionItem, position: TsPosition, fallback: MonacoRange): MonacoRange {
  const range = item.range;
  if (
    !range ||
    range.startLine !== position.lineNumber ||
    range.endLine !== position.lineNumber ||
    range.startColumn > position.column ||
    range.endColumn < position.column
  ) {
    return fallback;
  }
  return toMonacoRange(range);
}

function toLocations(monaco: TsMonacoLike, locations: readonly TsLsLocation[]) {
  return locations.map((loc) => ({
    uri: monaco.Uri.file(loc.path),
    range: { startLineNumber: loc.line, startColumn: loc.column, endLineNumber: loc.line, endColumn: loc.column },
  }));
}

export function syncTsDocument(root: string, path: string, text: string): void {
  void bridge()?.tsLsDocChanged?.(root, path, text).catch(() => {});
}

export function closeTsDocument(root: string, path: string): void {
  void bridge()?.tsLsDocClosed?.(root, path).catch(() => {});
}

async function locations(
  method: "tsLsDefinition" | "tsLsReferences",
  root: string,
  model: TsModel,
  position: TsPosition,
): Promise<TsLsLocationsResult | null> {
  const api = bridge()?.[method];
  const request = requestFor(model, position);
  if (!api || !request) return null;
  try {
    return await api(root, request);
  } catch {
    return null;
  }
}

export async function tsDefinition(root: string, model: TsModel, position: TsPosition): Promise<TsLsLocation[] | null> {
  const result = await locations("tsLsDefinition", root, model, position);
  return result?.ok ? result.locations : null;
}

export function registerTsProviders(monaco: TsMonacoLike, deps: TsProviderDeps): { dispose(): void } {
  let notified = false;
  const unavailable = (result: TsLsUnavailable): null => {
    if (result.reason === "not_found" && !notified) {
      notified = true;
      deps.onUnavailable?.(result.message);
    }
    return null;
  };

  const completionProvider = {
    triggerCharacters: [".", "\"", "'", "`", "/", "@", "<", "#"],
    provideCompletionItems: async (model: TsModel, position: TsPosition, context: { triggerCharacter?: string }) => {
      const root = deps.getWorkspaceRoot();
      const api = bridge()?.tsLsCompletion;
      const request = requestFor(model, position, context?.triggerCharacter);
      if (!root || !api || !request) return { suggestions: [] };
      let result: TsLsCompletionResult;
      try {
        result = await api(root, request);
      } catch {
        return { suggestions: [] };
      }
      if (!result.ok) {
        unavailable(result);
        return { suggestions: [] };
      }
      const word = model.getWordUntilPosition(position);
      const fallback = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: position.column,
      };
      return {
        incomplete: result.isIncomplete,
        suggestions: result.items.map((item): TsSuggestion => ({
          label: item.label,
          kind: COMPLETION_KIND_MAP[item.kind] ?? TEXT_KIND,
          insertText: item.insertText,
          range: suggestionRange(item, position, fallback),
          ...(item.isSnippet ? { insertTextRules: INSERT_AS_SNIPPET } : {}),
          ...(item.detail ? { detail: item.detail } : {}),
          ...(item.documentation ? { documentation: { value: item.documentation } } : {}),
          ...(item.sortText ? { sortText: item.sortText } : {}),
          ...(item.filterText ? { filterText: item.filterText } : {}),
          ...(item.additionalEdits ? { additionalTextEdits: toMonacoEdits(item.additionalEdits) } : {}),
          ...(item.resolveId ? { tsResolve: { root, path: request.path, resolveId: item.resolveId } } : {}),
        })),
      };
    },
    resolveCompletionItem: async (item: TsSuggestion) => {
      const api = bridge()?.tsLsResolveCompletion;
      if (!api || !item.tsResolve) return item;
      try {
        const resolved = await api(item.tsResolve.root, { path: item.tsResolve.path, resolveId: item.tsResolve.resolveId });
        if (!resolved.ok) return item;
        const additional = [...(item.additionalTextEdits ?? []), ...toMonacoEdits(resolved.additionalEdits)];
        return {
          ...item,
          ...(resolved.detail ? { detail: resolved.detail } : {}),
          ...(resolved.documentation ? { documentation: { value: resolved.documentation } } : {}),
          ...(additional.length > 0 ? { additionalTextEdits: additional } : {}),
        };
      } catch {
        return item;
      }
    },
  };

  const hoverProvider = {
    provideHover: async (model: TsModel, position: TsPosition) => {
      const root = deps.getWorkspaceRoot();
      const api = bridge()?.tsLsHover;
      const request = requestFor(model, position);
      if (!root || !api || !request) return null;
      try {
        const result = await api(root, request);
        if (!result.ok) return unavailable(result);
        return result.markdown ? { contents: [{ value: result.markdown }] } : null;
      } catch {
        return null;
      }
    },
  };

  const signatureHelpProvider = {
    signatureHelpTriggerCharacters: ["(", ",", "<"],
    signatureHelpRetriggerCharacters: [","],
    provideSignatureHelp: async (model: TsModel, position: TsPosition) => {
      const root = deps.getWorkspaceRoot();
      const api = bridge()?.tsLsSignatureHelp;
      const request = requestFor(model, position);
      if (!root || !api || !request) return null;
      try {
        const result = await api(root, request);
        if (!result.ok) return unavailable(result);
        if (result.signatures.length === 0) return null;
        const active = Math.min(result.activeSignature, result.signatures.length - 1);
        const activeParameter = result.signatures[active]?.activeParameter ?? 0;
        return {
          value: {
            activeSignature: active,
            activeParameter,
            signatures: result.signatures.map((sig) => compactSignatureInformation(sig, activeParameter)),
          },
          dispose: () => {},
        };
      } catch {
        return null;
      }
    },
  };

  const definitionProvider = {
    provideDefinition: async (model: TsModel, position: TsPosition) => {
      const root = deps.getWorkspaceRoot();
      if (!root) return null;
      const result = await locations("tsLsDefinition", root, model, position);
      if (!result) return null;
      if (!result.ok) return unavailable(result);
      return toLocations(monaco, result.locations);
    },
  };

  const referenceProvider = {
    provideReferences: async (model: TsModel, position: TsPosition) => {
      const root = deps.getWorkspaceRoot();
      if (!root) return null;
      const result = await locations("tsLsReferences", root, model, position);
      if (!result) return null;
      if (!result.ok) return unavailable(result);
      return toLocations(monaco, result.locations);
    },
  };

  const registrations = TS_LANGUAGE_IDS.flatMap((languageId) => [
    monaco.languages.registerCompletionItemProvider(languageId, completionProvider),
    monaco.languages.registerHoverProvider(languageId, hoverProvider),
    monaco.languages.registerSignatureHelpProvider(languageId, signatureHelpProvider),
    monaco.languages.registerDefinitionProvider(languageId, definitionProvider),
    monaco.languages.registerReferenceProvider(languageId, referenceProvider),
  ]);
  return {
    dispose(): void {
      for (const registration of registrations) registration.dispose();
    },
  };
}
