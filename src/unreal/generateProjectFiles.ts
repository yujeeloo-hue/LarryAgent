import { join } from "node:path";
import { quoteShellArg } from "./ubtCommand.js";

export const GENERATE_PROJECT_FILES_TASK = "generate";

export function generateProjectFilesCwd(engineRoot: string): string {
  return join(engineRoot, "Source");
}

export function generateProjectFilesCommand(input: {
  engineRoot: string;
  uproject: string;
  dotnet: string;
  os: NodeJS.Platform;
}): string {
  const osPath = (value: string): string =>
    input.os === "win32"
      ? value.replace(/\//g, "\\")
      : value.replace(/\\/g, "/");
  const ubt = osPath(
    join(
      input.engineRoot,
      "Binaries",
      "DotNET",
      "UnrealBuildTool",
      "UnrealBuildTool.dll",
    ),
  );
  const args = [
    "-ProjectFiles",
    `-Project=${osPath(input.uproject)}`,
    "-Game",
    "-ProjectFileFormat=VisualStudio",
    "-Automated",
  ];
  return [osPath(input.dotnet), ubt, ...args]
    .map((part) => quoteShellArg(part, input.os))
    .join(" ");
}
