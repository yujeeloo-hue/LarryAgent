import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseTargetCs, pickEditorTarget } from "./targets.js";
import { findUproject } from "./uproject.js";
import { buildUbtCommand, editorBinaryRel, quoteShellArg, resolveBuildScript } from "./ubtCommand.js";
import { buildAllowsLaunch, ubtFailureHint } from "./ubtLog.js";
import {
  clearUeEngineRootCache,
  installIniRoot,
  launcherInstallRootFromManifest,
  resolveUeEngineSourceRoot,
} from "./engineRoot.js";
import { resolveUnrealLaunchContext } from "./launchContext.js";

describe("parseTargetCs / pickEditorTarget", () => {
  it("reads Type = TargetType.Editor from the file", () => {
    const info = parseTargetCs(
      "E:/Game/Source/NFEditor.Target.cs",
      "public class NFEditorTarget : TargetRules {\n  Type = TargetType.Editor;\n}\n",
    );
    assert.equal(info.name, "NFEditor");
    assert.equal(info.type, "Editor");
  });

  it("treats *Editor.Target.cs as Editor when Type is missing", () => {
    const info = parseTargetCs("Source/FooEditor.Target.cs", "class FooEditorTarget {}");
    assert.equal(info.type, "Editor");
  });

  it("prefers {uproject}Editor over UnrealEditor", () => {
    const picked = pickEditorTarget(
      [
        { name: "UnrealEditor", path: "a", type: "Editor" },
        { name: "NFEditor", path: "b", type: "Editor" },
        { name: "NF", path: "c", type: "Game" },
      ],
      "NF",
    );
    assert.equal(picked?.name, "NFEditor");
  });
});

