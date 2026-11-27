import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { WebContents } from "electron";
import { DebugSessionManager, type DebugSnapshot } from "../debug/debugSessionManager.js";
import { resolveBuildScript } from "../unreal/ubtCommand.js";
import { getUnrealWorkspace, invalidateUnrealWorkspace } from "../unreal/workspace.js";
import { runDevTask, stopDevTask, awaitDevTaskRun, getDevTaskState } from "./devTasks.js";

test("Unreal Debug obeys Precompile and stops on compiler failure when enabled", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "larry-unreal-debug-build-"));
  const workspacePath = join(parent, "Game");
  const engineRoot = join(parent, "UnrealEngine", "Engine");
  t.after(async () => {
    invalidateUnrealWorkspace(workspacePath);
    await rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const write = async (path: string, text: string) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  };
  const buildScript = resolveBuildScript(engineRoot, process.platform);
  const windows = process.platform === "win32";
  await Promise.all([
    write(join(workspacePath, "Game.uproject"), "{}"),
    write(join(workspacePath, "Source", "GameEditor.Target.cs"), "Type = TargetType.Editor;"),
    write(join(engineRoot, "Source", "Runtime", "Core", "Core.Build.cs"), ""),
    write(buildScript, windows
      ? "@echo off\r\necho error C2065: missingName\r\nexit /b 1\r\n"
      : "#!/bin/sh\necho 'error C2065: missingName'\nexit 1\n"),
  ]);
  if (!windows) await chmod(buildScript, 0o755);
  const buildId = (await getUnrealWorkspace(workspacePath))?.selectedId;
  assert.ok(buildId);
  const phases: DebugSnapshot["status"][] = [];
  const owner = {
    id: 1,
    isDestroyed: () => false,
    send: (channel: string, payload: DebugSnapshot) => {
      if (channel === "debug:state") phases.push(payload.status);
    },
  } as unknown as WebContents;
  const adapter = t.mock.fn(async () => null);
  let precompile = true;
  const manager = new DebugSessionManager(adapter, undefined, undefined, async () => precompile);
  const request = { workspacePath, buildId, breakpoints: [] };

  const failed = await manager.start(owner, request);
  assert.equal(failed.ok, false);
  assert.equal(failed.buildFailed, true);
  assert.match(failed.message, /error C2065: missingName/);
  assert.deepEqual(phases, ["building", "error"]);
  assert.equal(adapter.mock.calls.length, 0);
  assert.equal(getDevTaskState(workspacePath, buildId).last.build?.exitCode, 1);

  precompile = false;
  phases.length = 0;
  await manager.start(owner, request);
  assert.ok(phases.includes("starting"));
  assert.ok(!phases.includes("building"));
  assert.equal(adapter.mock.calls.length, 1);
  assert.equal(getDevTaskState(workspacePath, buildId).last.build?.exitCode, 1);

  precompile = true;
  await writeFile(buildScript, windows ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n");
  phases.length = 0;
  await manager.start(owner, request);
  assert.deepEqual(phases, ["building", "starting", "idle"]);
  assert.equal(adapter.mock.calls.length, 2);
  assert.equal(getDevTaskState(workspacePath, buildId).last.build?.exitCode, 0);
});

test("build records are isolated by combination and engine builds serialize", async () => {
  const root = await mkdtemp(join(tmpdir(), "larry-unreal-build-state-"));
  try {
    const definition = { command: "echo build", cwd: root, timeoutMs: 5000, env: {} };
    const first = await runDevTask(null, root, "build", { definition, buildIdentity: "debug", engineRoot: "/same/engine" });
    assert.ok(first.ok); if (!first.ok) return;
    const competing = await runDevTask(null, root, "build", { definition, buildIdentity: "development", engineRoot: "/same/engine" });
    assert.equal(competing.ok, false);
    const finished = await awaitDevTaskRun(first.runId);
    assert.equal(finished?.status, "done");
    assert.equal(getDevTaskState(root, "debug").buildGate.ok, true);
    assert.equal(getDevTaskState(root, "development").buildGate.ok, false);
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test("project-file generation does not overlap engine builds", async () => {
  const root = await mkdtemp(join(tmpdir(), "larry-unreal-generate-"));
  try {
    const busy = { command: `"${process.execPath}" -e "setInterval(()=>{},1000)"`, cwd: root, timeoutMs: 8000, env: {} };
    const build = await runDevTask(null, root, "build", { definition: busy, engineRoot: "/same/engine" });
    assert.ok(build.ok); if (!build.ok) return;
    const generate = await runDevTask(null, root, "generate", {
      definition: { command: "echo generate", cwd: root, timeoutMs: 1000, env: {} },
      engineRoot: "/same/engine",
    });
    assert.equal(generate.ok, false);
    if (!generate.ok) assert.match(generate.message, /already running/);
    stopDevTask(build.runId);
    await awaitDevTaskRun(build.runId);
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test("Run launches without a debugger, streams output, preserves literal args and stops its process", async () => {
  const root = await mkdtemp(join(tmpdir(), "larry-unreal-run-"));
  try {
    const text = "space 中文 %TEMP% & literal";
    const run = await runDevTask(null, root, "run", {
      definition: { command: "Run selected target", cwd: root, timeoutMs: 0, env: {} },
      buildIdentity: "development",
      prepare: async () => ({ file: process.execPath, args: ["-e", "console.log(process.argv[1]);setInterval(()=>{},1000)", text] }),
    });
    assert.ok(run.ok); if (!run.ok) return;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !getDevTaskState(root).active[0]?.buffer.includes(text)) await new Promise(resolve => setTimeout(resolve, 25));
    assert.ok(getDevTaskState(root).active[0]?.buffer.includes(text));
    assert.ok(stopDevTask(run.runId).ok);
    assert.equal((await awaitDevTaskRun(run.runId))?.status, "cancelled");
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test("failed preparation never launches; cancelled observers do not cancel an adopted build", async () => {
  const root = await mkdtemp(join(tmpdir(), "larry-unreal-cancel-"));
  try {
    const failed = await runDevTask(null, root, "run", {
      definition: { command: "must not launch", cwd: root, timeoutMs: 0, env: {} },
      prepare: async () => { throw new Error("Build failed"); },
    });
    assert.ok(failed.ok); if (!failed.ok) return;
    assert.equal((await awaitDevTaskRun(failed.runId))?.status, "failed");
    const running = await runDevTask(null, root, "run", {
      definition: { command: "long running", cwd: root, timeoutMs: 0, env: {} },
      prepare: async () => ({ file: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] }),
    });
    assert.ok(running.ok); if (!running.ok) return;
    const abort = new AbortController();
    const wait = awaitDevTaskRun(running.runId, abort.signal);
    abort.abort(); assert.equal(await wait, null);
    assert.equal(getDevTaskState(root).active.length, 1);
    stopDevTask(running.runId); await awaitDevTaskRun(running.runId);
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
