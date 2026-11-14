/**
 * Live DevTaskRunnerPort — the agent's `run_dev_task` tool drives the exact
 * same runner as the Dev Mode Build / Run / Deploy buttons (and /build,
 * /run). Kept in main because the runner streams output to a WebContents.
 *
 * A focused/first window receives the live output + progress events; when no
 * window exists (background turn before UI is up) the run still executes and
 * buffers output for replay (devTasks.ts accepts a null webContents).
 */
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

function liveWebContents() {
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
