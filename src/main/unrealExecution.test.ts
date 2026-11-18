import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runDevTask, stopDevTask, awaitDevTaskRun, getDevTaskState } from "./devTasks.js";

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
