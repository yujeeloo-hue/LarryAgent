import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { WebContents } from "electron";
import {
  bindBreakpointCallback,
  listBreakpointCallbacks,
  unbindBreakpointCallbacksForOwner,
} from "../main/debugBreakpointCallback.js";
import {
  armStartCallback,
  evaluateStartCallbacks,
  listStartCallbacks,
  unbindStartCallbacksForOwner,
} from "../main/debugLifecycleCallback.js";
import { DebugSessionManager, type DebugSnapshot } from "./debugSessionManager.js";

async function createProject(parent: string, name: string): Promise<string> {
  const workspacePath = join(parent, name);
  await mkdir(workspacePath);
  await Promise.all([
    writeFile(join(workspacePath, "package.json"), JSON.stringify({ scripts: { start: "node server.js" } })),
    writeFile(join(workspacePath, "server.js"), "setInterval(() => {}, 10_000);"),
  ]);
  return workspacePath;
}

function debuggeePid(snapshot: DebugSnapshot): number {
  const pid = Number(snapshot.console?.[0]?.text.match(/\(pid (\d+)\)/)?.[1]);
  assert.ok(Number.isInteger(pid) && pid > 0);
  return pid;
}

test("starting debug in another workspace keeps the active debuggee alive", async () => {
  const parent = await mkdtemp(join(tmpdir(), "jellybot-debug-workspace-"));
  const manager = new DebugSessionManager(async () => null);
  const owner = Object.assign(new EventEmitter(), {
    id: 1, isDestroyed: () => false, send: () => undefined,
  }) as unknown as WebContents;

  try {
    const workspacePath = await createProject(parent, "running");
    const other = await createProject(parent, "other");
    const started = await manager.start(owner, { workspacePath, breakpoints: [] });
    if (!started.ok) assert.fail(started.message);

    const result = await manager.start(owner, { workspacePath: other, breakpoints: [] });
    assert.equal(result.ok, false);
    assert.match(result.message, /already active/);
    assert.equal(result.snapshot?.workspacePath, workspacePath);
    assert.equal(manager.state(owner).workspacePath, workspacePath);
    assert.equal(manager.state(owner).status, "running");

    const stopping = manager.stop(owner);
    const restarted = await manager.start(owner, { workspacePath: other, breakpoints: [] });
    await stopping;
    if (!restarted.ok) assert.fail(restarted.message);
    assert.equal(manager.state(owner).workspacePath, other);
    assert.equal(manager.state(owner).status, "running");
  } finally {
    await manager.dispose();
    await rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("restarts after a debuggee is killed while its old attachment is still pending", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "jellybot-debug-restart-"));
  const clearCallbacks = (ownerId: number) => {
    unbindBreakpointCallbacksForOwner(ownerId);
    unbindStartCallbacksForOwner(ownerId);
  };
  const manager = new DebugSessionManager(async () => null, undefined, clearCallbacks);
  const owner = Object.assign(new EventEmitter(), {
    id: 1, isDestroyed: () => false, send: () => undefined,
  }) as unknown as WebContents;
  const notices: string[] = [];
  manager.onState((ownerId, snapshot) => evaluateStartCallbacks(ownerId, snapshot, {
    notify: ({ sessionId }) => { notices.push(sessionId); },
  }));
  let finishOldAttachment!: () => void;
  let finishNewAttachment!: () => void;
  const attachments = [
    new Promise<void>((resolve) => { finishOldAttachment = resolve; }),
    new Promise<void>((resolve) => { finishNewAttachment = resolve; }),
  ];
  t.mock.method(manager as unknown as { attachWeb(): Promise<void> }, "attachWeb", async () => {
    await attachments.shift();
  });

  try {
    const workspacePath = await createProject(parent, "project");
    const request = { workspacePath, breakpoints: [] };
    const started = await manager.start(owner, request, () => {
      armStartCallback({ ownerId: owner.id, sessionId: "old", workspacePath });
    });
    if (!started.ok) assert.fail(started.message);
    assert.deepEqual(notices, ["old"]);
    bindBreakpointCallback({
      ownerId: owner.id, sessionId: "old", workspacePath,
      path: join(workspacePath, "server.js"), line: 1,
    });
    const pid = debuggeePid(started.snapshot);
    process.kill(pid, "SIGKILL");
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
        break;
      }
      await delay(10);
    }

    const restarted = await manager.start(owner, request);
    if (!restarted.ok) assert.fail(restarted.message);
    assert.equal(restarted.snapshot.status, "running");
    assert.deepEqual(notices, ["old"]);
    assert.deepEqual(listStartCallbacks(owner.id), []);
    assert.deepEqual(listBreakpointCallbacks({ ownerId: owner.id }), []);
    finishOldAttachment();
    await delay(0);
    assert.equal(manager.state(owner), restarted.snapshot);

    const next = await manager.start(owner, request, () => {
      armStartCallback({ ownerId: owner.id, sessionId: "new", workspacePath });
    });
    if (!next.ok) assert.fail(next.message);
    assert.equal(manager.state(owner), next.snapshot);
    assert.throws(() => process.kill(debuggeePid(restarted.snapshot), 0), { code: "ESRCH" });
    assert.deepEqual(notices, ["old", "new"]);
    bindBreakpointCallback({
      ownerId: owner.id, sessionId: "new", workspacePath,
      path: join(workspacePath, "server.js"), line: 1,
    });
    await manager.stop(owner);
    assert.throws(() => process.kill(debuggeePid(next.snapshot), 0), { code: "ESRCH" });
    assert.deepEqual(listStartCallbacks(owner.id), []);
    assert.deepEqual(listBreakpointCallbacks({ ownerId: owner.id }), []);
    const withoutCallback = await manager.start(owner, request);
    if (!withoutCallback.ok) assert.fail(withoutCallback.message);
    assert.deepEqual(notices, ["old", "new"]);
  } finally {
    finishOldAttachment();
    finishNewAttachment();
    await manager.dispose();
    clearCallbacks(owner.id);
    await rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
