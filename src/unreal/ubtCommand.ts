import { existsSync } from "node:fs";
import { join } from "node:path";

/** UBT command line + Editor binary paths for a resolved Unreal project. */

export const UNREAL_UBT_CONFIG = "DebugGame";

export type UbtPlatform = "Win64" | "Mac" | "Linux";

export function ubtPlatformFor(os: NodeJS.Platform): UbtPlatform {
  if (os === "win32") return "Win64";
  if (os === "darwin") return "Mac";
  return "Linux";
}

export function quoteShellArg(value: string, os: NodeJS.Platform): string {
  if (os === "win32") {
    if (!/[\s&<>|^"]/.test(value)) return value;
    return `"${value.replace(/"/g, '""')}"`;
  }
  if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** `Engine/Build/BatchFiles/Build.bat` (Windows) or `Build.sh`. */
export function buildScriptRel(os: NodeJS.Platform): string {
  return os === "win32"
    ? "Build/BatchFiles/Build.bat"
    : "Build/BatchFiles/Build.sh";
}

/**
 * UBT entry points, most specific first. Installed Mac/Linux engines ship
 * only `BatchFiles/<Host>/Build.sh`; source trees also have the top-level script.
 */
export function buildScriptCandidates(os: NodeJS.Platform): string[] {
  if (os === "win32") return ["Build/BatchFiles/Build.bat"];
  if (os === "darwin") return ["Build/BatchFiles/Mac/Build.sh", "Build/BatchFiles/Build.sh"];
  return ["Build/BatchFiles/Linux/Build.sh", "Build/BatchFiles/Build.sh"];
}

/** First candidate that exists, otherwise the preferred path (for the missing-script error). */
export function resolveBuildScript(
  engineRoot: string,
  os: NodeJS.Platform,
  exists: (path: string) => boolean = existsSync,
): string {
  const absolute = buildScriptCandidates(os).map((rel) => join(engineRoot, ...rel.split("/")));
  return absolute.find((path) => {
    try {
      return exists(path);
    } catch {
      return false;
    }
  }) ?? absolute[0]!;
}

/**
 * Editor binary for a UBT configuration.
 * `NFEditor Win64 DebugGame` produces `UnrealEditor-Win64-DebugGame.exe`,
 * not the Development `UnrealEditor.exe` shell. Launching the Development
 * stub under lldb-dap on Windows crashes lldb-server (0xC000001D).
 */
export function editorBinaryRel(
  os: NodeJS.Platform,
  configuration: string = UNREAL_UBT_CONFIG,
): string {
  const flavor =
    configuration === "DebugGame" || configuration === "Debug"
      ? `${ubtPlatformFor(os)}-${configuration}`
      : null;
  if (os === "win32") {
    return flavor
      ? `Binaries/Win64/UnrealEditor-${flavor}.exe`
      : "Binaries/Win64/UnrealEditor.exe";
  }
  if (os === "darwin") {
    return flavor
      ? `Binaries/Mac/UnrealEditor-${flavor}.app`
      : "Binaries/Mac/UnrealEditor.app";
  }
  return flavor
    ? `Binaries/Linux/UnrealEditor-${flavor}`
    : "Binaries/Linux/UnrealEditor";
}

export function buildUbtCommand(input: {
  buildScript: string;
  editorTarget: string;
  uproject: string;
  os: NodeJS.Platform;
  configuration?: string;
  platform?: string;
  architecture?: string;
}): string {
  const os = input.os;
  const config = input.configuration ?? UNREAL_UBT_CONFIG;
  const platform = input.platform ?? ubtPlatformFor(os);
  const script = quoteShellArg(input.buildScript, os);
  const project = quoteShellArg(input.uproject, os);
  const body = `${script} ${quoteShellArg(input.editorTarget, os)} ${quoteShellArg(platform, os)} ${quoteShellArg(config, os)}${input.uproject ? ` -Project=${project}` : ""} -WaitMutex${input.architecture ? ` -architecture=${quoteShellArg(input.architecture, os)}` : ""}`;
  return os === "win32" ? `call ${body}` : body;
}
