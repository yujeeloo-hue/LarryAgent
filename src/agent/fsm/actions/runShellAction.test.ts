/**
 * NodeActionRunShell — node-attached shell execution via the Host `runShell`
 * capability. Covers: stub skip, param passthrough, nodeContext contract
 * (shellExitCode / shellStdout / shellStderr), onError halt/continue, and
 * EdgeWhen (source: node) routing on shellExitCode inside a real graph run.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  FsmRunShellInput,
  FsmRunShellResult,
  RunAgentTurnInput,
} from "../../types.js";
import type { PermissionGateState } from "../../../tools/types.js";
import type { Session } from "../../../session/types.js";
import type { FsmHostCapabilities } from "../FsmHostCapabilities.js";
import { FSMConfigError } from "../FSMConfigError.js";
import { FSMGraph } from "../FSMGraph.js";
import { createDefaultActionRegistry } from "./createDefaultActionRegistry.js";
import { NodeActionRunShell } from "./NodeActionRunShell.js";
import { createFSMGraphConfig } from "../types.js";

function makeSession(): Session {
  const now = Date.now();
  return {
    id: "run-shell-test-sess",
    type: "agent",
    title: "Shell graph",
    createdAt: now,
    updatedAt: now,
    status: "running",
    progressText: "",
    messages: [],
    model: "mock-model",
    providerId: "mock",
    workspaceId: "ws1",
    workspacePath: "",
    pinned: false,
    archived: false,
    archivedAt: null,
    contextUsage: { usedTokens: 0 },
    plan: null,
    planDoc: null,
    phase: null,
  } as Session;
}

function okResult(overrides: Partial<FsmRunShellResult> = {}): FsmRunShellResult {
  return {
    status: "ok",
    exitCode: 0,
    stdout: "out",
    stderr: "",
    timedOut: false,
    cancelled: false,
    command: "echo out",
    cwd: "/ws",
    ...overrides,
  };
}

function makeHost(
  runShell: (input: FsmRunShellInput) => Promise<FsmRunShellResult>,
  progress: string[] = [],
): FsmHostCapabilities {
  return {
    session: makeSession(),
    isSubagentTurn: false,
    createId: () => "id",
    gate: { fullPermissionsEnabled: true } as PermissionGateState,
    runShell,
    getCounters: () => ({
      modelIterations: 0,
      turnBillableTokens: 0,
      toolFailureCount: 0,
      turnModelIterations: 0,
      toolErrorCount: 0,
      toolRecoveryCount: 0,
      skillsReadCount: 0,
    }),
    setCounters: () => {},
    resetTurnBudgets: () => {},
    applySessionPatch: () => {},
    planDocExists: () => false,
    deletePlanDoc: () => {},
    startTurn: async () => "ok" as const,
    checkAbort: () => false,
    enforceBudget: async () => "resume" as const,
    drainPendingSteer: async () => false,
    hasPendingSteer: () => false,
    prepareTools: () => ({ tools: [] }),
    prepareModelWindow: async () => ({
      ok: true,
      messages: [{ role: "user", content: "hi" }],
      estimatedTokens: 1,
      compacted: false,
    }),
    streamModelRound: async () => {
      throw new Error("not used in these tests");
    },
    runToolsPhase: async () => ({
      kind: "ok",
      cancelled: false,
      toolFailureCount: 0,
    }),
    awaitSubagentBatches: async () => "none",
    finalizeEmptyAssistant: () => {},
    finish: async (status) => ({ status, modelIterations: 0 }),
    emitProgress: (text) => progress.push(text),
    emitError: () => {},
  };
}

function execArgs(host?: FsmHostCapabilities) {
  return {
    turnContext: {},
    nodeContext: {},
    ...(host ? { host } : {}),
  };
}

describe("NodeActionRunShell registry", () => {
  it("is in the editor catalog with a params schema", () => {
    const catalog = createDefaultActionRegistry().listActionCatalog();
    const entry = catalog.find((c) => c.type === "NodeActionRunShell");
    assert.ok(entry);
    assert.equal(entry.title, "Run shell");
    const onError = entry.paramsSchema.properties?.onError;
    assert.ok(onError && "enum" in onError);
    assert.deepEqual(onError.enum, ["halt", "continue"]);
  });

  it("factory requires exactly one of command / scriptPath", () => {
    const registry = createDefaultActionRegistry();
    assert.throws(
      () => registry.createAction("NodeActionRunShell", {}, "t"),
      FSMConfigError,
    );
    assert.throws(
      () =>
        registry.createAction(
          "NodeActionRunShell",
          { command: "echo hi", scriptPath: "a.sh" },
          "t",
        ),
      (err: unknown) =>
        err instanceof FSMConfigError && /only one/.test(err.message),
    );
    const action = registry.createAction(
      "NodeActionRunShell",
      { command: "echo hi" },
      "t",
    );
    assert.ok(action instanceof NodeActionRunShell);
  });
});

describe("NodeActionRunShell Exec", () => {
  it("stub path (no host / no capability) skips silently", async () => {
    const action = new NodeActionRunShell({ command: "echo hi" });
    const bare = await action.Exec(execArgs());
    assert.equal(bare.status, "continue");
    assert.equal(bare.nodeContextPatch?.shellSkipped, true);
  });

  it("passes command / cwd / timeoutMs through and lands results in nodeContext", async () => {
    const inputs: FsmRunShellInput[] = [];
    const progress: string[] = [];
    const action = new NodeActionRunShell({
      command: "echo out",
      cwd: "/tmp/x",
      timeoutMs: 5_000,
    });
    const result = await action.Exec(
      execArgs(
        makeHost(async (input) => {
          inputs.push(input);
          return okResult({ cwd: "/tmp/x" });
        }, progress),
      ),
    );
    assert.equal(result.status, "continue");
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0]!.command, "echo out");
    assert.equal(inputs[0]!.cwd, "/tmp/x");
    assert.equal(inputs[0]!.timeoutMs, 5_000);
    const patch = result.nodeContextPatch ?? {};
    assert.equal(patch.shellRan, true);
    assert.equal(patch.shellExitCode, 0);
    assert.equal(patch.shellStdout, "out");
    assert.equal(patch.shellStderr, "");
    assert.equal(patch.shellTimedOut, false);
    assert.equal(patch.shellCancelled, false);
    assert.ok(progress.some((t) => t.startsWith("Run shell:")));
    assert.ok(
      !progress.some((t) => t.startsWith("Shell ")),
      "no terminal progress word after completion — the next node owns the line",
    );
  });

  it("halts by default on non-zero exit and includes stderr", async () => {
    const action = new NodeActionRunShell({ command: "exit 3" });
    const result = await action.Exec(
      execArgs(
        makeHost(async () =>
          okResult({
            status: "error",
            exitCode: 3,
            stderr: "boom\n",
          }),
        ),
      ),
    );
    assert.equal(result.status, "halt");
    assert.match(result.errorMessage ?? "", /boom/);
    assert.equal(result.nodeContextPatch?.shellExitCode, 3);
  });

  it("continues on failure when onError is continue", async () => {
    const action = new NodeActionRunShell({
      command: "exit 3",
      onError: "continue",
    });
    const result = await action.Exec(
      execArgs(
        makeHost(async () =>
          okResult({ status: "error", exitCode: 3, stderr: "boom" }),
        ),
      ),
    );
    assert.equal(result.status, "continue");
    assert.equal(result.nodeContextPatch?.shellExitCode, 3);
  });

  it("halts on timeout with a timeout message", async () => {
    const action = new NodeActionRunShell({ command: "sleep 99" });
    const result = await action.Exec(
      execArgs(
        makeHost(async () =>
          okResult({
            status: "error",
            exitCode: null,
            timedOut: true,
            errorMessage: "Shell script timed out after 60000ms.",
          }),
        ),
      ),
    );
    assert.equal(result.status, "halt");
    assert.match(result.errorMessage ?? "", /timed out/);
    assert.equal(result.nodeContextPatch?.shellTimedOut, true);
  });

  it("halts on cancel", async () => {
    const action = new NodeActionRunShell({ command: "sleep 99" });
    const result = await action.Exec(
      execArgs(
        makeHost(async () =>
          okResult({ status: "error", cancelled: true, errorMessage: "Shell execution cancelled." }),
        ),
      ),
    );
    assert.equal(result.status, "halt");
    assert.equal(result.nodeContextPatch?.shellCancelled, true);
  });

  it("halts defensively when params lost both sources", async () => {
    const action = new NodeActionRunShell({});
    const result = await action.Exec(execArgs(makeHost(async () => okResult())));
    assert.equal(result.status, "halt");
    assert.match(result.errorMessage ?? "", /command.*scriptPath/);
  });
});

describe("NodeActionRunShell graph routing", () => {
  function shellGraph(onError: "halt" | "continue") {
    return createFSMGraphConfig({
      entryNodeId: "start",
      terminalNodeId: "end",
      nodes: [
        {
          id: "start",
          actions: [
            {
              type: "NodeActionRunShell",
              params: { command: "check", onError },
            },
          ],
        },
        { id: "ok", actions: [] },
        { id: "fail", actions: [] },
        { id: "end", actions: [] },
      ],
      edges: [
        {
          from: "start",
          to: "ok",
          type: "EdgeWhen",
          params: { turnKey: "shellExitCode", equals: 0, source: "node" },
        },
        {
          from: "start",
          to: "fail",
          type: "EdgeWhen",
          params: { turnKey: "shellExitCode", equals: 1, source: "node" },
        },
        { from: "ok", to: "end", type: "EdgeAlways" },
        { from: "fail", to: "end", type: "EdgeAlways" },
      ],
    });
  }

  it("EdgeWhen (source: node) routes on shellExitCode after success", async () => {
    const result = await FSMGraph.run(shellGraph("halt"), {}, {
      registries: createDefaultActionRegistry(),
      host: makeHost(async () => okResult({ exitCode: 0 })),
    });
    assert.equal(result.reason, "end_node");
    assert.deepEqual(result.nodesVisited, ["start", "ok", "end"]);
  });

  it("default onError=halt stops the turn before routing on failure", async () => {
    const result = await FSMGraph.run(shellGraph("halt"), {}, {
      registries: createDefaultActionRegistry(),
      host: makeHost(async () =>
        okResult({ status: "error", exitCode: 1, stderr: "x" }),
      ),
    });
    assert.equal(result.reason, "halt");
    assert.deepEqual(result.nodesVisited, ["start"]);
    assert.match(result.errorMessage ?? "", /Run shell failed/);
  });

  it("onError=continue lets edges branch to the failure node", async () => {
    const result = await FSMGraph.run(shellGraph("continue"), {}, {
      registries: createDefaultActionRegistry(),
      host: makeHost(async () =>
        okResult({ status: "error", exitCode: 1, stderr: "x" }),
      ),
    });
    assert.equal(result.reason, "end_node");
    assert.deepEqual(result.nodesVisited, ["start", "fail", "end"]);
  });
});
