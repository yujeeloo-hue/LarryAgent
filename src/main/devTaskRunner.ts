import { BrowserWindow } from "electron";
import {
  awaitDevTaskRun,
  getDevTaskRunSnapshot,
  getDevTaskState,
  runDevTask,
  stopDevTask,
} from "./devTasks.js";
import { readEffectiveDevTasks } from "./devTaskResolve.js";
import type { DevTaskRunnerPort } from "../tools/devTaskRunnerPort.js";

export function liveWebContents() {
  const win =
    BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  return win && !win.isDestroyed() ? win.webContents : null;
}

export function createDevTaskRunnerPort(): DevTaskRunnerPort {
  return {
    run: ({ workspacePath, task }) =>
      runDevTask(liveWebContents(), workspacePath, task),
    listTasks: async (workspacePath) => {
      const config = await readEffectiveDevTasks(workspacePath);
      if (!config.ok) return { ok: false, message: config.message };
      return {
        ok: true,
        tasks: Object.entries(config.tasks).map(([id, def]) => ({
          id,
          command: def.command,
        })),
      };
    },
    awaitRun: (runId) => awaitDevTaskRun(runId),
    snapshot: (runId) => getDevTaskRunSnapshot(runId),
    state: (workspacePath) => getDevTaskState(workspacePath),
    stop: (runId) => stopDevTask(runId).ok,
  };
}
