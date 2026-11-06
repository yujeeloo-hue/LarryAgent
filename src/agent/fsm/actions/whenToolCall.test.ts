/**
 * NodeActionWhenToolCall + NodeActionSetComposerRunMode — the generic
 * primitives behind Plan-mode auto-exit. Behavior: WhenToolCall flags the
 * node when this round's tool calls match (name / arg / success);
 * SetComposerRunMode requests a composer mode switch through the host port.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PermissionGateState } from "../../../tools/types.js";
import type {
  JsonObject,
  Session,
  ToolCallPart,
} from "../../../session/types.js";
import type { FsmHostCapabilities } from "../FsmHostCapabilities.js";
import {
  NodeActionSetComposerRunMode,
} from "./NodeActionSetComposerRunMode.js";
import { NodeActionWhenToolCall } from "./NodeActionWhenToolCall.js";
import {
  createPlanExecuteV3GraphConfig,
  createReactGraphConfig,
} from "../configs/sampleGraphs.js";

function makeSession(
  messages: Session["messages"] = [],
): Session {
  const now = Date.now();
  return {
    id: "when-tool-call-test",
    type: "agent",
    title: "t",
    createdAt: now,
    updatedAt: now,
    status: "running",
    progressText: "",
    messages,
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
  messages?: Session["messages"];
  requestComposerRunMode?: (mode: "agent" | "ask" | "plan") => void;
};

function makeHost(overrides: HostOverrides = {}): FsmHostCapabilities {
  return {
    session: makeSession(overrides.messages),
    isSubagentTurn: false,
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
    ...(overrides.requestComposerRunMode
      ? { requestComposerRunMode: overrides.requestComposerRunMode }
      : {}),
  };
}

function call(name: string, args: JsonObject, id: string): ToolCallPart {
  return {
    type: "tool_call",
    id,
    name,
    status: "done",
    arguments: args,
    argumentsRaw: JSON.stringify(args),
  };
}

function toolMessage(
  parts: Array<Record<string, unknown>>,
): Session["messages"][number] {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    role: "tool",
    toolCallId: "c1",
    createdAt: Date.now(),
    parts: parts as never,
  };
}

function execArgs(options?: {
  host?: FsmHostCapabilities;
  toolCalls?: ToolCallPart[];
}) {
  return {
    turnContext: {},
    nodeContext: {
      ...(options?.toolCalls ? { toolCalls: options.toolCalls } : {}),
    },
    ...(options?.host ? { host: options.host } : {}),
  };
}

const COMPLETE_PARAMS = {
  toolName: "complete_plan",
  argKey: "status",
  argEquals: "completed",
  requireSuccess: true,
  flagKey: "planCompletedThisRound",
};

describe("NodeActionWhenToolCall", () => {
  it("flags on matching name + arg + successful result", () => {
    const action = new NodeActionWhenToolCall(COMPLETE_PARAMS);
    const result = action.Exec(
      execArgs({
        host: makeHost({
          messages: [
            toolMessage([
              {
                type: "tool_result",
                toolCallId: "c1",
                returnCode: 0,
                content: [],
              },
            ]),
          ],
        }),
        toolCalls: [call("update_plan", {}, "c0"), call("complete_plan", { status: "completed" }, "c1")],
      }),
    );
    assert.equal(result.status, "continue");
    assert.deepEqual(result.nodeContextPatch, {
      planCompletedThisRound: true,
    });
  });

  it("no flag when the failed result has returnCode !== 0", () => {
    const action = new NodeActionWhenToolCall(COMPLETE_PARAMS);
    const result = action.Exec(
      execArgs({
        host: makeHost({
          messages: [
            toolMessage([
              {
                type: "tool_result",
                toolCallId: "c1",
                returnCode: 2,
                content: [],
              },
            ]),
          ],
        }),
        toolCalls: [call("complete_plan", { status: "completed" }, "c1")],
      }),
    );
    assert.equal(result.status, "continue");
    assert.equal(result.nodeContextPatch, undefined);
  });

  it("no flag when the argument value differs", () => {
    const action = new NodeActionWhenToolCall(COMPLETE_PARAMS);
    const result = action.Exec(
      execArgs({
        host: makeHost({
          messages: [
            toolMessage([
              {
                type: "tool_result",
                toolCallId: "c1",
                returnCode: 0,
                content: [],
              },
            ]),
          ],
        }),
        toolCalls: [call("complete_plan", { status: "cancelled" }, "c1")],
      }),
    );
    assert.equal(result.status, "continue");
    assert.equal(result.nodeContextPatch, undefined);
  });

  it("requireSuccess never matches without a host (stub path)", () => {
    const action = new NodeActionWhenToolCall(COMPLETE_PARAMS);
    const result = action.Exec(
      execArgs({
        toolCalls: [call("complete_plan", { status: "completed" }, "c1")],
      }),
    );
    assert.equal(result.status, "continue");
    assert.equal(result.nodeContextPatch, undefined);
  });

  it("name-only filter still matches on the stub path", () => {
    const action = new NodeActionWhenToolCall({
      toolName: "complete_plan",
      flagKey: "sawComplete",
    });
    const result = action.Exec(
      execArgs({
        toolCalls: [call("complete_plan", { status: "cancelled" }, "c1")],
      }),
    );
    assert.deepEqual(result.nodeContextPatch, { sawComplete: true });
  });

  it("halts on missing toolName / flagKey", () => {
    const action = new NodeActionWhenToolCall({ toolName: "" });
    const result = action.Exec(execArgs({ toolCalls: [] }));
    assert.equal(result.status, "halt");
    assert.ok(result.errorMessage);
  });
});

describe("NodeActionSetComposerRunMode", () => {
  it("requests the switch when the node flag is true", () => {
    const requested: string[] = [];
    const action = new NodeActionSetComposerRunMode({
      mode: "agent",
      whenNodeFlag: "planCompletedThisRound",
    });
    const result = action.Exec({
      turnContext: {},
      nodeContext: { planCompletedThisRound: true },
      host: makeHost({
        requestComposerRunMode: (mode) => requested.push(mode),
      }),
    });
    assert.equal(result.status, "continue");
    assert.deepEqual(requested, ["agent"]);
    assert.deepEqual(result.nodeContextPatch, {
      composerRunModeRequested: "agent",
    });
  });

  it("no-op when the node flag is false", () => {
    const requested: string[] = [];
    const action = new NodeActionSetComposerRunMode({
      mode: "agent",
      whenNodeFlag: "planCompletedThisRound",
    });
    const result = action.Exec({
      turnContext: {},
      nodeContext: {},
      host: makeHost({
        requestComposerRunMode: (mode) => requested.push(mode),
      }),
    });
    assert.equal(result.status, "continue");
    assert.equal(requested.length, 0);
    assert.equal(result.nodeContextPatch, undefined);
  });

  it("requests unconditionally without whenNodeFlag", () => {
    const requested: string[] = [];
    const action = new NodeActionSetComposerRunMode({ mode: "ask" });
    const result = action.Exec({
      turnContext: {},
      nodeContext: {},
      host: makeHost({
        requestComposerRunMode: (mode) => requested.push(mode),
      }),
    });
    assert.deepEqual(requested, ["ask"]);
    assert.deepEqual(result.nodeContextPatch, {
      composerRunModeRequested: "ask",
    });
  });

  it("stub path (no host / no capability) is a silent no-op", () => {
    const action = new NodeActionSetComposerRunMode({ mode: "agent" });
    const bare = action.Exec({ turnContext: {}, nodeContext: {} });
    assert.equal(bare.status, "continue");

    const withoutCapability = action.Exec({
      turnContext: {},
      nodeContext: {},
      host: makeHost(),
    });
    assert.equal(withoutCapability.status, "continue");
  });

  it("halts on an invalid mode", () => {
    const action = new NodeActionSetComposerRunMode({ mode: "custom" });
    const result = action.Exec({
      turnContext: {},
      nodeContext: {},
      host: makeHost({
        requestComposerRunMode: () => {},
      }),
    });
    assert.equal(result.status, "halt");
    assert.ok(result.errorMessage);
  });
});

describe("plan_execute executor mounts the auto-exit pair", () => {
  it("executor carries WhenToolCall(complete_plan) + SetComposerRunMode(agent); only plan_done also switches", () => {
    const config = createPlanExecuteV3GraphConfig();
    for (const node of config.nodes) {
      const types = (node.actions ?? []).map((a) => a.type);
      const isExecutor = node.id === "executor";
      assert.equal(
        types.includes("NodeActionWhenToolCall"),
        isExecutor,
        `${node.id} WhenToolCall`,
      );
      if (node.id === "plan_done") {
        // Normal finish: CommitStep closed the plan — unconditional switch.
        const set = node.actions!.find(
          (a) => a.type === "NodeActionSetComposerRunMode",
        );
        assert.equal(set?.params?.mode, "agent");
        assert.equal(set?.params?.whenNodeFlag, undefined);
        continue;
      }
      assert.equal(
        types.includes("NodeActionSetComposerRunMode"),
        isExecutor,
        `${node.id} SetComposerRunMode`,
      );
      if (isExecutor) {
        const when = node.actions!.find(
          (a) => a.type === "NodeActionWhenToolCall",
        )!;
        assert.equal(when.params?.toolName, "complete_plan");
        assert.equal(when.params?.argKey, "status");
        assert.equal(when.params?.argEquals, "completed");
        assert.equal(when.params?.requireSuccess, true);
        const set = node.actions!.find(
          (a) => a.type === "NodeActionSetComposerRunMode",
        )!;
        assert.equal(set.params?.mode, "agent");
        assert.equal(set.params?.whenNodeFlag, when.params?.flagKey);
        // The pair sits after the tools phase (Run tools) so the round
        // container is populated when it runs.
        const runToolsAt = types.indexOf("NodeActionRunTools");
        const whenAt = types.indexOf("NodeActionWhenToolCall");
        assert.ok(runToolsAt >= 0 && whenAt > runToolsAt);
      }
    }
  });

  it("react (Auto) graph stays free of both primitives", () => {
    const config = createReactGraphConfig();
    for (const node of config.nodes) {
      const types = (node.actions ?? []).map((a) => a.type);
      assert.equal(types.includes("NodeActionWhenToolCall"), false, node.id);
      assert.equal(
        types.includes("NodeActionSetComposerRunMode"),
        false,
        node.id,
      );
    }
  });
});
