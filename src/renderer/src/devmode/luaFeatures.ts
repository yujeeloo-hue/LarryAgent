import type {
  LuaLsCompletionResult,
  LuaLsDefinitionResult,
  LuaLsHoverResult,
  LuaLsLocation,
  LuaLsPositionRequest,
  LuaLsPrepareRenameResult,
  LuaLsRenameResult,
  LuaLsSemanticTokensRequest,
  LuaLsSemanticTokensResult,
  LuaLsSignatureHelpResult,
  LuaLsUnavailable,
} from "../../../main/luaLs/types.js";
import { LUA_SEMANTIC_TOKEN_MODIFIERS, LUA_SEMANTIC_TOKEN_TYPES } from "../../../shared/luaSemanticLegend.js";
import { COMPLETION_KIND_MAP, compactSignatureInformation } from "./clangdFeatures.js";
import { modelUriToPath } from "./cppLanguageFeatures.js";
import type { SymbolRenameBackend } from "./SymbolRenameController.js";

export const LUA_LANGUAGE_ID = "lua";

const TEXT_KIND = 18;
const INSERT_AS_SNIPPET = 4;

type LuaBridge = {
  luaLsCompletion: (rootPath: string, request: LuaLsPositionRequest) => Promise<LuaLsCompletionResult>;
  luaLsHover: (rootPath: string, request: LuaLsPositionRequest) => Promise<LuaLsHoverResult>;
  luaLsSignatureHelp: (rootPath: string, request: LuaLsPositionRequest) => Promise<LuaLsSignatureHelpResult>;
  luaLsDefinition: (rootPath: string, request: LuaLsPositionRequest) => Promise<LuaLsDefinitionResult>;
  luaLsPrepareRename: (rootPath: string, request: LuaLsPositionRequest) => Promise<LuaLsPrepareRenameResult>;
  luaLsRename: (rootPath: string, request: LuaLsPositionRequest, newName: string) => Promise<LuaLsRenameResult>;
  luaLsDocChanged: (rootPath: string, path: string, text: string) => Promise<{ ok: true }>;
  luaLsDocClosed: (rootPath: string, path: string) => Promise<{ ok: true }>;
  luaLsSemanticTokens: (rootPath: string, request: LuaLsSemanticTokensRequest) => Promise<LuaLsSemanticTokensResult>;
};

export function luaRenameBackend(): SymbolRenameBackend {
  const unavailable = { ok: false as const, message: "The Lua language server is not available." };
  const failure = (err: unknown) => ({
    ok: false as const,
    message: err instanceof Error ? err.message : String(err),
  });
  return {
    prepare: async (root, request) => {
      const api = bridge()?.luaLsPrepareRename;
      if (!api) return unavailable;
      try {
        const result = await api(root, request);
        return result.ok ? { ok: true, range: result.range } : { ok: false, message: result.message };
      } catch (err) {
        return failure(err);
      }
    },
    rename: async (root, request, newName) => {
      const api = bridge()?.luaLsRename;
      if (!api) return unavailable;
      try {
        const result = await api(root, request, newName);
        return result.ok ? { ok: true, files: result.files } : { ok: false, message: result.message };
      } catch (err) {
        return failure(err);
      }
    },
  };
}

export const LUA_SEMANTIC_RETRY_MS = 2000;
const LUA_SEMANTIC_MAX_RETRIES = 90;

function bridge(): Partial<LuaBridge> | null {
  return (window as { jellybot?: Partial<LuaBridge> }).jellybot ?? null;
}

export type LuaModel = {
  getValue(): string;
  getWordUntilPosition(position: LuaPosition): { startColumn: number; endColumn: number };
  uri: { scheme: string; path: string };
};

export type LuaPosition = { lineNumber: number; column: number };

export type LuaMonacoLike = {
  languages: {
    registerCompletionItemProvider(languageId: string, provider: unknown): { dispose(): void };
    registerHoverProvider(languageId: string, provider: unknown): { dispose(): void };
    registerSignatureHelpProvider(languageId: string, provider: unknown): { dispose(): void };
    registerDocumentSemanticTokensProvider?(languageId: string, provider: unknown): { dispose(): void };
  };
};

export type LuaProviderDeps = {
  getWorkspaceRoot: () => string | null;
  onUnavailable?: (message: string) => void;
};

export function isLuaPath(path: string): boolean {
  return /\.lua$/i.test(path);
}

