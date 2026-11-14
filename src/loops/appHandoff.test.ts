/**
 * Tests for the Loops App-handoff executor + server (unix socket).
 * Executor logic uses a fake HandoffClient; one round-trip test drives the
 * real socket server + socket client end to end.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loopsDaemonManaged } from "../platformCaps.js";
import {
  createHandoffExecutor,
  createSocketHandoffClient,
  type HandoffClient,
} from "./appHandoff.js";
import { createLoopsHandoffServer } from "../main/loops/handoffServer.js";
import { loopsHandoffSocketPath } from "./handoffProtocol.js";
import type { LoopRecord } from "./db.js";

function fakeLoop(): LoopRecord {
  return {
    id: "loop-1",
    name: "Test",
    prompt: "say hi",
    workspaceId: "ws-1",
    runMode: "agent",
    providerId: "deepseek",
    reasoningEffort: "low",
    fullPermissions: false,
    cadenceJson: '{"kind":"minute","n":5}',
    enabled: true,
    nextRunAt: 0,
    lastRunAt: null,
    runCount: 0,
    createdAt: 0,
    updatedAt: 0,
  };
}

type ScriptedClient = HandoffClient & {
  probeCalls: number;
  runCalls: number;
};

function scriptedClient(
  script: {
    probe?: "alive" | "absent";
    run?:
      | { kind: "ack"; sessionId: string; pid: number }
      | { kind: "absent"; reason: string }
      | { kind: "lost"; reason: string };
    statuses: Array<
      { status: string; error?: string } | { absent: true }
    >;
    cancels: string[];
  },
): ScriptedClient {
  return {
    probeCalls: 0,
    runCalls: 0,
    async probe() {
      this.probeCalls += 1;
      return script.probe === "absent"
        ? { kind: "absent", reason: "app socket not ready" }
        : { kind: "alive" };
    },
    async requestRun() {
      this.runCalls += 1;
      return script.run ?? { kind: "ack", sessionId: "sess-1", pid: 42 };
    },
    async pollStatus() {
      const next = script.statuses.shift() ?? { status: "completed" };
      return "absent" in next ? ({ absent: true } as const) : next;
    },
    async requestCancel(sessionId) {
      script.cancels.push(sessionId);
    },
  };
}

test("falls back to local executor when app is absent", async () => {
  const client = scriptedClient({ probe: "absent", statuses: [] , cancels: []});
  let localRuns = 0;
  const executor = createHandoffExecutor(
    async () => {
      localRuns += 1;
      return { status: "succeeded", sessionId: "local-sess" };
    },
    client,
    { pollIntervalMs: 1 },
  );
  const result = await executor(fakeLoop());
  assert.equal(localRuns, 1);
  assert.equal(result.status, "succeeded");
  assert.equal((result as { sessionId?: string }).sessionId, "local-sess");
  assert.equal(client.runCalls, 0);
});

test("falls back to local when app rejects the run", async () => {
  const client = scriptedClient({
    run: { kind: "absent", reason: "not-ready" },
    statuses: [],
    cancels: [],
  });
  let localRuns = 0;
  const executor = createHandoffExecutor(
    async () => {
      localRuns += 1;
      return { status: "succeeded" };
    },
    client,
    { pollIntervalMs: 1 },
  );
  const result = await executor(fakeLoop());
  assert.equal(localRuns, 1);
  assert.equal(result.status, "succeeded");
});

test("ack then success: never calls local executor", async () => {
  const client = scriptedClient({
    statuses: [{ status: "running" }, { status: "running" }, { status: "completed" }],
    cancels: [],
  });
  let localRuns = 0;
  const executor = createHandoffExecutor(
    async () => {
      localRuns += 1;
      return { status: "succeeded" };
    },
    client,
    { pollIntervalMs: 1 },
  );
  const result = await executor(fakeLoop());
  assert.equal(localRuns, 0);
  assert.equal(result.status, "succeeded");
  assert.equal(result.sessionId, "sess-1");
});

test("app goes away mid-run: failed, no local retry", async () => {
  const client = scriptedClient({
    statuses: [{ status: "running" }, { absent: true }],
    cancels: [],
  });
  let localRuns = 0;
  const executor = createHandoffExecutor(
    async () => {
      localRuns += 1;
      return { status: "succeeded" };
    },
    client,
    { pollIntervalMs: 1 },
  );
  const result = await executor(fakeLoop());
  assert.equal(localRuns, 0);
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /app exited during run/);
});

test("lost ack (no response): failed, never re-runs locally", async () => {
  const client = scriptedClient({
    run: { kind: "lost", reason: "no response from app" },
    statuses: [],
    cancels: [],
  });
  let localRuns = 0;
  const executor = createHandoffExecutor(
    async () => {
      localRuns += 1;
      return { status: "succeeded" };
    },
    client,
    { pollIntervalMs: 1 },
  );
  const result = await executor(fakeLoop());
  assert.equal(localRuns, 0);
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /handoff response lost/);
});

test("error status maps to failed with message", async () => {
  const client = scriptedClient({
    statuses: [{ status: "running" }, { status: "error", error: "boom" }],
    cancels: [],
  });
  const executor = createHandoffExecutor(async () => ({ status: "succeeded" }), client, {
    pollIntervalMs: 1,
  });
  const result = await executor(fakeLoop());
  assert.equal(result.status, "failed");
  assert.equal(result.error, "boom");
});

test("timeout: best-effort cancel then timeout status", async () => {
  const cancels: string[] = [];
  const client = scriptedClient({
    statuses: Array.from({ length: 50 }, () => ({ status: "running" })),
    cancels,
  });
  const executor = createHandoffExecutor(async () => ({ status: "succeeded" }), client, {
    runTimeoutMs: 10,
    pollIntervalMs: 1,
  });
  const result = await executor(fakeLoop());
  assert.equal(result.status, "timeout");
  assert.deepEqual(cancels, ["sess-1"]);
});

test("fast turn that settles before running is observed still succeeds (grace)", async () => {
  const client = scriptedClient({
    statuses: [{ status: "idle" }, { status: "completed" }],
    cancels: [],
  });
  const executor = createHandoffExecutor(async () => ({ status: "succeeded" }), client, {
    pollIntervalMs: 1,
    startGracePolls: 5,
  });
  const result = await executor(fakeLoop());
  assert.equal(result.status, "succeeded");
});

// ------------------------------------------------------ real socket e2e

test("socket round trip: server + client (run → status → cancel)", { skip: !loopsDaemonManaged }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "loops-handoff-"));
  const socketPath = loopsHandoffSocketPath(dir);
  const started: string[] = [];
  const statuses = new Map<string, string>([["sess-9", "completed"]]);
  const server = createLoopsHandoffServer(socketPath, {
    startTurn: async (input) => {
      started.push(input.loopId);
      if (input.prompt === "fail") return { error: "unknown workspace" };
      return { sessionId: "sess-9" };
    },
    getSessionStatus: (sessionId) =>
      statuses.has(sessionId)
        ? { status: statuses.get(sessionId) as string }
        : null,
    cancelTurn: (sessionId) => statuses.delete(sessionId),
  });
  await server.start();

  const client = createSocketHandoffClient(socketPath);

  // ping
  const probe = await client.probe();
  assert.equal(probe.kind, "alive");

  // run happy path
  const run = await client.requestRun(fakeLoop());
  assert.ok(run.kind === "ack");
  assert.equal(run.sessionId, "sess-9");
  assert.deepEqual(started, ["loop-1"]);

  // status
  const status = await client.pollStatus("sess-9");
  assert.ok(!("absent" in status));
  assert.equal(status.status, "completed");

  // unknown session status
  const unknown = await client.pollStatus("nope");
  assert.ok("absent" in unknown);

  // cancel
  await client.requestCancel("sess-9");
  const afterCancel = await client.pollStatus("sess-9");
  assert.ok("absent" in afterCancel);

  // rejected run (app-side error) → absent → daemon runs locally
  const failing = { ...fakeLoop(), prompt: "fail" };
  const rejected = await client.requestRun(failing);
  assert.equal(rejected.kind, "absent");
  assert.equal(rejected.reason, "unknown workspace");

  await server.stop();

  // After stop, the socket is gone → probe absent.
  const postStop = await client.probe();
  assert.equal(postStop.kind, "absent");

  rmSync(dir, { recursive: true, force: true });
});

test("server restart unlinks a stale socket file", { skip: !loopsDaemonManaged }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "loops-handoff-"));
  const socketPath = loopsHandoffSocketPath(dir);
  const server = createLoopsHandoffServer(socketPath, {
    startTurn: async () => ({ sessionId: "s" }),
    getSessionStatus: () => null,
    cancelTurn: () => false,
  });
  await server.start();
  await server.stop();
  // Simulate a crash leftover: file exists, nobody listening.
  const { writeFileSync } = await import("node:fs");
  writeFileSync(socketPath, "");
  const revived = createLoopsHandoffServer(socketPath, {
    startTurn: async () => ({ sessionId: "s" }),
    getSessionStatus: () => null,
    cancelTurn: () => false,
  });
  await revived.start();
  const client = createSocketHandoffClient(socketPath);
  const probe = await client.probe();
  assert.equal(probe.kind, "alive");
  await revived.stop();
  rmSync(dir, { recursive: true, force: true });
});
