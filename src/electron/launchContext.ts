/**
 * Resolve everything needed to launch an Electron app under the debugger.
 */
import { existsSync } from "node:fs";
import { findUproject } from "../unreal/uproject.js";
import {
  readElectronDebugConfig,
  type ElectronDebugOverride,
} from "./debugConfig.js";
import { findElectronManifest, type ElectronRecipe } from "./manifest.js";
import {
  defaultOutFiles,
  defaultRuntimeArgs,
  defaultWebRoot,
  electronDistBinary,
  viteBinPath,
} from "./recipes.js";

export type ElectronLaunchContext = {
  recipe: ElectronRecipe;
  manifestPath: string;
  projectRoot: string;
  packageName: string;
  main: string | null;
  electronBin: string;
  viteBin: string | null;
  webRoot: string;
  outFiles: string[];
  runtimeExecutable: string;
  runtimeArgs: string[];
  stopOnEntry: boolean;
};

export type ElectronLaunchErrorCode =
  | "not_electron"
  | "unreal_project"
  | "no_electron_bin"
  | "no_vite_bin"
  | "bad_debug_config";

export type ElectronLaunchResult =
  | { ok: true; context: ElectronLaunchContext }
  | { ok: false; code: ElectronLaunchErrorCode; message: string };

export type ResolveElectronLaunchOpts = {
  platform?: NodeJS.Platform;
  exists?: (path: string) => boolean;
  readDebugConfig?: (workspacePath: string) => Promise<
    | { ok: true; electron: ElectronDebugOverride | null }
    | { ok: false; message: string }
  >;
};

export async function resolveElectronLaunchContext(
  workspacePath: string,
  opts?: ResolveElectronLaunchOpts,
): Promise<ElectronLaunchResult> {
  const os = opts?.platform ?? process.platform;
  const exists = opts?.exists ?? ((path: string) => existsSync(path));
  if (findUproject(workspacePath)) {
    return {
      ok: false,
      code: "unreal_project",
      message: "Unreal project takes precedence over Electron debug in this workspace",
    };
  }
  const hit = findElectronManifest(workspacePath);
  if (!hit) {
    return {
      ok: false,
      code: "not_electron",
      message: "No Electron package.json found in this workspace",
    };
  }

  const debugFile = await (opts?.readDebugConfig ?? readElectronDebugConfig)(
    workspacePath,
  );
  if (!debugFile.ok) {
    return { ok: false, code: "bad_debug_config", message: debugFile.message };
  }
  const over = debugFile.electron;
  const recipe = over?.recipe ?? hit.recipe;
  const electronBin = electronDistBinary(hit.projectRoot, os);
  if (!exists(electronBin)) {
    return {
      ok: false,
      code: "no_electron_bin",
      message: `Electron binary not found: ${electronBin} — run npm install in ${hit.projectRoot}`,
    };
  }

  let viteBin: string | null = null;
  if (recipe === "electron-vite") {
    viteBin = viteBinPath(hit.projectRoot, os);
    if (!exists(viteBin)) {
      return {
        ok: false,
        code: "no_vite_bin",
        message: `electron-vite not found: ${viteBin} — run npm install in ${hit.projectRoot}`,
      };
    }
  }

  const webRoot = over?.webRoot ?? defaultWebRoot(hit.projectRoot, exists);
  const outFiles = over?.outFiles ?? defaultOutFiles(hit.projectRoot);
  const runtimeExecutable =
    over?.runtimeExecutable ??
    (recipe === "electron-vite" && viteBin ? viteBin : electronBin);
  const runtimeArgs = over?.runtimeArgs ?? defaultRuntimeArgs(recipe, hit.main);

  return {
    ok: true,
    context: {
      recipe,
      manifestPath: hit.manifestPath,
      projectRoot: hit.projectRoot,
      packageName: hit.packageName,
      main: hit.main,
      electronBin,
      viteBin,
      webRoot,
      outFiles,
      runtimeExecutable,
      runtimeArgs,
      stopOnEntry: over?.stopOnEntry === true,
    },
  };
}
