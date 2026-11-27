import { readFile } from "node:fs/promises";
import { agentLogInfo, agentLogWarn } from "../../logging/agentLog.js";
import { LspConnection } from "../clangd/lsp.js";
import { parseSignatureHelp } from "../clangd/signatureHelp.js";
import {
  LUA_SEMANTIC_TOKEN_MODIFIERS,
  LUA_SEMANTIC_TOKEN_TYPES,
} from "../../shared/luaSemanticLegend.js";
import {
  identifierPrefixAt,
  luaFileUri,
  luaHoverMarkdown,
  luaUriToPath,
  readSemanticLegend,
  remapSemanticTokens,
  toLuaCompletionItems,
  toLuaLocations,
  type SemanticLegend,
} from "./convert.js";
import { findLuaServer, luaPathKey, resolveLuaRoot } from "./locate.js";
import { LspProgressTracker } from "../lsp/progressTracker.js";
import type { LanguageServerProgressEvent } from "../lsp/progressTypes.js";
import type {
  LuaLsCompletionResult,
  LuaLsDefinitionResult,
  LuaLsHoverResult,
  LuaLsPositionRequest,
  LuaLsPrepareRenameResult,
  LuaLsRenameResult,
  LuaLsSemanticTokensRequest,
  LuaLsSemanticTokensResult,
  LuaLsSignatureHelpResult,
  LuaLsUnavailable,
} from "./types.js";
import { parsePrepareRenameResult, parseWorkspaceEdit, RENAME_IDENTIFIER_PATTERN } from "../../shared/lspEdits.js";

type DocState = { version: number; text: string | null };

type Session = {
  root: string;
  conn: LspConnection;
  docs: Map<string, DocState>;
  legend: SemanticLegend | null;
  ready: boolean;
  progress: LspProgressTracker;
};

const CLIENT_LEGEND: SemanticLegend = {
  tokenTypes: LUA_SEMANTIC_TOKEN_TYPES,
  tokenModifiers: LUA_SEMANTIC_TOKEN_MODIFIERS,
};

const SEMANTIC_TOKENS_CAPABILITY = {
  semanticTokens: {
    dynamicRegistration: false,
    requests: { full: true },
    tokenTypes: [...LUA_SEMANTIC_TOKEN_TYPES, "variable", "keyword", "comment", "string", "number", "operator"],
    tokenModifiers: [...LUA_SEMANTIC_TOKEN_MODIFIERS],
    formats: ["relative"],
  },
};

const REQUEST_TIMEOUT_MS = 10_000;
const LOADING_REQUEST_TIMEOUT_MS = 3_000;
const NOT_FOUND_MESSAGE =
  "The bundled Lua language server (emmylua_ls) is missing. Reinstall the app to restore it.";

export class LuaLanguageService {
  private readonly sessions = new Map<string, Session>();
  private readonly starting = new Map<string, Promise<Session | LuaLsUnavailable>>();

  constructor(
    private readonly locateServer: () => string | null = () => findLuaServer(),
    private readonly resolveRoot: (filePath: string, workspaceRoot: string) => string = resolveLuaRoot,
    private readonly onProgress: (event: LanguageServerProgressEvent) => void = () => {},
  ) {}

  private sessionFor(workspaceRoot: string, filePath: string): Promise<Session | LuaLsUnavailable> {
    const root = this.resolveRoot(filePath, workspaceRoot);
    const key = luaPathKey(root);
    const existing = this.sessions.get(key);
    if (existing) return Promise.resolve(existing);
    const pending = this.starting.get(key);
    if (pending) return pending;
    const started = this.start(root, key).finally(() => this.starting.delete(key));
    this.starting.set(key, started);
    return started;
  }

