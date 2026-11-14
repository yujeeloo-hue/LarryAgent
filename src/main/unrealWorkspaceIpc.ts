import { app, ipcMain } from "electron";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { getUnrealWorkspace, rememberUnrealSelection, selectedUnrealBuild } from "../unreal/workspace.js";
import { unrealRunInvocation, unrealBuildInvocation } from "../unreal/executionPlan.js";
import { UNREAL_UBT_TIMEOUT_MS } from "../unreal/launchContext.js";
import { awaitDevTaskRun, getDevTaskState, runDevTask, stopDevTask } from "./devTasks.js";
import type { UnrealBuildChoice, UnrealWorkspaceResult } from "../unreal/workspaceTypes.js";
import { claimUnrealActivity } from "../unreal/activity.js";

export async function unrealBuildTask(choice: UnrealBuildChoice, operation: "build" | "rebuild" | "clean" = "build") {
  const executable = await unrealBuildInvocation(choice, operation);
  return { definition: { command: choice.command, cwd: choice.engineRoot, env: {}, timeoutMs: UNREAL_UBT_TIMEOUT_MS }, buildIdentity: choice.id, engineRoot: choice.engineRoot, ...(executable ? { executable } : {}) };
}

export function registerUnrealWorkspaceIpc(): void {
  const loaded = new Set<string>();
  ipcMain.handle("unreal:build", async (event, root: unknown, id: unknown, operation: unknown) => {
    if (typeof root !== "string" || typeof id !== "string") return { ok: false, message: "Invalid build" };
    try {
      const choice = await selectedUnrealBuild(root, id);
      if (!choice) return { ok: false, message: "No Unreal build configuration" };
      if (choice.buildReason) return { ok: false, message: choice.buildReason };
      const command = operation === "rebuild" ? choice.rebuildCommand : operation === "clean" ? choice.cleanCommand : choice.command;
      if (!command) return { ok: false, message: "This configuration does not support the requested build operation" };
      return await runDevTask(event.sender, root, "build", await unrealBuildTask({ ...choice, command }, operation === "rebuild" || operation === "clean" ? operation : "build"));
    } catch (error) { return { ok: false, message: String(error) }; }
  });
  const selectionPath = (workspace: string) => join(app.getPath("userData"), "unreal-selections", `${createHash("sha256").update(process.platform === "win32" ? workspace.replace(/\\/g, "/").toLowerCase() : workspace).digest("hex")}.json`);
  ipcMain.handle("unreal:workspace", async (_event, root: unknown, refresh: unknown): Promise<UnrealWorkspaceResult> => {
    if (typeof root !== "string" || !root.trim()) return { ok: false, message: "workspacePath is required" };
    try {
      if (!loaded.has(root)) {
        try {
          const value = JSON.parse(await readFile(selectionPath(root), "utf8")) as { selectedId?: string };
          if (typeof value.selectedId === "string") rememberUnrealSelection(root, value.selectedId);
        } catch { /* first visit */ }
        loaded.add(root);
      }
      return { ok: true, workspace: await getUnrealWorkspace(root, refresh === true) };
    } catch (error) { return { ok: false, message: String(error) }; }
  });
  ipcMain.handle("unreal:select", async (_event, root: unknown, id: unknown): Promise<UnrealWorkspaceResult> => {
    if (typeof root !== "string" || typeof id !== "string") return { ok: false, message: "Invalid selection" };
    try {
      const model = await getUnrealWorkspace(root);
      if (!model?.choices.some(c => c.id === id)) return { ok: false, message: "This configuration is no longer available. Reload the workspace and select another configuration" };
      const path = selectionPath(root);
      await mkdir(join(app.getPath("userData"), "unreal-selections"), { recursive: true });
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify({ selectedId: id }));
      await rename(temporary, path);
      rememberUnrealSelection(root, id);
      return { ok: true, workspace: { ...model, selectedId: id } };
    } catch (error) { return { ok: false, message: String(error) }; }
  });
  ipcMain.handle("unreal:run", async (event, root: unknown, id: unknown) => {
    if (typeof root !== "string" || typeof id !== "string") return { ok: false, message: "Invalid launch" };
    const release = claimUnrealActivity(root);
    if (!release) return { ok: false, message: "This project is already running or debugging" };
    try {
      const choice = await selectedUnrealBuild(root, id);
      if (!choice) { release(); return { ok: false, message: "No Unreal project" }; }
      if (choice.runReason) { release(); return { ok: false, message: choice.runReason }; }
      const launched = await runDevTask(event.sender, root, "run", {
        definition: { command: `Run ${choice.target} · ${choice.configuration} · ${choice.platform}`, cwd: choice.projectRoot, timeoutMs: 0, env: {} },
        buildIdentity: choice.id,
        prepare: async signal => {
          if (choice.skipBuild) return await unrealRunInvocation(choice);
          // UBT does the incremental check, including engine/plugin/build-rule dependencies.
          const existing = getDevTaskState(root).active.find(r => r.task === "build" && r.buildIdentity === choice.id);
          const started = existing ? { ok: true as const, runId: existing.runId } : await runDevTask(event.sender, root, "build", await unrealBuildTask(choice));
          if (!started.ok) throw new Error(started.message);
          const cancel = () => { if (!existing) stopDevTask(started.runId); };
          signal.addEventListener("abort", cancel, { once: true });
          if (signal.aborted) cancel();
          try {
            const result = await awaitDevTaskRun(started.runId, signal);
            if (signal.aborted) throw new Error("Run cancelled");
            if (!result || result.status !== "done" || result.exitCode !== 0) throw new Error(result?.failureHint ?? "Build failed. Launch cancelled");
            return await unrealRunInvocation(choice);
          } finally { signal.removeEventListener("abort", cancel); }
        },
      });
      if (!launched.ok) { release(); return launched; }
      const closed = () => { stopDevTask(launched.runId); };
      event.sender.once("destroyed", closed);
      void awaitDevTaskRun(launched.runId).finally(() => { release(); event.sender.removeListener("destroyed", closed); });
      return launched;
    } catch (error) { release(); return { ok: false, message: String(error) }; }
  });
}
