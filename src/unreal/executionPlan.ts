import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { findDotnet } from "./workspace.js";
import { readText, resolveProjectPath } from "./projectMetadata.js";
import type { UnrealBuildChoice } from "./workspaceTypes.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

/** Receipts describe the actual executable (DebugGame editors can share Development binaries). */
export async function unrealExecutable(choice: UnrealBuildChoice): Promise<string | null> {
  if (choice.kind === "managed") {
    const dotnet = await findDotnet(choice.engineRoot);
    if (!dotnet) return null;
    const { stdout } = await promisify(execFile)(dotnet, ["msbuild", choice.project, "-nologo", "-getProperty:TargetPath", `-property:Configuration=${choice.configuration}`], { cwd: dirname(choice.project), windowsHide: true, timeout: 20_000 });
    const targetPath = stdout.trim().split(/\r?\n/).at(-1)?.trim();
    return targetPath && !targetPath.includes("error ") ? resolveProjectPath(dirname(choice.project), targetPath) : null;
  }
  let output = choice.output;
  for (const root of [...new Set([choice.projectRoot, choice.engineRoot])]) {
    const binaries = join(root, "Binaries", choice.platform);
    let names: string[];
    try { names = await readdir(binaries); } catch { continue; }
    for (const name of names.filter(n => n.endsWith(".target") && n.startsWith(choice.target))) {
      try {
        const receipt = JSON.parse(await readText(join(binaries, name))) as { TargetName?: string; Configuration?: string; Platform?: string; Architecture?: string; Launch?: string };
        if (receipt.TargetName !== choice.target || receipt.Configuration !== choice.configuration || receipt.Platform !== choice.platform || (choice.architecture && receipt.Architecture && receipt.Architecture !== choice.architecture) || !receipt.Launch) continue;
        output = resolveProjectPath(binaries, receipt.Launch.replace(/\$\(EngineDir\)/g, choice.engineRoot).replace(/\$\(ProjectDir\)/g, choice.projectRoot));
        break;
      } catch { /* interrupted/malformed receipt; use generated project metadata */ }
    }
  }
  if (output?.endsWith(".app")) {
    const plist = await readText(join(output, "Contents", "Info.plist"));
    const executable = /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1] ?? basename(output, ".app");
    output = join(output, "Contents", "MacOS", executable);
  }
  return output;
}

export async function unrealRunInvocation(choice: UnrealBuildChoice): Promise<{ file: string; args: string[] }> {
  if (choice.runReason) throw new Error(choice.runReason);
  if (choice.kind === "managed") {
    const dotnet = await findDotnet(choice.engineRoot);
    if (!dotnet) throw new Error(".NET SDK not found");
    return { file: dotnet, args: ["run", "--no-build", "--project", choice.project, "--configuration", choice.configuration] };
  }
  const file = await unrealExecutable(choice);
  if (!file || !existsSync(file)) throw new Error(`Executable not found after building: ${file ?? choice.target}`);
  return { file, args: choice.targetType === "Editor" && choice.uproject ? [choice.uproject, "-skipcompile", "-stdout", "-FullStdOutLogOutput"] : [] };
}

/** Native builds must use the engine scripts, which initialize its SDK and environment. */
export async function unrealBuildInvocation(choice: UnrealBuildChoice, operation: "build" | "rebuild" | "clean" = "build"): Promise<{ file: string; args: string[] } | undefined> {
  if (choice.kind !== "managed") return undefined;
  const dotnet = await findDotnet(choice.engineRoot);
  return dotnet ? { file: dotnet, args: [operation === "clean" ? "clean" : "build", choice.project, "--configuration", choice.configuration, "--nologo", ...(operation === "rebuild" ? ["--no-incremental"] : [])] } : undefined;
}