function requestFor(model: LuaModel, position: LuaPosition, triggerCharacter?: string): LuaLsPositionRequest | null {
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

export function syncLuaDocument(root: string, path: string, text: string): void {
  void bridge()?.luaLsDocChanged?.(root, path, text).catch(() => {});
}

export function closeLuaDocument(root: string, path: string): void {
  void bridge()?.luaLsDocClosed?.(root, path).catch(() => {});
}

export async function luaDefinition(
  root: string,
  model: LuaModel,
  position: LuaPosition,
): Promise<LuaLsLocation[] | null> {
  const api = bridge()?.luaLsDefinition;
  const request = requestFor(model, position);
  if (!api || !request) return null;
  try {
    const result = await api(root, request);
    return result.ok ? result.definitions : null;
  } catch {
    return null;
  }
}

export function registerLuaProviders(monaco: LuaMonacoLike, deps: LuaProviderDeps): { dispose(): void } {
  let notified = false;
  const unavailable = (result: LuaLsUnavailable): null => {
    if (result.reason === "not_found" && !notified) {
      notified = true;
      deps.onUnavailable?.(result.message);
    }
    return null;
  };

  const completionProvider = {
    triggerCharacters: [".", ":"],
    provideCompletionItems: async (
      model: LuaModel,
      position: LuaPosition,
      context: { triggerCharacter?: string },
    ) => {
      const root = deps.getWorkspaceRoot();
      const api = bridge()?.luaLsCompletion;
      const request = requestFor(model, position, context?.triggerCharacter);
      if (!root || !api || !request) return { suggestions: [] };
      let result: LuaLsCompletionResult;
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
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: position.column,
      };
      return {
        incomplete: result.isIncomplete,
        suggestions: result.items.map((item) => ({
          label: item.label,
          kind: COMPLETION_KIND_MAP[item.kind] ?? TEXT_KIND,
          insertText: item.insertText,
          range,
          ...(item.isSnippet ? { insertTextRules: INSERT_AS_SNIPPET } : {}),
          ...(item.detail ? { detail: item.detail } : {}),
          ...(item.documentation ? { documentation: { value: item.documentation } } : {}),
          ...(item.sortText ? { sortText: item.sortText } : {}),
          ...(item.filterText ? { filterText: item.filterText } : {}),
        })),
      };
    },
  };

  const hoverProvider = {
    provideHover: async (model: LuaModel, position: LuaPosition) => {
      const root = deps.getWorkspaceRoot();
      const api = bridge()?.luaLsHover;
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
    signatureHelpTriggerCharacters: ["(", ","],
    signatureHelpRetriggerCharacters: [","],
    provideSignatureHelp: async (model: LuaModel, position: LuaPosition) => {
      const root = deps.getWorkspaceRoot();
      const api = bridge()?.luaLsSignatureHelp;
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

  const listeners = new Set<() => void>();
  const retries = new Map<string, number>();
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleRefresh = (): void => {
    if (retryTimer !== null) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      for (const listener of [...listeners]) listener();
    }, LUA_SEMANTIC_RETRY_MS);
  };
  const semanticTokensProvider = {
    onDidChange: (listener: () => void) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    getLegend: () => ({
      tokenTypes: [...LUA_SEMANTIC_TOKEN_TYPES],
      tokenModifiers: [...LUA_SEMANTIC_TOKEN_MODIFIERS],
    }),
    provideDocumentSemanticTokens: async (model: LuaModel) => {
      const root = deps.getWorkspaceRoot();
      const api = bridge()?.luaLsSemanticTokens;
      const path = modelUriToPath(model.uri);
      if (!root || !api || !path) return null;
      try {
        const result = await api(root, { path, text: model.getValue() });
        if (!result.ok) return unavailable(result);
        if (result.ready) {
          retries.delete(path);
        } else {
          const count = (retries.get(path) ?? 0) + 1;
          retries.set(path, count);
          if (count <= LUA_SEMANTIC_MAX_RETRIES) scheduleRefresh();
        }
        return { data: Uint32Array.from(result.data) };
      } catch {
        return null;
      }
    },
    releaseDocumentSemanticTokens: () => {},
  };

  const registrations = [
    monaco.languages.registerCompletionItemProvider(LUA_LANGUAGE_ID, completionProvider),
    monaco.languages.registerHoverProvider(LUA_LANGUAGE_ID, hoverProvider),
    monaco.languages.registerSignatureHelpProvider(LUA_LANGUAGE_ID, signatureHelpProvider),
    ...(monaco.languages.registerDocumentSemanticTokensProvider
      ? [monaco.languages.registerDocumentSemanticTokensProvider(LUA_LANGUAGE_ID, semanticTokensProvider)]
      : []),
  ];
  return {
    dispose(): void {
      if (retryTimer !== null) clearTimeout(retryTimer);
      listeners.clear();
      for (const registration of registrations) registration.dispose();
    },
  };
}
