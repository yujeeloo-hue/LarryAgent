import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSlnConfigurations } from "../dotnet/slnParser.js";
import { getUnrealWorkspace, rememberUnrealSelection, invalidateUnrealWorkspace, discoverFiles } from "./workspace.js";
import { parseNativeConfigurations, readRiderHeader } from "./projectMetadata.js";
import { unrealExecutable } from "./executionPlan.js";
import { commandMentionsPath, matchesUnrealProcess } from "./processIdentity.js";
import { claimUnrealActivity } from "./activity.js";

const guid = "AAAAAAAA-0000-0000-0000-000000000001";
const group = (key: string, target: string, config: string, arch: string, output: string) =>
  `<PropertyGroup Condition="'$(Configuration)|$(Platform)'=='${key}'"><NMakeBuildCommandLine>$(BuildBatchScript) -Target=&quot;${target} Win64 ${config} -Project=\\&quot;$(SolutionDir)Game.uproject\\&quot;&quot; -WaitMutex -architecture=${arch}</NMakeBuildCommandLine><NMakeOutput>${output}</NMakeOutput></PropertyGroup>`;
async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), "larry-unreal-matrix-"));
  const root = join(parent, "Game"), engine = join(parent, "UnrealEngine", "Engine");
  const write = async (path: string, text: string) => { await mkdir(join(path, ".."), { recursive: true }); await writeFile(path, text); };
  await write(join(root, "Game.uproject"), "{}");
  await write(join(root, "Source", "GameEditor.Target.cs"), "Type = TargetType.Editor;");
  await write(join(engine, "Source", "Runtime", "Core", "Core.Build.cs"), "");
  await write(join(engine, "Build", "BatchFiles", "Build.bat"), "@echo off");
  await write(join(engine, "Build", "BatchFiles", "Build.sh"), "#!/bin/sh");
  const project = join(root, "Intermediate", "ProjectFiles", "Game.vcxproj");
  await write(project, `<Project>${group("DebugGame_Editor|x64", "GameEditor", "DebugGame", "x64", join(engine, "Binaries", "Win64", "UnrealEditor.exe"))}${group("Development_Editor|x64", "GameEditor", "Development", "x64", join(engine, "Binaries", "Win64", "UnrealEditor.exe"))}${group("Development_arm64|x64", "GameEditor", "Development", "arm64", "ARM.exe")}${group("Unmapped|x64", "Unmapped", "Shipping", "x64", "bad.exe")}</Project>`);
  await write(join(root, "Game.sln"), `Project("{8BC9CEB8-8B4A-11D0-8D11-00A0C91BC942}") = "Game", "Intermediate\\ProjectFiles\\Game.vcxproj", "{${guid}}"\nEndProject\nGlobal\nGlobalSection(SolutionConfigurationPlatforms) = preSolution\nDebugGame Editor|Win64 = DebugGame Editor|Win64\nDevelopment Editor|Win64 = Development Editor|Win64\nEndGlobalSection\nGlobalSection(ProjectConfigurationPlatforms) = postSolution\n{${guid}}.DebugGame Editor|Win64.ActiveCfg = DebugGame_Editor|x64\n{${guid}}.DebugGame Editor|Win64.Build.0 = DebugGame_Editor|x64\n{${guid}}.Development Editor|Win64.ActiveCfg = Development_Editor|x64\n{${guid}}.Development Editor|Win64.Build.0 = Development_Editor|x64\n{${guid}}.Development Editor|Win64 arm64.ActiveCfg = Development_arm64|x64\nEndGlobalSection\nEndGlobal`);
  return { root, parent, engine, write };
}

test("configuration mapping preserves Build.0 without inventing a Cartesian product", () => {
  const parsed = parseSlnConfigurations(`GlobalSection(ProjectConfigurationPlatforms) = postSolution\n{${guid}}.Development Editor|Win64.ActiveCfg = Development_Editor|x64\n{${guid}}.DebugGame Editor|Win64.Build.0 = DebugGame_Editor|x64\n{${guid}}.DebugGame Editor|Win64.ActiveCfg = DebugGame_Editor|x64\nEndGlobalSection`);
  assert.equal(parsed.mappings.length, 2);
  assert.equal(parsed.mappings[0]!.build, false);
  assert.equal(parsed.mappings[1]!.build, true);
  assert.equal(parsed.mappings[1]!.projectConfiguration, "DebugGame_Editor|x64");
});

