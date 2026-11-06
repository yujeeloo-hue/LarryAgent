/**
 * UBT command line + Editor binary paths for a resolved Unreal project.
 */

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
}): string {
  const os = input.os;
  const config = input.configuration ?? UNREAL_UBT_CONFIG;
  const platform = ubtPlatformFor(os);
  const script = quoteShellArg(input.buildScript, os);
  const project = quoteShellArg(input.uproject, os);
  const body = `${script} ${input.editorTarget} ${platform} ${config} -Project=${project} -WaitMutex`;
  return os === "win32" ? `call ${body}` : body;
}
