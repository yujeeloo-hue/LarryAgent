/**
 * IPC wiring for the clangd semantic engine (`clangd:*` channels). Follows
 * the cppSymbols pattern: one service instance owned by registerIpc(),
 * stopped on quit via the returned disposer.
 */

import { ipcMain } from "electron";
import type { ClangdService } from "./service.js";
import { downloadClangd } from "./download.js";
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
  CLANGD_STATUS_CHANNEL,
  CLANGD_WORKSPACE_SYMBOLS_CHANNEL,
  CLANGD_ENSURE_CHANNEL,
  CLANGD_DOWNLOAD_CHANNEL,
  type ClangdPositionRequest,
} from "./types.js";
import { parseCompletionChain } from "../cppSymbols/types.js";

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
    [CLANGD_DOWNLOAD_CHANNEL, () => downloadClangd()],
    [CLANGD_REFERENCES_CHANNEL, (_e, rootPath: unknown, request: unknown) => {
      const parsed = parsePositionRequest(request);
      if (typeof rootPath !== "string" || !parsed) {
        return Promise.resolve({ ok: false as const, message: "Expected workspace path and position request." });
      }
      return service.references(rootPath, parsed);
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
