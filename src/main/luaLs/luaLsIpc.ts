import { ipcMain } from "electron";
import { findLuaScriptRoots } from "./scriptRoots.js";
import type { LuaLanguageService } from "./service.js";
import { RENAME_IDENTIFIER_PATTERN } from "../../shared/lspEdits.js";
import {
  LUA_LS_COMPLETION_CHANNEL,
  LUA_LS_DEFINITION_CHANNEL,
  LUA_LS_PREPARE_RENAME_CHANNEL,
  LUA_LS_RENAME_CHANNEL,
  LUA_LS_DOC_CHANGED_CHANNEL,
  LUA_LS_DOC_CLOSED_CHANNEL,
  LUA_LS_HOVER_CHANNEL,
  LUA_LS_SCRIPT_ROOTS_CHANNEL,
  LUA_LS_SEMANTIC_TOKENS_CHANNEL,
  LUA_LS_SIGNATURE_HELP_CHANNEL,
  type LuaLsPositionRequest,
  type LuaLsUnavailable,
} from "./types.js";

export function parseLuaPositionRequest(input: unknown): LuaLsPositionRequest | null {
  if (!input || typeof input !== "object") return null;
  const req = input as Record<string, unknown>;
  if (typeof req.path !== "string" || typeof req.line !== "number" || typeof req.column !== "number") {
    return null;
  }
  return {
    path: req.path,
    line: req.line,
    column: req.column,
    ...(typeof req.text === "string" ? { text: req.text } : {}),
    ...(typeof req.triggerCharacter === "string" && req.triggerCharacter
      ? { triggerCharacter: req.triggerCharacter }
      : {}),
  };
}

const INVALID: LuaLsUnavailable = {
  ok: false,
  reason: "failed",
  message: "Expected workspace path and position request.",
};

export function registerLuaLsIpc(service: LuaLanguageService): () => void {
  const positional = <T>(run: (root: string, request: LuaLsPositionRequest) => Promise<T>) =>
    (_e: Electron.IpcMainInvokeEvent, rootPath: unknown, request: unknown) => {
      const parsed = parseLuaPositionRequest(request);
      if (typeof rootPath !== "string" || !parsed) return Promise.resolve(INVALID);
      return run(rootPath, parsed);
    };
  const handlers: [string, (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown][] = [
    [LUA_LS_COMPLETION_CHANNEL, positional((root, req) => service.completion(root, req))],
    [LUA_LS_HOVER_CHANNEL, positional((root, req) => service.hover(root, req))],
    [LUA_LS_SIGNATURE_HELP_CHANNEL, positional((root, req) => service.signatureHelp(root, req))],
    [LUA_LS_DEFINITION_CHANNEL, positional((root, req) => service.definition(root, req))],
    [LUA_LS_PREPARE_RENAME_CHANNEL, positional((root, req) => service.prepareRename(root, req))],
    [LUA_LS_RENAME_CHANNEL, (_e, rootPath: unknown, request: unknown, newName: unknown) => {
      const parsed = parseLuaPositionRequest(request);
      if (typeof rootPath !== "string" || !parsed) return Promise.resolve(INVALID);
      if (typeof newName !== "string" || !RENAME_IDENTIFIER_PATTERN.test(newName)) {
        return Promise.resolve({ ok: false, reason: "failed", message: "The new name must be a plain identifier." });
      }
      return service.rename(rootPath, parsed, newName);
    }],
    [LUA_LS_DOC_CHANGED_CHANNEL, async (_e, rootPath: unknown, path: unknown, text: unknown) => {
      if (typeof rootPath === "string" && typeof path === "string" && typeof text === "string") {
        await service.docChanged(rootPath, path, text);
      }
      return { ok: true };
    }],
    [LUA_LS_DOC_CLOSED_CHANNEL, (_e, rootPath: unknown, path: unknown) => {
      if (typeof rootPath === "string" && typeof path === "string") service.docClosed(rootPath, path);
      return { ok: true };
    }],
    [LUA_LS_SEMANTIC_TOKENS_CHANNEL, (_e, rootPath: unknown, request: unknown) => {
      const req = request as { path?: unknown; text?: unknown } | null;
      if (typeof rootPath !== "string" || typeof req?.path !== "string") return Promise.resolve(INVALID);
      return service.semanticTokens(rootPath, {
        path: req.path,
        ...(typeof req.text === "string" ? { text: req.text } : {}),
      });
    }],
    [LUA_LS_SCRIPT_ROOTS_CHANNEL, (_e, rootPath: unknown) => {
      if (typeof rootPath !== "string" || !rootPath.trim()) return Promise.resolve([]);
      return findLuaScriptRoots(rootPath).catch(() => []);
    }],
  ];
  for (const [channel, handler] of handlers) {
    ipcMain.handle(channel, handler as never);
  }
  return () => {
    for (const [channel] of handlers) ipcMain.removeHandler(channel);
  };
}
