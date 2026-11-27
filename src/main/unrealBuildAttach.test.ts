import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { TrackedBuildProcess } from "../unreal/buildOwnership.js";
import { awaitDevTaskRun, getDevTaskState, runDevTask, stopDevTask } from "./devTasks.js";
import { pidAlive, setUnrealBuildProcessSourceForTests } from "./unrealBuildControl.js";

function sleeper(): ChildProcess {
  return spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
}

function compiler(pid: number, uproject: string): TrackedBuildProcess {
  return {
    pid,
    parentPid: 0,
    name: "dotnet.exe",
    commandLine: `dotnet UnrealBuildTool.dll GameEditor Win64 Development -Project="${uproject}" -WaitMutex -FromMsBuild`,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("timed out waiting for the build run");
}

describe("unreal build attach and force stop", { concurrency: 1 }, () => {
  test("Build attaches to a live UnrealBuildTool instead of starting another", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "larry-ubt-attach-"));
    const uproject = join(root, "Game.uproject");
    const external = sleeper();
    t.after(async () => {
      setUnrealBuildProcessSourceForTests(null);
      if (external.pid && pidAlive(external.pid)) external.kill();
      await rm(root, { recursive: true, force: true });
    });
    await writeFile(uproject, "{}\n");
    assert.ok(external.pid);
    setUnrealBuildProcessSourceForTests(async () => [compiler(external.pid!, uproject)]);
    const run = await runDevTask(null, root, "build", {
      definition: {
        command: `"${process.execPath}" -e "console.log('SHOULD_NOT_RUN')"`,
        cwd: root,
        timeoutMs: 15_000,
        env: {},
      },
      adoptExternalBuild: true,
    });
    assert.ok(run.ok);
    if (!run.ok) return;
    await waitFor(() => (getDevTaskState(root).active[0]?.buffer ?? "").includes("Attached to an existing Unreal build"));
    assert.equal((getDevTaskState(root).active[0]?.buffer ?? "").includes("SHOULD_NOT_RUN"), false);
    assert.equal(stopDevTask(run.runId).ok, true);
    await waitFor(() => !pidAlive(external.pid!));
    assert.equal((await awaitDevTaskRun(run.runId))?.status, "cancelled");
  });

  test("Build starts normally when nothing is already compiling", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "larry-ubt-empty-"));
    t.after(async () => {
      setUnrealBuildProcessSourceForTests(null);
      await rm(root, { recursive: true, force: true });
    });
    await writeFile(join(root, "Game.uproject"), "{}\n");
    setUnrealBuildProcessSourceForTests(async () => []);
    const run = await runDevTask(null, root, "build", {
      definition: {
        command: `"${process.execPath}" -e "console.log('RAN')"`,
        cwd: root,
        timeoutMs: 15_000,
        env: {},
      },
      adoptExternalBuild: true,
    });
    assert.ok(run.ok);
    if (!run.ok) return;
    await waitFor(() => (getDevTaskState(root).active[0]?.buffer ?? getDevTaskState(root).last.build?.buffer ?? "").includes("RAN"));
    const finished = await awaitDevTaskRun(run.runId);
    assert.equal(finished?.status, "done");
    assert.match(finished?.buffer ?? "", /Checking for an Unreal build already in progress/);
  });

  test("Stop kills an Unreal compiler that is not a child of the build script", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "larry-ubt-kill-"));
    const uproject = join(root, "Game.uproject");
    const external = sleeper();
    t.after(async () => {
      setUnrealBuildProcessSourceForTests(null);
      if (external.pid && pidAlive(external.pid)) external.kill();
      await rm(root, { recursive: true, force: true });
    });
    await writeFile(uproject, "{}\n");
    assert.ok(external.pid);
    setUnrealBuildProcessSourceForTests(async () => [compiler(external.pid!, uproject)]);
    const run = await runDevTask(null, root, "build", {
      definition: { command: "kept alive by prepare", cwd: root, timeoutMs: 15_000, env: {} },
      prepare: async () => ({ file: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] }),
    });
    assert.ok(run.ok);
    if (!run.ok) return;
    await waitFor(() => (getDevTaskState(root).active[0]?.buffer ?? "").includes("Starting"));
    assert.equal(stopDevTask(run.runId).ok, true);
    await waitFor(() => !pidAlive(external.pid!));
    assert.equal((await awaitDevTaskRun(run.runId))?.status, "cancelled");
  });
});