describe("findUproject", () => {
  it("finds a nested SourceClient uproject", async () => {
    const root = await mkdtemp(join(tmpdir(), "jb-ue-uproj-"));
    try {
      const game = join(root, "SourceClient", "SourceClient");
      await mkdir(game, { recursive: true });
      await writeFile(join(game, "NF.uproject"), "{}");
      const hit = findUproject(root);
      assert.ok(hit);
      assert.equal(hit!.baseName, "NF");
      assert.equal(hit!.projectRoot, game);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("buildUbtCommand", () => {
  it("emits call + quoted paths on Windows", () => {
    const cmd = buildUbtCommand({
      buildScript: "E:\\Engine Root\\Engine\\Build\\BatchFiles\\Build.bat",
      editorTarget: "NFEditor",
      uproject: "E:\\Game\\NF.uproject",
      os: "win32",
    });
    assert.match(cmd, /^call /);
    assert.match(cmd, /NFEditor Win64 DebugGame/);
    assert.match(cmd, /Build\.bat"/);
    assert.match(cmd, /-Project=/);
    assert.match(cmd, /-WaitMutex$/);
  });

  it("quotes POSIX paths with spaces", () => {
    assert.equal(quoteShellArg("/tmp/a b/Build.sh", "linux"), "'/tmp/a b/Build.sh'");
  });
});

describe("editorBinaryRel", () => {
  it("points DebugGame at the Win64 DebugGame editor, not UnrealEditor.exe", () => {
    assert.equal(
      editorBinaryRel("win32", "DebugGame"),
      "Binaries/Win64/UnrealEditor-Win64-DebugGame.exe",
    );
    assert.equal(editorBinaryRel("win32", "Debug"), "Binaries/Win64/UnrealEditor-Win64-Debug.exe");
    assert.equal(editorBinaryRel("win32", "Development"), "Binaries/Win64/UnrealEditor.exe");
    assert.equal(editorBinaryRel("darwin", "DebugGame"), "Binaries/Mac/UnrealEditor-Mac-DebugGame.app");
    assert.equal(editorBinaryRel("darwin", "Development"), "Binaries/Mac/UnrealEditor.app");
  });
});

describe("resolveBuildScript", () => {
  it("prefers the Mac host script and falls back to Build.sh", () => {
    const engine = join("/UE", "Engine");
    const mac = resolveBuildScript(engine, "darwin", (path) => path.replace(/\\/g, "/").endsWith("BatchFiles/Mac/Build.sh"));
    assert.match(mac.replace(/\\/g, "/"), /BatchFiles\/Mac\/Build\.sh$/);
    const fallback = resolveBuildScript(engine, "darwin", (path) => path.replace(/\\/g, "/").endsWith("BatchFiles/Build.sh"));
    assert.match(fallback.replace(/\\/g, "/"), /BatchFiles\/Build\.sh$/);
    assert.doesNotMatch(fallback.replace(/\\/g, "/"), /\/Mac\/Build\.sh$/);
  });
});

describe("Epic launcher association", () => {
  it("reads UE_<version> from LauncherInstalled.dat and a GUID from Install.ini", () => {
    const manifest = JSON.stringify({
      InstallationList: [{ AppName: "UE_5.8", InstallLocation: "/Users/Shared/Epic Games/UE_5.8" }],
    });
    assert.equal(launcherInstallRootFromManifest(manifest, "5.8"), "/Users/Shared/Epic Games/UE_5.8");
    assert.equal(launcherInstallRootFromManifest(manifest, "5.5"), null);
    const ini = "[Installations]\n{ABCDEF}=/src/UnrealEngine\n";
    assert.equal(installIniRoot(ini, "{ABCDEF}"), "/src/UnrealEngine");
    assert.equal(installIniRoot(ini, "{other}"), null);
  });

  it("resolves a version association from the launcher manifest", async () => {
    const parent = await mkdtemp(join(tmpdir(), "jb-ue-launcher-"));
    const project = join(parent, "Game");
    const install = join(parent, "UE_5.8");
    const support = join(parent, "Epic");
    try {
      await mkdir(join(project), { recursive: true });
      await writeFile(join(project, "Game.uproject"), JSON.stringify({ EngineAssociation: "5.8" }));
      await mkdir(join(install, "Engine", "Source", "Runtime"), { recursive: true });
      await mkdir(join(support, "UnrealEngineLauncher"), { recursive: true });
      await writeFile(
        join(support, "UnrealEngineLauncher", "LauncherInstalled.dat"),
        JSON.stringify({ InstallationList: [{ AppName: "UE_5.8", InstallLocation: install }] }),
      );
      clearUeEngineRootCache();
      const root = await resolveUeEngineSourceRoot(project, undefined, {
        platform: "darwin",
        epicSupportDir: support,
        sharedEpicDir: join(parent, "no-shared"),
      });
      assert.equal(root, join(install, "Engine"));
    } finally {
      clearUeEngineRootCache();
      await rm(parent, { recursive: true, force: true });
    }
  });
});

describe("ubtFailureHint / buildAllowsLaunch", () => {
  it("flags PDB locks", () => {
    const hint = ubtFailureHint("LINK : fatal error LNK1104: cannot open file 'NF.dll'");
    assert.match(hint ?? "", /locked/i);
  });

  it("blocks launch until a successful build", () => {
    assert.equal(buildAllowsLaunch(undefined).ok, false);
    assert.equal(buildAllowsLaunch({ status: "failed", buffer: "error C123" }).ok, false);
    assert.equal(buildAllowsLaunch({ status: "done" }).ok, true);
  });
});

describe("resolveUnrealLaunchContext", () => {
  it("resolves sibling engine + Editor target + UBT command", async () => {
    const parent = await mkdtemp(join(tmpdir(), "jb-ue-ctx-"));
    const project = join(parent, "Game");
    const engine = join(parent, "UnrealEngine", "Engine");
    try {
      await mkdir(join(project, "Source"), { recursive: true });
      await writeFile(join(project, "Game.uproject"), "{}");
      await writeFile(
        join(project, "Source", "GameEditor.Target.cs"),
        "public class GameEditorTarget : TargetRules {\n  Type = TargetType.Editor;\n}\n",
      );
      await mkdir(join(engine, "Source", "Runtime"), { recursive: true });
      const bat = join(engine, "Build", "BatchFiles");
      await mkdir(bat, { recursive: true });
      await writeFile(join(bat, "Build.bat"), "@echo off\n");
      await writeFile(join(bat, "Build.sh"), "#!/bin/sh\n");
      clearUeEngineRootCache();

      const res = await resolveUnrealLaunchContext(project, { platform: "win32" });
      assert.equal(res.ok, true);
      if (!res.ok) return;
      assert.equal(res.context.editorTarget, "GameEditor");
      assert.equal(res.context.configuration, "DebugGame");
      assert.equal(res.context.platform, "Win64");
      assert.match(res.context.ubtCommand, /GameEditor Win64 DebugGame/);
      assert.match(res.context.ubtCommand, /-WaitMutex/);
      assert.equal(res.context.timeoutMs, 14_400_000);
      assert.match(res.context.editorExe.replace(/\\/g, "/"), /UnrealEditor-Win64-DebugGame\.exe$/);
    } finally {
      clearUeEngineRootCache();
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("launches an installed content-only project with the Development editor and no UBT gate", async () => {
    const parent = await mkdtemp(join(tmpdir(), "jb-ue-content-"));
    const project = join(parent, "Game");
    const engine = join(parent, "UnrealEngine", "Engine");
    try {
      await mkdir(project, { recursive: true });
      await writeFile(join(project, "Game.uproject"), "{}");
      await mkdir(join(engine, "Source", "Runtime"), { recursive: true });
      await mkdir(join(engine, "Build", "BatchFiles", "Mac"), { recursive: true });
      await writeFile(join(engine, "Build", "InstalledBuild.txt"), "");
      await writeFile(join(engine, "Build", "BatchFiles", "Mac", "Build.sh"), "#!/bin/sh\n");
      clearUeEngineRootCache();
      const res = await resolveUnrealLaunchContext(project, { platform: "darwin" });
      assert.equal(res.ok, true);
      if (!res.ok) return;
      assert.equal(res.context.editorTarget, "UnrealEditor");
      assert.equal(res.context.configuration, "Development");
      assert.equal(res.context.platform, "Mac");
      assert.equal(res.context.skipBuild, true);
      assert.match(res.context.editorExe.replace(/\\/g, "/"), /UnrealEditor\.app$/);
      assert.match(res.context.ubtCommand, /Mac Development/);
      assert.match(res.context.buildBat.replace(/\\/g, "/"), /BatchFiles\/Mac\/Build\.sh$/);
    } finally {
      clearUeEngineRootCache();
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("returns not_unreal for a plain folder", async () => {
    const root = await mkdtemp(join(tmpdir(), "jb-ue-none-"));
    try {
      const res = await resolveUnrealLaunchContext(root);
      assert.equal(res.ok, false);
      if (!res.ok) assert.equal(res.code, "not_unreal");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
