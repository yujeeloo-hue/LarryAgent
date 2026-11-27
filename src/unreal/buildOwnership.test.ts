import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTargetLabel,
  commandReferencesProject,
  isUnrealBuildScript,
  latestOpenAction,
  parseProcessList,
  planProjectBuild,
  projectPathKey,
  ubtResult,
  type TrackedBuildProcess,
} from "./buildOwnership.js";

const PROJECT = "E:/Projects/NF/NF.uproject";

function proc(
  pid: number,
  commandLine: string,
  name = "dotnet.exe",
  parentPid = 0,
): TrackedBuildProcess {
  return { pid, parentPid, name, commandLine };
}

test("project paths collapse dot segments and ignore slash and case", () => {
  assert.equal(
    projectPathKey("E:\\Projects\\NF\\Build\\../NF.uproject"),
    projectPathKey("e:/Projects/NF/NF.uproject"),
  );
});

test("a compiler command matches the project through quoted relative paths", () => {
  const command = 'dotnet "..\\UnrealBuildTool.dll" NFEditor Win64 Development -Project="E:\\Projects\\NF\\Build\\../NF.uproject" -WaitMutex -FromMsBuild';
  assert.equal(commandReferencesProject(command, PROJECT), true);
  assert.equal(commandReferencesProject(command, "E:/Projects/Other/Other.uproject"), false);
  assert.equal(buildTargetLabel(command), "NFEditor Win64 Development");
  assert.equal(isUnrealBuildScript("call Rebuild.bat GameEditor"), false);
  assert.equal(isUnrealBuildScript("call BuildAndRun.bat -skip-lint"), false);
});

test("plan attaches to the live compiler and kills waiters for the same project", () => {
  const compiler = proc(
    50,
    'dotnet UnrealBuildTool.dll NFEditor Win64 Development -Project="E:\\Projects\\NF\\Build\\../NF.uproject" -FromMsBuild',
    "dotnet.exe",
    40,
  );
  const msbuild = proc(40, "MSBuild.exe NF.vcxproj", "MSBuild.exe", 10);
  const waiter = proc(
    70,
    'cmd /c call "E:\\Engines\\UnrealEngine\\Engine\\Build\\BatchFiles\\Build.bat" "-Project=E:\\Projects\\NF\\NF.uproject" NFEditor Win64 DebugGame -WaitMutex',
    "cmd.exe",
  );
  const clang = proc(
    80,
    'dotnet UnrealBuildTool.dll -Mode=GenerateClangDatabase -Project=E:\\Projects\\NF\\NF.uproject NFEditor Win64 DebugGame',
  );
  const other = proc(90, 'dotnet UnrealBuildTool.dll -Project="E:\\Projects\\Other\\Other.uproject"');
  const editor = proc(100, "E:\\Engines\\UnrealEngine\\Engine\\Binaries\\Win64\\UnrealEditor.exe E:\\Projects\\NF\\NF.uproject", "UnrealEditor.exe");
  const plan = planProjectBuild([compiler, msbuild, waiter, clang, other, editor], PROJECT);
  assert.equal(plan.attach?.pid, 50);
  assert.deepEqual(plan.killPids.sort((a, b) => a - b), [40, 50, 70, 80]);
});

test("an open action is dropped once the log records a result", () => {
  const open = "[5203/5206] Compile [x64] Module.NFEditor.cpp\n";
  assert.equal(latestOpenAction(`${open}[5204/5206] Link [x64] UnrealEditor-NFEditor.dll\n`), "[5204/5206] Link [x64] UnrealEditor-NFEditor.dll");
  assert.equal(latestOpenAction(`${open}Result: Succeeded\n`), null);
  assert.equal(ubtResult("Result: Failed\n[1/4] Compile [x64] A.cpp\n"), null);
  assert.equal(ubtResult("[4/4] Link [x64] Game.dll\nResult: Succeeded\n"), "succeeded");
});

test("process list json accepts one object or an array", () => {
  assert.equal(parseProcessList({ ProcessId: 5, ParentProcessId: 1, Name: "dotnet.exe", CommandLine: "dotnet" })[0]?.pid, 5);
  assert.equal(parseProcessList([{ pid: 0, name: "skip.exe", commandLine: "" }]).length, 0);
});