test("reads nested UBT targets and architecture from generated project configurations", () => {
  const parsed = parseNativeConfigurations(group("Development_arm64|x64", "GameEditor", "Development", "arm64", "../../Binaries/Win64/Game.exe"), "/game/Intermediate/ProjectFiles/Game.vcxproj");
  assert.equal(parsed[0]!.target, "GameEditor"); assert.equal(parsed[0]!.architecture, "arm64");
  assert.ok(parsed[0]!.output!.replace(/\\/g, "/").endsWith("/game/Binaries/Win64/Game.exe"));
});

test("indexes Programs beyond forty targets/depth four and keeps non-runnable managed libraries", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 45; i++) await f.write(join(f.engine, "Source", "Programs", "a", "b", "c", "d", `Tool${i}`, `Tool${i}.Target.cs`), "Type = TargetType.Program;");
    await f.write(join(f.engine, "Source", "Programs", "Shared", "Lib.csproj"), '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>');
    const model = await getUnrealWorkspace(f.root);
    assert.ok(model?.hasChoices);
    assert.equal(model.projects.filter(p => p.kind === "native").length, 45);
    assert.equal(model.choices.filter(c => c.kind === "native").length, 3);
    assert.ok(!model.choices.some(c => c.target === "Unmapped"));
    assert.ok(model.choices.find(c => c.target === "Lib")?.runReason);
    const development = model.choices.find(c => c.configuration === "Development" && c.architecture === "x64")!;
    rememberUnrealSelection(f.root, development.id);
    assert.equal((await getUnrealWorkspace(f.root))?.selectedId, development.id);
    assert.notEqual(development.id, model.choices.find(c => c.architecture === "arm64")?.id);
    const bins = join(f.root, "Binaries", "Win64");
    await f.write(join(bins, "GameEditor.target"), JSON.stringify({ TargetName: "GameEditor", Configuration: "Development", Platform: "Win64", Architecture: "x64", Launch: "$(EngineDir)/Binaries/Win64/ActualEditor.exe" }));
    assert.equal(await unrealExecutable(development), join(f.engine, "Binaries", "Win64", "ActualEditor.exe"));
  } finally { invalidateUnrealWorkspace(f.root); await rm(f.parent, { recursive: true, force: true }); }
});

test("an uncooked Game target stays runnable like in Rider, with a note instead of a block", async () => {
  const f = await fixture();
  try {
    await f.write(join(f.root, "Source", "Game.Target.cs"), "Type = TargetType.Game;");
    const exe = join(f.root, "Binaries", "Win64", "Game-Win64-DebugGame.exe");
    await f.write(join(f.root, "Intermediate", "ProjectFiles", "Game.vcxproj"), `<Project>${group("DebugGame|x64", "Game", "DebugGame", "x64", exe)}</Project>`);
    await f.write(join(f.root, "Game.sln"), `Project("{8BC9CEB8-8B4A-11D0-8D11-00A0C91BC942}") = "Game", "Intermediate\\ProjectFiles\\Game.vcxproj", "{${guid}}"\nEndProject\nGlobal\nGlobalSection(ProjectConfigurationPlatforms) = postSolution\n{${guid}}.DebugGame|Win64.ActiveCfg = DebugGame|x64\n{${guid}}.DebugGame|Win64.Build.0 = DebugGame|x64\nEndGlobalSection\nEndGlobal`);
    const game = (await getUnrealWorkspace(f.root, true))?.choices.find(c => c.target === "Game");
    assert.ok(game, "Game target listed");
    assert.equal(game.targetType, "Game");
    assert.doesNotMatch(game.runReason ?? "", /cook/i);
    assert.doesNotMatch(game.debugReason ?? "", /cook/i);
    assert.match(game.runNote ?? "", /cooked content/i);
    await mkdir(join(f.root, "Saved", "Cooked"), { recursive: true });
    const cooked = (await getUnrealWorkspace(f.root, true))?.choices.find(c => c.target === "Game");
    assert.equal(cooked?.runNote, undefined);
  } finally { invalidateUnrealWorkspace(f.root); await rm(f.parent, { recursive: true, force: true }); }
});

