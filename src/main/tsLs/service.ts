import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { agentLogInfo, agentLogWarn } from "../../logging/agentLog.js";
import { LspConnection } from "../clangd/lsp.js";
import { parseSignatureHelp } from "../clangd/signatureHelp.js";
import { luaFileUri, luaHoverMarkdown } from "../luaLs/convert.js";
import { luaPathKey } from "../luaLs/locate.js";
import { LspProgressTracker } from "../lsp/progressTracker.js";
import type { LanguageServerProgressEvent } from "../lsp/progressTypes.js";
import {
  toTsCompletionItems,
  toTsLocations,
  toTsResolvedCompletion,
  tsIdentifierPrefixAt,
} from "./convert.js";
import { findTypeScriptServer, typescriptDocumentLanguage } from "./locate.js";
import type {
  TsLsCompletionResult,
  TsLsHoverResult,
  TsLsLocationsResult,
  TsLsPositionRequest,
  TsLsResolveRequest,
  TsLsResolveResult,
  TsLsSignatureHelpResult,
  TsLsUnavailable,
} from "./types.js";

type DocState = { version: number; text: string };

type CompletionList = { serial: number; path: string; items: unknown[] };

type Session = {
  root: string;
  conn: LspConnection;
  docs: Map<string, DocState>;
  progress: LspProgressTracker;
  completion: CompletionList | null;
};

const TEXT_DOCUMENT_CAPABILITIES = {
  completion: {
    dynamicRegistration: false,
    contextSupport: true,
    completionItem: {
      snippetSupport: true,
      labelDetailsSupport: true,
      documentationFormat: ["markdown", "plaintext"],
      resolveSupport: { properties: ["detail", "documentation", "additionalTextEdits"] },
    },
  },
};

const REQUEST_TIMEOUT_MS = 30_000;
const NOT_FOUND_MESSAGE =
  "The bundled TypeScript language server is missing. Reinstall the app to restore it.";

function rawItems(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  const items = (raw as { items?: unknown } | null)?.items;
  return Array.isArray(items) ? items : [];
}

export class TypeScriptLanguageService {
  private readonly sessions = new Map<string, Session>();
  private readonly starting = new Map<string, Promise<Session | TsLsUnavailable>>();
  private completionSerial = 0;

  constructor(
    private readonly locateServer: () => string | null = () => findTypeScriptServer(),
    private readonly onProgress: (event: LanguageServerProgressEvent) => void = () => {},
  ) {}

  private sessionFor(workspaceRoot: string): Promise<Session | TsLsUnavailable> {
    const root = resolve(workspaceRoot);
    const key = luaPathKey(root);
    const existing = this.sessions.get(key);
    if (existing) return Promise.resolve(existing);
    const pending = this.starting.get(key);
    if (pending) return pending;
    const started = this.start(root, key).finally(() => this.starting.delete(key));
    this.starting.set(key, started);
    return started;
  }

  private async start(root: string, key: string): Promise<Session | TsLsUnavailable> {
    const serverPath = this.locateServer();
    if (!serverPath) return { ok: false, reason: "not_found", message: NOT_FOUND_MESSAGE };
    const progress = new LspProgressTracker("typescript", root, this.onProgress);
    progress.starting();
    let session: Session | null = null;
    try {
      const conn = await LspConnection.start(
        serverPath,
        ["--lsp", "--stdio"],
        {
          rootUri: luaFileUri(root),
          label: "TypeScript language server",
          textDocumentCapabilities: TEXT_DOCUMENT_CAPABILITIES,
          onExit: () => {
            if (!session || this.sessions.get(key) !== session) return;
            this.sessions.delete(key);
            progress.idle();
          },
        },
        root,
      );
      conn.onNotification = (method, params) => {
        if (method === "$/progress") progress.handle(params);
      };
      session = { root, conn, docs: new Map(), progress, completion: null };
      this.sessions.set(key, session);
      progress.initialized();
      agentLogInfo("ts_ls.started", { root, serverPath });
      return session;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      agentLogWarn("ts_ls.start_failed", { root, serverPath, message });
      progress.failed(message);
      return { ok: false, reason: "failed", message: `TypeScript language server failed to start: ${message}` };
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
        textDocument: { uri, languageId: typescriptDocumentLanguage(path) ?? "typescript", version: 1, text: body },
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
    request: TsLsPositionRequest,
    method: string,
    extra: Record<string, unknown> = {},
  ): Promise<{ ok: true; result: unknown; session: Session } | TsLsUnavailable> {
    const session = await this.sessionFor(workspaceRoot);
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
      return { ok: true, result, session };
    } catch (err) {
      return { ok: false, reason: "failed", message: err instanceof Error ? err.message : String(err) };
    }
  }