  private async start(root: string, key: string): Promise<Session | LuaLsUnavailable> {
    const serverPath = this.locateServer();
    if (!serverPath) return { ok: false, reason: "not_found", message: NOT_FOUND_MESSAGE };
    const progress = new LspProgressTracker("lua", root, this.onProgress);
    progress.starting();
    let session: Session | null = null;
    try {
      const conn = await LspConnection.start(
        serverPath,
        [],
        {
          rootUri: luaFileUri(root),
          label: "Lua language server",
          textDocumentCapabilities: SEMANTIC_TOKENS_CAPABILITY,
          onExit: () => {
            if (!session || this.sessions.get(key) !== session) return;
            this.sessions.delete(key);
            progress.idle();
          },
        },
        root,
      );
      const docs = new Map<string, DocState>();
      const created: Session = {
        root,
        conn,
        docs,
        legend: readSemanticLegend(conn.serverCapabilities),
        ready: false,
        progress,
      };
      conn.onNotification = (method, params) => {
        if (method !== "$/progress") return;
        progress.handle(params);
        const value = (params as { value?: { kind?: unknown } } | null)?.value;
        if (value?.kind !== "end") return;
        created.ready = true;
        for (const doc of docs.values()) doc.text = null;
      };
      session = created;
      this.sessions.set(key, session);
      progress.initialized();
      agentLogInfo("lua_ls.started", { root, serverPath });
      return session;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      agentLogWarn("lua_ls.start_failed", { root, serverPath, message });
      progress.failed(message);
      return { ok: false, reason: "failed", message: `Lua language server failed to start: ${message}` };
    }
  }