test("Rider build header is read without parsing huge include/module payloads", async () => {
  const root = await mkdtemp(join(tmpdir(), "larry-rider-header-"));
  try {
    const file = join(root, "Tool.json");
    await writeFile(file, '{"Name":"Tool","Configuration":"Development","Platform":"Win64","TargetFile":"/Tool.Target.cs","BuildInfo":{"Output":"/Tool.exe"},"EnvironmentIncludePaths":[' + "x".repeat(200_000));
    assert.equal((await readRiderHeader(file))?.BuildInfo?.Output, "/Tool.exe");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("ordinary projects do not opt into the Unreal selector; single fallback has no arrow", async () => {
  const f = await fixture();
  try {
    assert.equal(await getUnrealWorkspace(join(f.parent, "plain")), null);
    await rm(join(f.root, "Game.sln")); await rm(join(f.root, "Intermediate"), { recursive: true });
    const model = await getUnrealWorkspace(f.root, true);
    assert.equal(model?.choices.length, 1); assert.equal(model?.hasChoices, false);
  } finally { invalidateUnrealWorkspace(f.root); await rm(f.parent, { recursive: true, force: true }); }
});

test("installed content-only project debugs the editor without a C++ build", async () => {
  const f = await fixture();
  try {
    await rm(join(f.root, "Source"), { recursive: true, force: true });
    await rm(join(f.root, "Game.sln"), { force: true });
    await rm(join(f.root, "Intermediate"), { recursive: true, force: true });
    await f.write(join(f.engine, "Build", "InstalledBuild.txt"), "");
    await f.write(join(f.engine, "Build", "BatchFiles", "Mac", "Build.sh"), "#!/bin/sh\n");
    const model = await getUnrealWorkspace(f.root, true);
    const choice = model?.choices.find(c => c.kind === "native");
    assert.ok(choice);
    assert.equal(choice.target, "UnrealEditor");
    assert.equal(choice.configuration, "Development");
    assert.equal(choice.skipBuild, true);
    assert.equal(choice.debugReason, null);
    assert.equal(choice.runReason, null);
    assert.match(choice.buildReason ?? "", /no C\+\+ modules/);
    assert.equal(choice.platform, process.platform === "win32" ? "Win64" : process.platform === "darwin" ? "Mac" : "Linux");
  } finally { invalidateUnrealWorkspace(f.root); await rm(f.parent, { recursive: true, force: true }); }
});

test("Mac process lines match an executable path that contains spaces", () => {
  const executable = "/Users/Shared/Epic Games/UE_5.8/Engine/Binaries/Mac/UnrealEditor.app/Contents/MacOS/UnrealEditor";
  const project = "/Users/youyee/Documents/Projects/TPSDemo/TPSDemo.uproject";
  const command = `${executable} ${project} -skipcompile`;
  assert.equal(commandMentionsPath(command, executable), true);
  assert.equal(commandMentionsPath(command, project), true);
  assert.equal(commandMentionsPath(command, `${project}2`), false);
  assert.equal(commandMentionsPath(command, `${executable}Services`), false);
});

test("attach requires the exact executable and project; Run and Debug cannot overlap", () => {
  const row = { ExecutablePath: "E:\\UE\\UnrealEditor.exe", CommandLine: '"E:\\UE\\UnrealEditor.exe" "E:\\Game A\\Game.uproject" -skipcompile' };
  assert.ok(matchesUnrealProcess(row, "E:/UE/UnrealEditor.exe", "E:/Game A/Game.uproject"));
  assert.ok(!matchesUnrealProcess(row, "E:/Other/UnrealEditor.exe", "E:/Game A/Game.uproject"));
  assert.ok(!matchesUnrealProcess(row, "E:/UE/UnrealEditor.exe", "E:/Game A/Game.uproject2"));
  const release = claimUnrealActivity("E:/Game"); assert.ok(release);
  assert.equal(claimUnrealActivity("e:\\Game"), null); release();
  const again = claimUnrealActivity("E:/Game"); assert.ok(again); again();
});
