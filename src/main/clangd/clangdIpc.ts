
import { ipcMain } from "electron";
import { agentLogInfo } from "../../logging/agentLog.js";
import type { ClangdService } from "./service.js";
import { installLatestClangd } from "./install.js";
import {
  CLANGD_COMPLETION_CHANNEL,
  CLANGD_CANCEL_QUERY_CHANNEL,
  CLANGD_DEFINITION_CHANNEL,
  CLANGD_DOC_CHANGED_CHANNEL,
  CLANGD_DOC_CLOSED_CHANNEL,
  CLANGD_HOVER_CHANNEL,
  CLANGD_INDEX_COMPLETE_CHANNEL,
  CLANGD_REFERENCES_CHANNEL,
  CLANGD_SIGNATURE_HELP_CHANNEL,
  CLANGD_INCLUDE_DIRS_CHANNEL,
  CLANGD_INCLUDE_LOG_CHANNEL,
  CLANGD_STATUS_CHANNEL,
  CLANGD_WORKSPACE_SYMBOLS_CHANNEL,
  CLANGD_ENSURE_CHANNEL,
  CLANGD_INSTALL_CHANNEL,
  CLANGD_INDEXING_SPEED_CHANNEL,
  CLANGD_PREPARE_RENAME_CHANNEL,
  CLANGD_RENAME_CHANNEL,
  type ClangdPositionRequest,
} from "./types.js";
import { parseCompletionChain } from "../cppSymbols/types.js";
import { RENAME_IDENTIFIER_PATTERN } from "../../shared/lspEdits.js";

function parsePositionRequest(input: unknown): ClangdPositionRequest | null {
  if (!input || typeof input !== "object") return null;
  const req = input as Record<string, unknown>;
  if (typeof req.path !== "string" || typeof req.line !== "number") return null;
  return {
    path: req.path,
    line: req.line,
    ...(typeof req.column === "number" ? { column: req.column } : {}),
    ...(typeof req.symbol === "string" ? { symbol: req.symbol } : {}),
    ...(typeof req.text === "string" ? { text: req.text } : {}),
    ...(typeof req.triggerCharacter === "string" && req.triggerCharacter
      ? { triggerCharacter: req.triggerCharacter }
      : {}),
  };
}