  private async sync(session: Session, path: string, text?: string): Promise<void> {
    const uri = luaFileUri(path);
    const doc = session.docs.get(uri);
    let body = text;
    if (body === undefined) {
      if (doc) return;
      try {
        body = await readFile(path, "utf8");
      } catch {
        return;
      }
    }
    if (!doc) {
      session.docs.set(uri, { version: 1, text: body });
      session.conn.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: "lua", version: 1, text: body },
      });
      return;
    }
    if (doc.text === body) return;
    doc.version += 1;
    doc.text = body;
    session.conn.notify("textDocument/didChange", {
      textDocument: { uri, version: doc.version },
      contentChanges: [{ text: body }],
    });
  }

  private async positionRequest(
    workspaceRoot: string,
    request: LuaLsPositionRequest,
    method: string,
    extra: Record<string, unknown> = {},
  ): Promise<{ ok: true; result: unknown } | LuaLsUnavailable> {
    const session = await this.sessionFor(workspaceRoot, request.path);
    if ("ok" in session) return session;
    try {
      await this.sync(session, request.path, request.text);
      const result = await session.conn.request(
        method,
        {
          textDocument: { uri: luaFileUri(request.path) },
          position: { line: request.line - 1, character: Math.max(0, request.column - 1) },
          ...extra,
        },
        REQUEST_TIMEOUT_MS,
      );
      return { ok: true, result };
    } catch (err) {
      return { ok: false, reason: "failed", message: err instanceof Error ? err.message : String(err) };
    }
  }

  async docChanged(workspaceRoot: string, path: string, text: string): Promise<void> {
    const session = await this.sessionFor(workspaceRoot, path);
    if (!("ok" in session)) await this.sync(session, path, text);
  }

  docClosed(workspaceRoot: string, path: string): void {
    const key = luaPathKey(this.resolveRoot(path, workspaceRoot));
    const session = this.sessions.get(key);
    if (!session) return;
    const uri = luaFileUri(path);
    if (!session.docs.delete(uri)) return;
    session.conn.notify("textDocument/didClose", { textDocument: { uri } });
  }

  async completion(workspaceRoot: string, request: LuaLsPositionRequest): Promise<LuaLsCompletionResult> {
    const context = request.triggerCharacter
      ? { triggerKind: 2, triggerCharacter: request.triggerCharacter }
      : { triggerKind: 1 };
    const res = await this.positionRequest(workspaceRoot, request, "textDocument/completion", { context });
    if (!res.ok) return res;
    const prefix = request.text ? identifierPrefixAt(request.text, request.line, request.column) : "";
    return { ok: true, ...toLuaCompletionItems(res.result, prefix) };
  }

  async hover(workspaceRoot: string, request: LuaLsPositionRequest): Promise<LuaLsHoverResult> {
    const res = await this.positionRequest(workspaceRoot, request, "textDocument/hover");
    if (!res.ok) return res;
    return { ok: true, markdown: luaHoverMarkdown(res.result) };
  }

  async signatureHelp(workspaceRoot: string, request: LuaLsPositionRequest): Promise<LuaLsSignatureHelpResult> {
    const res = await this.positionRequest(workspaceRoot, request, "textDocument/signatureHelp");
    if (!res.ok) return res;
    return parseSignatureHelp(res.result);
  }

  async definition(workspaceRoot: string, request: LuaLsPositionRequest): Promise<LuaLsDefinitionResult> {
    const res = await this.positionRequest(workspaceRoot, request, "textDocument/definition");
    if (!res.ok) return res;
    return { ok: true, definitions: toLuaLocations(res.result) };
  }

  private async renameSupport(
    workspaceRoot: string,
    path: string,
  ): Promise<{ ok: true; prepare: boolean } | LuaLsUnavailable> {
    const session = await this.sessionFor(workspaceRoot, path);
    if ("ok" in session) return session;
    const provider = session.conn.serverCapabilities?.renameProvider;
    if (!provider) {
      return { ok: false, reason: "failed", message: "The Lua language server does not support rename." };
    }
    const prepare = typeof provider === "object" && (provider as { prepareProvider?: unknown }).prepareProvider === true;
    return { ok: true, prepare };
  }

  async prepareRename(workspaceRoot: string, request: LuaLsPositionRequest): Promise<LuaLsPrepareRenameResult> {
    const support = await this.renameSupport(workspaceRoot, request.path);
    if (!support.ok) return support;
    if (!support.prepare) return { ok: true, range: null };
    const res = await this.positionRequest(workspaceRoot, request, "textDocument/prepareRename");
    if (!res.ok) return res;
    const parsed = parsePrepareRenameResult(res.result);
    if (!parsed) return { ok: false, reason: "failed", message: "This symbol cannot be renamed." };
    return { ok: true, range: parsed.range };
  }

  async rename(workspaceRoot: string, request: LuaLsPositionRequest, newName: string): Promise<LuaLsRenameResult> {
    if (!RENAME_IDENTIFIER_PATTERN.test(newName)) {
      return { ok: false, reason: "failed", message: "The new name must be a plain identifier." };
    }
    const support = await this.renameSupport(workspaceRoot, request.path);
    if (!support.ok) return support;
    const res = await this.positionRequest(workspaceRoot, request, "textDocument/rename", { newName });
    if (!res.ok) return res;
    const parsed = parseWorkspaceEdit(res.result, luaUriToPath);
    if (!parsed.ok) return { ok: false, reason: "failed", message: parsed.message };
    return { ok: true, files: parsed.files };
  }

  async semanticTokens(workspaceRoot: string, request: LuaLsSemanticTokensRequest): Promise<LuaLsSemanticTokensResult> {
    const session = await this.sessionFor(workspaceRoot, request.path);
    if ("ok" in session) return session;
    if (!session.legend) return { ok: true, data: [], ready: true };
    const ready = session.ready;
    try {
      await this.sync(session, request.path, request.text);
      const result = await session.conn.request(
        "textDocument/semanticTokens/full",
        { textDocument: { uri: luaFileUri(request.path) } },
        ready ? REQUEST_TIMEOUT_MS : LOADING_REQUEST_TIMEOUT_MS,
      );
      return { ok: true, data: remapSemanticTokens(result, session.legend, CLIENT_LEGEND), ready };
    } catch (err) {
      if (!ready) return { ok: true, data: [], ready: false };
      return { ok: false, reason: "failed", message: err instanceof Error ? err.message : String(err) };
    }
  }

  stopIfRoot(workspaceRoot: string): void {
    const prefix = luaPathKey(workspaceRoot);
    for (const [key, session] of this.sessions) {
      if (key === prefix || key.startsWith(`${prefix}/`)) {
        this.sessions.delete(key);
        session.progress.idle();
        session.conn.dispose();
      }
    }
  }

  stop(): void {
    for (const session of this.sessions.values()) {
      session.progress.idle();
      session.conn.dispose();
    }
    this.sessions.clear();
  }
}
