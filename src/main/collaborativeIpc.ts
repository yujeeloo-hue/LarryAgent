import { BrowserWindow, ipcMain } from "electron";
import { join } from "node:path";
import { CollaborativeService } from "../collaborative/service.js";
import { requestSemanticMerge } from "../collaborative/aiMerge.js";
import { configureCollaborativePort } from "../collaborative/port.js";
import { resolveUeEngineSourceRoot } from "../unreal/engineRoot.js";
import { generateCommitMessage } from "../git/generateCommitMessage.js";
import { invalidateVcsStatusCache } from "./vcsStatus.js";
import type { OpenAiCompatibleClientConfig } from "../llm/types.js";
import type { CollaborativeRequest } from "../shared/collaborative.js";

export function registerCollaborativeIpc(appData: string, getClient: (workspace: string) => Promise<OpenAiCompatibleClientConfig>, workspaceId: (workspace: string) => string | undefined): void {
  const service = new CollaborativeService(join(appData, "collaborative-branches.json"), {
    workspaceId,
    extraRoots: async workspace => { const engine = await resolveUeEngineSourceRoot(workspace); return engine ? [engine] : []; },
    generateCommitMessage: async (workspace, context) => generateCommitMessage({ workspacePath: workspace, context, client: await getClient(workspace) }),
    merge: async input => requestSemanticMerge(await getClient(input.workspace), input),
  });
  const execute = async (request: CollaborativeRequest, signal?: AbortSignal) => {
    const result = await service.execute(request, signal);
    if (["enable", "bind", "materialize", "release", "save", "merge-apply", "commit"].includes(request.op) || (request.op === "editor-commit" && (result.commit || result.draftSaved))) {
      for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send("devmode:collaborativeChanged", { workspacePath: request.workspacePath });
    }
    if (request.op === "editor-commit" && request.commitFiles?.[0]?.side === "left" && (result.commit || result.draftSaved)) {
      invalidateVcsStatusCache(request.workspacePath);
      for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send("vcs:changed", { rootPath: request.workspacePath });
    }
    return result;
  };
  configureCollaborativePort(execute);
  const merges = new Map<number, { id: string | undefined; controller: AbortController }>();
  ipcMain.handle("devmode:collaborative", async ({ sender }, request: CollaborativeRequest) => {
    if (request?.op?.startsWith("editor-") && (typeof request.workspacePath !== "string" || !workspaceId(request.workspacePath))) {
      throw new Error("Branch editor actions require a registered workspace");
    }
    const previous = merges.get(sender.id);
    if (request.op === "editor-merge-cancel") {
      if (previous && request.mergeId && previous.id === request.mergeId) previous.controller.abort();
      return {};
    }
    if (request.op !== "editor-merge-preview") return execute(request);
    previous?.controller.abort();
    const merge = { id: request.mergeId, controller: new AbortController() };
    const senderId = sender.id;
    const abort = () => merge.controller.abort();
    merges.set(senderId, merge);
    sender.once("destroyed", abort);
    try {
      return await execute(request, merge.controller.signal);
    } catch (error) {
      return { mergeError: merge.controller.signal.aborted
        ? "AI Merge cancelled."
        : error instanceof Error ? error.message : String(error) };
    } finally {
      sender.removeListener("destroyed", abort);
      if (merges.get(senderId) === merge) merges.delete(senderId);
    }
  });
}
