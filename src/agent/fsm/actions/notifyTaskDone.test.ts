/**
 * NodeActionNotifyTaskDone — End-node completion notification.
 * Behavior: parent Auto / Plan turns that ran ≥ minElapsedMs fire
 * host.desktopNotify once; subagent / Ask turns and short turns never do.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RunAgentTurnInput } from "../../types.js";
import type { PermissionGateState } from "../../../tools/types.js";
import type { Session } from "../../../session/types.js";
import type { FsmHostCapabilities } from "../FsmHostCapabilities.js";
import type { DesktopNotifyInput } from "../../types.js";
import {
  DEFAULT_TASK_DONE_MIN_ELAPSED_MS,
  NodeActionNotifyTaskDone,
} from "./NodeActionNotifyTaskDone.js";
import { NodeActionStartTurn } from "./NodeActionStartTurn.js";
import { createTurnScope } from "../../workflow/turnScope.js";
import {
  createAskGraphConfig,
  createPlanExecuteV3GraphConfig,
  createReactGraphConfig,
  createSubagentGraphConfig,
} from "../configs/sampleGraphs.js";

function makeSession(): Session {
  const now = Date.now();
  return {
    id: "notify-test-sess",
    type: "agent",
    title: "Refactor FSM docs",
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

type HostOverrides = {
  isSubagentTurn?: boolean;
  desktopNotify?: (input: DesktopNotifyInput) => void;
};

function makeHost(overrides: HostOverrides = {}): FsmHostCapabilities {
  return {
    session: makeSession(),
    isSubagentTurn: overrides.isSubagentTurn ?? false,
    createId: () => "id",
    gate: { fullPermissionsEnabled: true } as PermissionGateState,
    getCounters: () => ({
      modelIterations: 0,
      turnBillableTokens: 0,
      toolFailureCount: 0,
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
    emitProgress: () => {},
    emitError: () => {},
    ...(overrides.desktopNotify
      ? { desktopNotify: overrides.desktopNotify }
      : {}),
  };
}

function execArgs(options?: {
  host?: FsmHostCapabilities;
  turnInput?: RunAgentTurnInput;
  turnStartedAtMs?: number;
}) {
  return {
    turnContext:
      options?.turnStartedAtMs !== undefined
        ? { turnStartedAtMs: options.turnStartedAtMs }
        : {},
    nodeContext: {},
    ...(options?.host ? { host: options.host } : {}),
    ...(options?.turnInput ? { turnInput: options.turnInput } : {}),
  };
}

const MINUTE = 60_000;

describe("NodeActionNotifyTaskDone", () => {
  it("stub path (no host / no capability) is a silent no-op", async () => {
    const action = new NodeActionNotifyTaskDone({});
    const bare = await action.Exec(execArgs());
    assert.equal(bare.status, "continue");

    const withoutCapability = await action.Exec(
      execArgs({ host: makeHost() }),
    );
    assert.equal(withoutCapability.status, "continue");
  });

  it("skips turns shorter than minElapsedMs", async () => {
    const calls: DesktopNotifyInput[] = [];
    const action = new NodeActionNotifyTaskDone({});
    const result = await action.Exec(
      execArgs({
        host: makeHost({ desktopNotify: (i) => calls.push(i) }),
        turnStartedAtMs: Date.now() - 9 * MINUTE,
      }),
    );
    assert.equal(result.status, "continue");
    assert.equal(calls.length, 0);
    assert.equal(result.turnContextPatch?.taskDoneNotified, undefined);
  });

  it("notifies once for a long turn with default title and session + elapsed", async () => {
    const calls: DesktopNotifyInput[] = [];
    const action = new NodeActionNotifyTaskDone({});
    const result = await action.Exec(
      execArgs({
        host: makeHost({ desktopNotify: (i) => calls.push(i) }),
        turnInput: { session: makeSession(), userText: "go" } as RunAgentTurnInput,
        turnStartedAtMs: Date.now() - 11 * MINUTE,
      }),
    );
    assert.equal(calls.length, 1);
    const notifyCall = calls[0];
    assert.ok(notifyCall);
    assert.equal(notifyCall.title, "Task finished");
    assert.match(notifyCall.body, /Refactor FSM docs · 11m/);
    assert.equal(notifyCall.celebrate, false);
    assert.equal(result.turnContextPatch?.taskDoneNotified, true);
  });

  it("passes celebrate through when the param is checked", async () => {
    const calls: DesktopNotifyInput[] = [];
    const action = new NodeActionNotifyTaskDone({ celebrate: true });
    await action.Exec(
      execArgs({
        host: makeHost({ desktopNotify: (i) => calls.push(i) }),
        turnInput: {
          session: makeSession(),
          userText: "go",
          runMode: "plan",
        } as RunAgentTurnInput,
        turnStartedAtMs: Date.now() - 11 * MINUTE,
      }),
    );
    assert.equal(calls.length, 1);
    const celebrateCall = calls[0];
    assert.ok(celebrateCall);
    assert.equal(celebrateCall.celebrate, true);
  });

  it("honors custom title and body params", async () => {
    const calls: DesktopNotifyInput[] = [];
    const action = new NodeActionNotifyTaskDone({
      title: "Shipped",
      body: "All done",
    });
    await action.Exec(
      execArgs({
        host: makeHost({ desktopNotify: (i) => calls.push(i) }),
        turnStartedAtMs: Date.now() - 11 * MINUTE,
      }),
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.title, "Shipped");
    assert.equal(calls[0]?.body, "All done");
  });

  it("does not filter by runMode or subagent flag inside the Action", async () => {
    const calls: DesktopNotifyInput[] = [];
    const action = new NodeActionNotifyTaskDone({});
    await action.Exec(
      execArgs({
        host: makeHost({
          isSubagentTurn: true,
          desktopNotify: (i) => calls.push(i),
        }),
        turnInput: {
          session: makeSession(),
          userText: "hi",
          runMode: "ask",
          isSubagentTurn: true,
        } as RunAgentTurnInput,
        turnStartedAtMs: Date.now() - 30 * MINUTE,
      }),
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.title, "Task finished");
  });

  it("skips when turnStartedAtMs is absent (control-intent terminal)", async () => {
    const calls: DesktopNotifyInput[] = [];
    const action = new NodeActionNotifyTaskDone({});
    await action.Exec(
      execArgs({ host: makeHost({ desktopNotify: (i) => calls.push(i) }) }),
    );
    assert.equal(calls.length, 0);
  });

  it("honors a custom minElapsedMs param", async () => {
    const calls: DesktopNotifyInput[] = [];
    const action = new NodeActionNotifyTaskDone({ minElapsedMs: 1 });
    await action.Exec(
      execArgs({
        host: makeHost({ desktopNotify: (i) => calls.push(i) }),
        turnStartedAtMs: Date.now() - 50,
      }),
    );
    assert.equal(calls.length, 1);
  });

  it("default threshold is 10 minutes", () => {
    assert.equal(DEFAULT_TASK_DONE_MIN_ELAPSED_MS, 600_000);
  });
});

describe("NodeActionStartTurn turnStartedAtMs", () => {
  it("stamps turnStartedAtMs on the stub path", async () => {
    const before = Date.now();
    const action = new NodeActionStartTurn({});
    const result = await action.Exec({
      turnContext: {},
      nodeContext: {},
    });
    assert.equal(result.status, "continue");
    const stamped = result.turnContextPatch?.turnStartedAtMs;
    assert.equal(typeof stamped, "number");
    assert.ok((stamped as number) >= before);
  });

  it("stamps turnStartedAtMs on the host path", async () => {
    const before = Date.now();
    const session = makeSession();
    const action = new NodeActionStartTurn({});
    const result = await action.Exec({
      turnContext: {
        turnScope: createTurnScope({
          session,
          userText: "go",
          client: { baseUrl: "http://127.0.0.1:9", apiKey: "k", model: "m" },
        } as unknown as RunAgentTurnInput),
      },
      nodeContext: {},
      host: makeHost(),
      turnInput: { session, userText: "go" } as RunAgentTurnInput,
    });
    assert.equal(result.status, "continue");
    const stamped = result.turnContextPatch?.turnStartedAtMs;
    assert.equal(typeof stamped, "number");
    assert.ok((stamped as number) >= before);
  });

  it("leaves turnStartedAtMs unset on discarded / rejected control intent", async () => {
    const action = new NodeActionStartTurn({});
    const result = await action.Exec({
      turnContext: { controlResult: "discarded" },
      nodeContext: {},
    });
    assert.equal(result.turnContextPatch?.turnStartedAtMs, undefined);
  });
});

describe("graph End topology", () => {
  const endActionsOf = (config: ReturnType<typeof createReactGraphConfig>) =>
    config.nodes.find((n) => n.id === "end")?.actions ?? [];

  it("react (Auto) and plan_execute (Plan) hang NotifyTaskDone after FinishIdle with celebrate off", async () => {
    for (const config of [
      createReactGraphConfig(),
      createPlanExecuteV3GraphConfig(),
    ]) {
      const actions = endActionsOf(config);
      const types = actions.map((a) => a.type);
      assert.deepEqual(types.slice(0, 3), [
        "NodeActionFillEmptyAssistant",
        "NodeActionFinishIdle",
        "NodeActionNotifyTaskDone",
      ]);
      const notify = actions.find(
        (a) => a.type === "NodeActionNotifyTaskDone",
      );
      assert.equal(notify?.params?.celebrate, undefined);
    }
  });

  it("ask and subagent Ends stay free of NotifyTaskDone", () => {
    for (const config of [
      createAskGraphConfig(),
      createSubagentGraphConfig(),
    ]) {
      const types = endActionsOf(config).map((a) => a.type);
      assert.equal(types.includes("NodeActionNotifyTaskDone"), false);
    }
  });
});
