import assert from "node:assert/strict";
import { join, normalize } from "node:path";
import { test } from "node:test";
import {
  generateProjectFilesCommand,
  generateProjectFilesCwd,
} from "./generateProjectFiles.js";

test("generate command calls UBT with auto-detected Visual Studio format", () => {
  const engineRoot = "E:/Engines/Unreal Engine/Engine";
  const command = generateProjectFilesCommand({
    engineRoot,
    uproject: "E:/Projects/N F/NF.uproject",
    dotnet: "E:/dotnet/dotnet.exe",
    os: "win32",
  });
  assert.ok(command.startsWith("E:\\dotnet\\dotnet.exe "));
  assert.ok(command.includes('"E:\\Engines\\Unreal Engine\\Engine\\Binaries\\DotNET\\UnrealBuildTool\\UnrealBuildTool.dll"'));
  assert.ok(command.includes("-ProjectFiles"));
  assert.ok(command.includes('"-Project=E:\\Projects\\N F\\NF.uproject"'));
  assert.ok(command.endsWith("-Game -ProjectFileFormat=VisualStudio -Automated"));
  assert.equal(
    normalize(generateProjectFilesCwd(engineRoot)),
    normalize(join(engineRoot, "Source")),
  );
});

test("generate command keeps paths unquoted on POSIX when they have no spaces", () => {
  const command = generateProjectFilesCommand({
    engineRoot: "/ue/Engine",
    uproject: "/game/Game.uproject",
    dotnet: "/usr/bin/dotnet",
    os: "linux",
  });
  assert.equal(
    command,
    "/usr/bin/dotnet /ue/Engine/Binaries/DotNET/UnrealBuildTool/UnrealBuildTool.dll -ProjectFiles -Project=/game/Game.uproject -Game -ProjectFileFormat=VisualStudio -Automated",
  );
});
