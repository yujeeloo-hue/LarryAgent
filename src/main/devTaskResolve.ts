import {
  readDevTasksConfig,
  type DevTaskConfigResult,
  type DevTaskDef,
} from "./devTaskConfig.js";
import { resolveUnrealLaunchContext, UNREAL_UBT_TIMEOUT_MS } from "../unreal/launchContext.js";
import { findUproject } from "../unreal/uproject.js";
import { findElectronManifest } from "../electron/manifest.js";
import { findWebManifest } from "../web/manifest.js";
import { getUnrealWorkspace, findDotnet } from "../unreal/workspace.js";
import { GENERATE_PROJECT_FILES_TASK, generateProjectFilesCommand, generateProjectFilesCwd } from "../unreal/generateProjectFiles.js";

export type DevTaskOrigin = "file" | "unreal";

export type EffectiveDevTasks = {
  ok: true;
  tasks: Record<string, DevTaskDef>;
  origins: Record<string, DevTaskOrigin>;
  unrealError: string | null;
  debugSupported: boolean;
  debugKind: "unreal" | "electron" | "web" | null;
  buildIdentity?: string;
  engineRoot?: string;
  preBuild?: string;
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

  const baseTasks = { ...file.tasks };
  const origins: Record<string, DevTaskOrigin> = {};
  for (const id of Object.keys(file.tasks)) origins[id] = "file";
  const unreal = await getUnrealWorkspace(workspacePath);
  const debugKind = unreal ? "unreal" : workspaceDebugKind(workspacePath);
  const debugSupported = debugKind !== null;
  const engineRoot = unreal?.engineRoot ?? undefined;
  if (unreal?.engineRoot && !baseTasks[GENERATE_PROJECT_FILES_TASK]) {
    const hit = findUproject(workspacePath);
    const dotnet = hit ? await findDotnet(unreal.engineRoot) : null;
    if (hit && dotnet) {
      baseTasks[GENERATE_PROJECT_FILES_TASK] = {
        command: generateProjectFilesCommand({ engineRoot: unreal.engineRoot, uproject: hit.uproject, dotnet, os: process.platform }),
        cwd: generateProjectFilesCwd(unreal.engineRoot),
        timeoutMs: UNREAL_UBT_TIMEOUT_MS,
        env: {},
      };
      origins[GENERATE_PROJECT_FILES_TASK] = "unreal";
    }
  }

  const choice = unreal?.choices.find(c => c.id === unreal.selectedId);
  if (choice && !file.tasks.build) {
    const tasks = { ...baseTasks,
      build: { command: choice.command, cwd: choice.engineRoot, timeoutMs: UNREAL_UBT_TIMEOUT_MS, env: {} } };
    return { ok: true, tasks, origins: { ...origins, build: "unreal" },
      unrealError: choice.buildReason, debugSupported: unreal!.choices.some(c => !c.debugReason), debugKind: "unreal",
      buildIdentity: choice.id, engineRoot: choice.engineRoot,
      ...(file.preBuild ? { preBuild: file.preBuild } : {}) };
  }

  if (file.tasks.build) {
    const tasks = { ...baseTasks };
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
      ...(engineRoot ? { engineRoot } : {}),
      ...(file.preBuild ? { preBuild: file.preBuild } : {}),
    };
  }

  const ue = await resolveUnrealLaunchContext(workspacePath);
  if (!ue.ok) {
    return {
      ok: true,
      tasks: baseTasks,
      origins,
      unrealError: ue.code === "not_unreal" ? null : ue.message,
      debugSupported,
      debugKind,
      ...(engineRoot ? { engineRoot } : {}),
      ...(file.preBuild ? { preBuild: file.preBuild } : {}),
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
    tasks: { ...baseTasks, build },
    origins: { ...origins, build: "unreal" },
    unrealError: null,
    debugSupported,
    debugKind,
    engineRoot: ue.context.engineRoot ?? engineRoot,
    ...(file.preBuild ? { preBuild: file.preBuild } : {}),
  };
}
