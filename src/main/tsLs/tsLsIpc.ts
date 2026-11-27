import { ipcMain } from "electron";
import { parseLuaPositionRequest } from "../luaLs/luaLsIpc.js";
import type { TypeScriptLanguageService } from "./service.js";
import {
  TS_LS_COMPLETION_CHANNEL,
  TS_LS_DEFINITION_CHANNEL,
  TS_LS_DOC_CHANGED_CHANNEL,
  TS_LS_DOC_CLOSED_CHANNEL,
  TS_LS_HOVER_CHANNEL,
  TS_LS_REFERENCES_CHANNEL,
  TS_LS_RESOLVE_COMPLETION_CHANNEL,
  TS_LS_SIGNATURE_HELP_CHANNEL,
  type TsLsPositionRequest,
  type TsLsUnavailable,
} from "./types.js";

const INVALID: TsLsUnavailable = {
  ok: false,
  reason: "failed",
  message: "Expected workspace path and position request.",
};

export function registerTsLsIpc(service: TypeScriptLanguageService): () => void {
  const positional = <T>(run: (root: string, request: TsLsPositionRequest) => Promise<T>) =>
    (_e: Electron.IpcMainInvokeEvent, rootPath: unknown, request: unknown) => {
      const parsed = parseLuaPositionRequest(request);
      if (typeof rootPath !== "string" || !parsed) return Promise.resolve(INVALID);
      return run(rootPath, parsed);
    };
  const handlers: [string, (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown][] = [
    [TS_LS_COMPLETION_CHANNEL, positional((root, req) => service.completion(root, req))],
    [TS_LS_HOVER_CHANNEL, positional((root, req) => service.hover(root, req))],
    [TS_LS_SIGNATURE_HELP_CHANNEL, positional((root, req) => service.signatureHelp(root, req))],
    [TS_LS_DEFINITION_CHANNEL, positional((root, req) => service.definition(root, req))],
    [TS_LS_REFERENCES_CHANNEL, positional((root, req) => service.references(root, req))],
    [TS_LS_RESOLVE_COMPLETION_CHANNEL, (_e, rootPath: unknown, request: unknown) => {
      const req = request as { path?: unknown; resolveId?: unknown } | null;
      if (typeof rootPath !== "string" || typeof req?.path !== "string" || typeof req.resolveId !== "string") {
        return Promise.resolve(INVALID);
      }
      return service.resolveCompletion(rootPath, { path: req.path, resolveId: req.resolveId });
    }],
    [TS_LS_DOC_CHANGED_CHANNEL, async (_e, rootPath: unknown, path: unknown, text: unknown) => {
      if (typeof rootPath === "string" && typeof path === "string" && typeof text === "string") {
        await service.docChanged(rootPath, path, text);
      }
      return { ok: true };
    }],
    [TS_LS_DOC_CLOSED_CHANNEL, (_e, rootPath: unknown, path: unknown) => {
      if (typeof rootPath === "string" && typeof path === "string") service.docClosed(rootPath, path);
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
