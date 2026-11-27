import { join } from "node:path";
import {
  pathExists,
  resolveUeEngineSourceRoot,
} from "./engineRoot.js";
import { listUnrealTargets, pickEditorTarget } from "./targets.js";
import {
  UNREAL_UBT_CONFIG,
  buildUbtCommand,
  editorBinaryRel,
  resolveBuildScript,
  ubtPlatformFor,
} from "./ubtCommand.js";
import { findUproject } from "./uproject.js";

export const UNREAL_UBT_TIMEOUT_MS = 14_400_000;

export type UnrealLaunchContext = {
  uproject: string;
  projectRoot: string;
  uprojectBase: string;
  engineRoot: string;
  editorTarget: string;
  editorExe: string;
  buildBat: string;
  platform: string;
  configuration: string;
  buildIdentity?: string;
  targetType?: string;
  managedAdapter?: { path: string; args: string[] };
  skipBuild?: boolean;
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
        "Unreal project found, but the engine root could not be resolved (sibling UnrealEngine/, Epic launcher install, or EngineAssociation registry)",
    };
  }

  const targets = await listUnrealTargets(hit.projectRoot);
  const editor = pickEditorTarget(targets, hit.baseName);
  const contentOnly = targets.length === 0;
  if (!editor && !contentOnly) {
    return {
      ok: false,
      code: "no_editor_target",
      message: `No Editor Target.cs under ${hit.projectRoot}/Source`,
    };
  }

  const buildBat = resolveBuildScript(engineRoot, os, exists);
  if (!exists(buildBat)) {
    return {
      ok: false,
      code: "no_build_script",
      message: `UBT script missing: ${buildBat}`,
    };
  }

  const installed = exists(join(engineRoot, "Build", "InstalledBuild.txt"));
  const configuration = contentOnly && installed ? "Development" : UNREAL_UBT_CONFIG;
  const editorTarget = editor?.name ?? "UnrealEditor";
  const editorExe = join(
    engineRoot,
    ...editorBinaryRel(os, configuration).split("/"),
  );
  const ubtCommand = buildUbtCommand({
    buildScript: buildBat,
    editorTarget,
    uproject: hit.uproject,
    os,
    configuration,
  });

  return {
    ok: true,
    context: {
      uproject: hit.uproject,
      projectRoot: hit.projectRoot,
      uprojectBase: hit.baseName,
      engineRoot,
      editorTarget,
      editorExe,
      buildBat,
      platform: ubtPlatformFor(os),
      configuration,
      ...(contentOnly && installed ? { skipBuild: true } : {}),
      ubtCommand,
      cwd: engineRoot,
      timeoutMs: UNREAL_UBT_TIMEOUT_MS,
    },
  };
}
