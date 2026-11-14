import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findDotnet } from "./workspace.js";
import { unrealBuildInvocation } from "./executionPlan.js";
import type { UnrealBuildChoice } from "./workspaceTypes.js";

test("uses the engine-pinned SDK and host architecture before newer bundled or global SDKs", async () => {
  const root = await mkdtemp(join(tmpdir(), "larry-engine-dotnet-"));
  try {
    const host = process.platform === "win32" ? "win" : process.platform === "darwin" ? "mac" : "linux";
    const exe = process.platform === "win32" ? "dotnet.exe" : "dotnet";
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    const script = join(root, "Build", "BatchFiles", process.platform === "win32" ? "GetDotnetPath.bat" : `${process.platform === "darwin" ? "Mac" : "Linux"}/SetupDotnet.sh`);
    await mkdir(join(script, ".."), { recursive: true });
    await writeFile(script, process.platform === "win32" ? "set UE_DOTNET_VERSION=8.0.412" : "DotNet/8.0.412/");
    for (const version of ["8.0.300", "8.0.412", "10.0.100"]) for (const architecture of ["x64", "arm64"]) {
      const dir = join(root, "Binaries", "ThirdParty", "DotNet", version, `${host}-${architecture}`);
      await mkdir(dir, { recursive: true }); await writeFile(join(dir, exe), "fixture");
    }
    assert.equal(await findDotnet(root), join(root, "Binaries", "ThirdParty", "DotNet", "8.0.412", `${host}-${arch}`, exe));
    // Never bypass Build.bat/Build.sh environment setup, even with a prebuilt UBT.
    const ubtDir = join(root, "Binaries", "DotNET", "UnrealBuildTool");
    await mkdir(ubtDir, { recursive: true });
    await writeFile(join(ubtDir, "UnrealBuildTool.dll"), "fixture");
    const choice = { kind: "native", engineRoot: root } as UnrealBuildChoice;
    for (const operation of ["build", "rebuild", "clean"] as const) assert.equal(await unrealBuildInvocation(choice, operation), undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});
