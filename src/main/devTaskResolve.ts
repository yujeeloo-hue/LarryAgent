/**
 * Merge a synthetic Unreal UBT `build` task when `.larry/tasks.json` has none.
 */
import {
  readDevTasksConfig,
  type DevTaskConfigResult,
  type DevTaskDef,
} from "./devTaskConfig.js";
import { resolveUnrealLaunchContext, UNREAL_UBT_TIMEOUT_MS } from "../unreal/launchContext.js";
import { findUproject } from "../unreal/uproject.js";
import { findElectronManifest } from "../electron/manifest.js";
import { findWebManifest } from "../web/manifest.js";
import { getUnrealWorkspace } from "../unreal/workspace.js";

export type DevTaskOrigin = "file" | "unreal";

export type EffectiveDevTasks = {
  ok: true;
  tasks: Record<string, DevTaskDef>;
  origins: Record<string, DevTaskOrigin>;
  unrealError: string | null;
  /** Unreal C++, Electron, or Node web debug. */
  debugSupported: boolean;
  debugKind: "unreal" | "electron" | "web" | null;
  buildIdentity?: string;
  engineRoot?: string;
};

function workspaceDebugKind(
  workspacePath: string,
): "unreal" | "electron" | "web" | null {
  if (findUproject(workspacePath)) return "unreal";
  if (findElectronManifest(workspacePath)) return "electron";
  if (findWebManifest(workspacePath)) return "web";
  return null;
}

export async function readEffectiveDevTasks(
  workspacePath: string,
): Promise<EffectiveDevTasks | { ok: false; message: string }> {
  const file = await readDevTasksConfig(workspacePath);
  if (!file.ok) return file;

  const origins: Record<string, DevTaskOrigin> = {};
  for (const id of Object.keys(file.tasks)) origins[id] = "file";
  const unreal = await getUnrealWorkspace(workspacePath);
  const debugKind = unreal ? "unreal" : workspaceDebugKind(workspacePath);
  const debugSupported = debugKind !== null;

  const choice = unreal?.choices.find(c => c.id === unreal.selectedId);
  if (choice && !file.tasks.build) {
    const tasks = { ...file.tasks,
      build: { command: choice.command, cwd: choice.engineRoot, timeoutMs: UNREAL_UBT_TIMEOUT_MS, env: {} } };
    return { ok: true, tasks, origins: { ...origins, build: "unreal" },
      unrealError: choice.buildReason, debugSupported: unreal!.choices.some(c => !c.debugReason), debugKind: "unreal",
      buildIdentity: choice.id, engineRoot: choice.engineRoot };
  }

  if (file.tasks.build) {
    // UE workspace + hand-written build: the generic 10-minute task default
    // is a compile killer. Floor it at the UBT ceiling — explicit larger
    // timeouts (up to the 8h config max) pass through untouched.
    const tasks = { ...file.tasks };
    if (
      debugKind === "unreal" &&
      tasks.build &&
      tasks.build.timeoutMs < UNREAL_UBT_TIMEOUT_MS
    ) {
      tasks.build = { ...tasks.build, timeoutMs: UNREAL_UBT_TIMEOUT_MS };
    }
    return {
      ok: true,
      tasks,
      origins,
      unrealError: null,
      debugSupported,
      debugKind,
    };
  }

  const ue = await resolveUnrealLaunchContext(workspacePath);
  if (!ue.ok) {
    return {
      ok: true,
      tasks: file.tasks,
      origins,
      unrealError: ue.code === "not_unreal" ? null : ue.message,
      debugSupported,
      debugKind,
    };
  }

  const build: DevTaskDef = {
    command: ue.context.ubtCommand,
    cwd: ue.context.cwd,
    timeoutMs: ue.context.timeoutMs,
    env: {},
  };
  return {
    ok: true,
    tasks: { ...file.tasks, build },
    origins: { ...origins, build: "unreal" },
    unrealError: null,
    debugSupported,
    debugKind,
  };
}