  async docChanged(workspaceRoot: string, path: string, text: string): Promise<void> {
    const session = await this.sessionFor(workspaceRoot);
    if (!("ok" in session)) await this.sync(session, path, text);
  }

  docClosed(workspaceRoot: string, path: string): void {
    const session = this.sessions.get(luaPathKey(resolve(workspaceRoot)));
    if (!session) return;
    const uri = luaFileUri(path);
    if (!session.docs.delete(uri)) return;
    if (session.completion?.path === path) session.completion = null;
    session.conn.notify("textDocument/didClose", { textDocument: { uri } });
  }

  async completion(workspaceRoot: string, request: TsLsPositionRequest): Promise<TsLsCompletionResult> {
    const context = request.triggerCharacter
      ? { triggerKind: 2, triggerCharacter: request.triggerCharacter }
      : { triggerKind: 1 };
    const res = await this.positionRequest(workspaceRoot, request, "textDocument/completion", { context });
    if (!res.ok) return res;
    const serial = ++this.completionSerial;
    const items = rawItems(res.result);
    res.session.completion = { serial, path: request.path, items };
    const prefix = request.text ? tsIdentifierPrefixAt(request.text, request.line, request.column) : "";
    return { ok: true, ...toTsCompletionItems(res.result, prefix, String(serial)) };
  }

  async resolveCompletion(workspaceRoot: string, request: TsLsResolveRequest): Promise<TsLsResolveResult> {
    const session = this.sessions.get(luaPathKey(resolve(workspaceRoot)));
    const [serial, index] = request.resolveId.split(":").map(Number);
    const list = session?.completion;
    const item = list && list.serial === serial && list.path === request.path ? list.items[index ?? -1] : undefined;
    if (!session || !item) return { ok: true };
    try {
      const result = await session.conn.request("completionItem/resolve", item, REQUEST_TIMEOUT_MS);
      return { ok: true, ...toTsResolvedCompletion(result) };
    } catch (err) {
      return { ok: false, reason: "failed", message: err instanceof Error ? err.message : String(err) };
    }
  }

  async hover(workspaceRoot: string, request: TsLsPositionRequest): Promise<TsLsHoverResult> {
    const res = await this.positionRequest(workspaceRoot, request, "textDocument/hover");
    if (!res.ok) return res;
    return { ok: true, markdown: luaHoverMarkdown(res.result) };
  }

  async signatureHelp(workspaceRoot: string, request: TsLsPositionRequest): Promise<TsLsSignatureHelpResult> {
    const res = await this.positionRequest(workspaceRoot, request, "textDocument/signatureHelp");
    if (!res.ok) return res;
    return parseSignatureHelp(res.result);
  }

  async definition(workspaceRoot: string, request: TsLsPositionRequest): Promise<TsLsLocationsResult> {
    const res = await this.positionRequest(workspaceRoot, request, "textDocument/definition");
    if (!res.ok) return res;
    return { ok: true, locations: toTsLocations(res.result) };
  }

  async references(workspaceRoot: string, request: TsLsPositionRequest): Promise<TsLsLocationsResult> {
    const res = await this.positionRequest(workspaceRoot, request, "textDocument/references", {
      context: { includeDeclaration: true },
    });
    if (!res.ok) return res;
    return { ok: true, locations: toTsLocations(res.result) };
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