export function registerClangdIpc(service: ClangdService): () => void {
  const handlers: [string, (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown][] = [
    [CLANGD_STATUS_CHANNEL, (_e, rootPath: unknown) => {
      if (typeof rootPath !== "string") {
        return Promise.resolve({ ok: false as const, message: "Missing workspace path." });
      }
      return service.status(rootPath);
    }],
    [CLANGD_ENSURE_CHANNEL, (_e, rootPath: unknown) => {
      if (typeof rootPath !== "string") {
        return Promise.resolve({ ok: false as const, message: "Missing workspace path." });
      }
      return service.ensureStarted(rootPath);
    }],
    [CLANGD_INSTALL_CHANNEL, () => installLatestClangd()],
    [CLANGD_INDEXING_SPEED_CHANNEL, (_e, rootPath: unknown, speed: unknown) => {
      if (typeof rootPath !== "string" || (speed !== "normal" && speed !== "full")) {
        return { ok: false as const, message: "Invalid indexing speed request." };
      }
      return service.setIndexingSpeed(rootPath, speed);
    }],
    [CLANGD_REFERENCES_CHANNEL, (_e, rootPath: unknown, request: unknown) => {
      const parsed = parsePositionRequest(request);
      if (typeof rootPath !== "string" || !parsed) {
        return Promise.resolve({ ok: false as const, message: "Expected workspace path and position request." });
      }
      return service.references(rootPath, parsed);
    }],
    [CLANGD_PREPARE_RENAME_CHANNEL, (_e, rootPath: unknown, request: unknown) => {
      const parsed = parsePositionRequest(request);
      if (typeof rootPath !== "string" || !parsed) {
        return Promise.resolve({ ok: false as const, message: "Expected workspace path and position request." });
      }
      return service.prepareRename(rootPath, parsed);
    }],
    [CLANGD_RENAME_CHANNEL, (_e, rootPath: unknown, request: unknown, newName: unknown) => {
      const parsed = parsePositionRequest(request);
      if (typeof rootPath !== "string" || !parsed) {
        return Promise.resolve({ ok: false as const, message: "Expected workspace path and position request." });
      }
      if (typeof newName !== "string" || !RENAME_IDENTIFIER_PATTERN.test(newName)) {
        return Promise.resolve({ ok: false as const, message: "The new name must be a plain identifier." });
      }
      return service.rename(rootPath, parsed, newName);
    }],
    [CLANGD_DEFINITION_CHANNEL, (_e, rootPath: unknown, request: unknown, queryId: unknown) => {
      const parsed = parsePositionRequest(request);
      if (typeof rootPath !== "string" || !parsed) {
        return Promise.resolve({ ok: false as const, message: "Expected workspace path and position request." });
      }
      return service.definition(rootPath, parsed, typeof queryId === "string" ? queryId : undefined);
    }],
    [CLANGD_CANCEL_QUERY_CHANNEL, (_e, queryId: unknown) => {
      return typeof queryId === "string" ? service.cancelQuery(queryId) : false;
    }],
    [CLANGD_WORKSPACE_SYMBOLS_CHANNEL, (_e, rootPath: unknown, query: unknown) => {
      if (typeof rootPath !== "string" || typeof query !== "string") {
        return Promise.resolve({ ok: false as const, message: "Expected workspace path and symbol query." });
      }
      return service.workspaceSymbols(rootPath, query);
    }],
    [CLANGD_HOVER_CHANNEL, (_e, rootPath: unknown, request: unknown) => {
      const parsed = parsePositionRequest(request);
      if (typeof rootPath !== "string" || !parsed) {
        return Promise.resolve({ ok: false as const, message: "Expected workspace path and position request." });
      }
      return service.hover(rootPath, parsed);
    }],
    [CLANGD_COMPLETION_CHANNEL, (_e, rootPath: unknown, request: unknown, queryId: unknown) => {
      const parsed = parsePositionRequest(request);
      if (typeof rootPath !== "string" || !parsed) {
        return Promise.resolve({ ok: false as const, message: "Expected workspace path and position request." });
      }
      return service.completion(rootPath, parsed, typeof queryId === "string" ? queryId : undefined);
    }],
    [CLANGD_INDEX_COMPLETE_CHANNEL, (_e, rootPath: unknown, request: unknown) => {
      if (typeof rootPath !== "string" || !request || typeof request !== "object") {
        return Promise.resolve([]);
      }
      const req = request as Record<string, unknown>;
      if (typeof req.prefix !== "string") return Promise.resolve([]);
      const ident = (value: unknown) =>
        typeof value === "string" && /^[A-Za-z_]\w*$/.test(value) ? value : undefined;
      const container = ident(req.container);
      const memberOf = ident(req.memberOf);
      const receiver = ident(req.receiver);
      const chain = parseCompletionChain(req.chain);
      return service.indexComplete(rootPath, {
        prefix: /^[A-Za-z_]?\w*$/.test(req.prefix) ? req.prefix : "",
        ...(container ? { container } : {}),
        ...(memberOf ? { memberOf } : {}),
        ...(receiver ? { receiver } : {}),
        ...(chain ? { chain } : {}),
      });
    }],
    [CLANGD_SIGNATURE_HELP_CHANNEL, (_e, rootPath: unknown, request: unknown) => {
      const parsed = parsePositionRequest(request);
      if (typeof rootPath !== "string" || !parsed) {
        return Promise.resolve({ ok: false as const, message: "Expected workspace path and position request." });
      }
      return service.signatureHelp(rootPath, parsed);
    }],
    [CLANGD_INCLUDE_DIRS_CHANNEL, async (_e, rootPath: unknown, filePath: unknown) => {
      if (typeof rootPath !== "string" || typeof filePath !== "string") {
        return { ok: false as const, message: "Expected workspace path and file path." };
      }
      return { ok: true as const, dirs: await service.includeDirs(rootPath, filePath) };
    }],
    [CLANGD_INCLUDE_LOG_CHANNEL, (_e, entry: unknown) => {
      if (entry && typeof entry === "object") {
        agentLogInfo("devmode.add_include", entry as Record<string, unknown>);
      }
      return { ok: true };
    }],
    [CLANGD_DOC_CHANGED_CHANNEL, (_e, rootPath: unknown, path: unknown, text: unknown) => {
      if (typeof rootPath === "string" && typeof path === "string" && typeof text === "string") {
        service.docChanged(rootPath, path, text);
      }
      return { ok: true };
    }],
    [CLANGD_DOC_CLOSED_CHANNEL, (_e, rootPath: unknown, path: unknown) => {
      if (typeof rootPath === "string" && typeof path === "string") {
        service.docClosed(rootPath, path);
      }
      return { ok: true };
    }],
  ];
  for (const [channel, handler] of handlers) {
    ipcMain.handle(channel, handler as never);
  }
  return () => {
    for (const [channel] of handlers) ipcMain.removeHandler(channel);
  };
}
