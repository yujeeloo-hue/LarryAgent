/**
 * Resolve everything needed to compile DebugGame Editor for a workspace.
 */
import { join } from "node:path";
import {
  pathExists,
  resolveUeEngineSourceRoot,
} from "./engineRoot.js";
import { listUnrealTargets, pickEditorTarget } from "./targets.js";
import {
  UNREAL_UBT_CONFIG,
  buildScriptRel,
  buildUbtCommand,
  editorBinaryRel,
  ubtPlatformFor,
} from "./ubtCommand.js";
import { findUproject } from "./uproject.js";

/**
 * Wall-clock kill for the synthetic UBT `build` task — 4h. Custom-engine
 * DebugGame cold builds (NBEngine: engine + game modules) can legitimately
 * run for hours, so the old 10-minute task default would kill them; a
 * finite ceiling (rather than 0 = none) still lands a hung UBT
 * (-WaitMutex deadlock, PDB-lock prompt) in a terminal "timeout" state.
 */
export const UNREAL_UBT_TIMEOUT_MS = 14_400_000;

export type UnrealLaunchContext = {
  uproject: string;
  projectRoot: string;
  uprojectBase: string;
  engineRoot: string;
  editorTarget: string;
  editorExe: string;
  buildBat: string;
  platform: ReturnType<typeof ubtPlatformFor>;
  configuration: typeof UNREAL_UBT_CONFIG;
  ubtCommand: string;
  cwd: string;
  timeoutMs: number;
};

export type UnrealLaunchResult =
  | { ok: true; context: UnrealLaunchContext }
  | { ok: false; code: UnrealLaunchErrorCode; message: string };

export type UnrealLaunchErrorCode =
  | "not_unreal"
  | "no_engine"
  | "no_editor_target"
  | "no_build_script";

export async function resolveUnrealLaunchContext(
  workspacePath: string,
  opts?: { platform?: NodeJS.Platform; exists?: (p: string) => boolean },
): Promise<UnrealLaunchResult> {
  const os = opts?.platform ?? process.platform;
  const exists = opts?.exists ?? pathExists;
  const hit = findUproject(workspacePath);
  if (!hit) {
    return {
      ok: false,
      code: "not_unreal",
      message: "No .uproject found in this workspace",
    };
  }

  const engineRoot = await resolveUeEngineSourceRoot(hit.projectRoot);
  if (!engineRoot) {
    return {
      ok: false,
      code: "no_engine",
      message:
        "Unreal project found, but the engine root could not be resolved (sibling UnrealEngine/ or EngineAssociation registry)",
    };
  }

  const targets = await listUnrealTargets(hit.projectRoot);
  const editor = pickEditorTarget(targets, hit.baseName);
  if (!editor) {
    return {
      ok: false,
      code: "no_editor_target",
      message: `No Editor Target.cs under ${hit.projectRoot}/Source`,
    };
  }

  const buildBat = join(engineRoot, ...buildScriptRel(os).split("/"));
  if (!exists(buildBat)) {
    return {
      ok: false,
      code: "no_build_script",
      message: `UBT script missing: ${buildBat}`,
    };
  }

  const editorExe = join(
    engineRoot,
    ...editorBinaryRel(os, UNREAL_UBT_CONFIG).split("/"),
  );
  const ubtCommand = buildUbtCommand({
    buildScript: buildBat,
    editorTarget: editor.name,
    uproject: hit.uproject,
    os,
  });

  return {
    ok: true,
    context: {
      uproject: hit.uproject,
      projectRoot: hit.projectRoot,
      uprojectBase: hit.baseName,
      engineRoot,
      editorTarget: editor.name,
      editorExe,
      buildBat,
      platform: ubtPlatformFor(os),
      configuration: UNREAL_UBT_CONFIG,
      ubtCommand,
      cwd: engineRoot,
      timeoutMs: UNREAL_UBT_TIMEOUT_MS,
    },
  };
}
