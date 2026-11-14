import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readEffectiveDevTasks } from "./devTaskResolve.js";
import { DEV_TASKS_FILE_REL } from "./devTaskConfig.js";
import { clearUeEngineRootCache } from "../unreal/engineRoot.js";

async function makeUeWorkspace(): Promise<{ parent: string; project: string }> {
  const parent = await mkdtemp(join(tmpdir(), "jb-ue-tasks-"));
  const project = join(parent, "Game");
  const engine = join(parent, "UnrealEngine", "Engine");
  await mkdir(join(project, "Source"), { recursive: true });
  await writeFile(join(project, "Game.uproject"), "{}");
  await writeFile(
    join(project, "Source", "GameEditor.Target.cs"),
    "Type = TargetType.Editor;\n",
  );
  await mkdir(join(engine, "Source", "Runtime"), { recursive: true });
  const bat = join(engine, "Build", "BatchFiles");
  await mkdir(bat, { recursive: true });
  await writeFile(join(bat, "Build.bat"), "@echo off\n");
  await writeFile(join(bat, "Build.sh"), "#!/bin/sh\n");
  return { parent, project };
}

describe("readEffectiveDevTasks", () => {
  it("injects a UBT build task when tasks.json has no build", async () => {
    const { parent, project } = await makeUeWorkspace();
    try {
      clearUeEngineRootCache();
      const res = await readEffectiveDevTasks(project);
      assert.equal(res.ok, true);
      if (!res.ok) return;
      assert.equal(res.origins.build, "unreal");
      assert.match(res.tasks.build!.command, /GameEditor/);
      assert.match(res.tasks.build!.command, /DebugGame/);
      assert.equal(res.tasks.build!.timeoutMs, 14_400_000);
      assert.equal(res.debugSupported, true);
      assert.equal(res.debugKind, "unreal");
    } finally {
      clearUeEngineRootCache();
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("keeps an explicit file build over UBT", async () => {
    const { parent, project } = await makeUeWorkspace();
    try {
      await mkdir(join(project, ".larry"), { recursive: true });
      await writeFile(
        join(project, DEV_TASKS_FILE_REL),
        JSON.stringify({
          version: 1,
          tasks: { build: { command: "echo custom" } },
        }),
      );
      clearUeEngineRootCache();
      const res = await readEffectiveDevTasks(project);
      assert.equal(res.ok, true);
      if (!res.ok) return;
      assert.equal(res.origins.build, "file");
      assert.equal(res.tasks.build!.command, "echo custom");
      // Generic 10-minute default is floored at the UBT ceiling in UE spaces.
      assert.equal(res.tasks.build!.timeoutMs, 14_400_000);
      assert.equal(res.debugSupported, true);
      assert.equal(res.debugKind, "unreal");
    } finally {
      clearUeEngineRootCache();
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("keeps an explicit large UE build timeout (floor, not cap)", async () => {
    const { parent, project } = await makeUeWorkspace();
    try {
      await mkdir(join(project, ".larry"), { recursive: true });
      await writeFile(
        join(project, DEV_TASKS_FILE_REL),
        JSON.stringify({
          version: 1,
          tasks: { build: { command: "echo custom", timeoutMs: 21_600_000 } },
        }),
      );
      clearUeEngineRootCache();
      const res = await readEffectiveDevTasks(project);
      assert.equal(res.ok, true);
      if (!res.ok) return;
      assert.equal(res.origins.build, "file");
      assert.equal(res.tasks.build!.timeoutMs, 21_600_000);
    } finally {
      clearUeEngineRootCache();
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("non-UE workspaces keep the generic build timeout default", async () => {
    const root = await mkdtemp(join(tmpdir(), "jb-plain-timeout-"));
    try {
      await mkdir(join(root, ".larry"), { recursive: true });
      await writeFile(
        join(root, DEV_TASKS_FILE_REL),
        JSON.stringify({
          version: 1,
          tasks: { build: { command: "npm run build" } },
        }),
      );
      const res = await readEffectiveDevTasks(root);
      assert.equal(res.ok, true);
      if (!res.ok) return;
      assert.equal(res.origins.build, "file");
      assert.equal(res.tasks.build!.timeoutMs, 600_000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not expose debug on a non-Unreal, non-Electron, non-web workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "jb-plain-tasks-"));
    try {
      const res = await readEffectiveDevTasks(root);
      assert.equal(res.ok, true);
      if (!res.ok) return;
      assert.equal(res.debugSupported, false);
      assert.equal(res.debugKind, null);
      assert.equal(res.tasks.build, undefined);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("exposes Electron debug when package.json depends on electron", async () => {
    const root = await mkdtemp(join(tmpdir(), "jb-e-tasks-"));
    try {
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({
          name: "desk",
          devDependencies: { electron: "43.0.0" },
        }),
      );
      const res = await readEffectiveDevTasks(root);
      assert.equal(res.ok, true);
      if (!res.ok) return;
      assert.equal(res.debugSupported, true);
      assert.equal(res.debugKind, "electron");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("exposes web debug when package.json is a Node server or page app", async () => {
    const root = await mkdtemp(join(tmpdir(), "jb-web-tasks-"));
    try {
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({
          name: "ethub",
          scripts: { dev: "vite", start: "node server.js" },
          dependencies: { express: "4" },
          devDependencies: { vite: "7" },
        }),
      );
      const res = await readEffectiveDevTasks(root);
      assert.equal(res.ok, true);
      if (!res.ok) return;
      assert.equal(res.debugSupported, true);
      assert.equal(res.debugKind, "web");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
