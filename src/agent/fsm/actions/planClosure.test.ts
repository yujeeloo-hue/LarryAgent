/**
 * Plan closure — a finished plan must not leave the session on `executing`,
 * or the next Turn resumes the executor instead of routing from scratch.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { StreamChatFn, RunAgentTurnInput } from "../../types.js";
import type { PermissionGateState } from "../../../tools/types.js";
import type {
  Session,
  SessionPlan,
  SessionPlanDoc,
} from "../../../session/types.js";
import {
  getSessionPhase,
  setSessionPhaseInMemory,
  SESSION_PHASE_BLACKBOARD_KEY,
} from "../../../session/sessionPhase.js";
import { PlanFacade } from "../../roles/PlanFacade.js";
import { createTurnState, type RoleKind } from "../../roles/types.js";
import { createUniformRoleLlmBundle } from "../../roles/llmBinding.js";
import type { TurnScope } from "../turnScope.js";
import type { FsmHostCapabilities } from "../FsmHostCapabilities.js";
import { ROUTE_TARGET_REFLECT } from "./NodeActionRouteTo.js";
import { NodeActionApplyToolEffects } from "./NodeActionApplyToolEffects.js";
import { NodeActionCommitStep } from "./NodeActionCommitStep.js";
import type { StepClaimTx } from "./NodeActionDetectStepClaim.js";
import { NodeActionStartTurn } from "./NodeActionStartTurn.js";
import { NodeActionCompleteActivePlan } from "./NodeActionCompleteActivePlan.js";

const PLAN_DOC: SessionPlanDoc = {
  path: "/tmp/ws/docs/plans/x.md",
  summary: "doc",
  updatedAt: 1,
};

function makePlan(steps: SessionPlan["steps"]): SessionPlan {
  const now = Date.now();
  return {
    id: "plan-1",
    title: "T",
    status: "active",
    steps,
    createdAt: now,
    updatedAt: now,
    createToolCallId: "tc0",
  };
}

function makeSession(options: {
  plan: SessionPlan | null;
  phase: Session["phase"];
}): Session {
  const now = Date.now();
  const phase = options.phase ?? null;
  return {
    id: "plan-closure-sess",
    type: "agent",
    title: "Plan closure",
    createdAt: now,
    updatedAt: now,
    status: "running",
    progressText: "",
    messages: [],
    model: "mock-model",
    providerId: "mock",
    workspaceId: "ws1",
    workspacePath: "/tmp/ws",
    pinned: false,
    archived: false,
    archivedAt: null,
    contextUsage: { usedTokens: 0 },
    plan: options.plan,
    planDoc: PLAN_DOC,
    phase,
    fsmBlackboard: phase
      ? { [SESSION_PHASE_BLACKBOARD_KEY]: phase }
      : null,
  } as Session;
}

function makeScope(session: Session, activeRole: RoleKind): TurnScope {
  return {
    plan: new PlanFacade(session),
    turnState: createTurnState({ activeRole }),
    llmBundle: createUniformRoleLlmBundle({
      providerId: "mock",
      client: { baseUrl: "http://127.0.0.1:9", apiKey: "k", model: "m" },
      stream: (async function* () {}) as unknown as StreamChatFn,
    }),
  };
}

function makeHost(session: Session): FsmHostCapabilities {
  return {
    session,
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
    applySessionPatch: (patch) => {
      if ("plan" in patch) session.plan = patch.plan ?? null;
      if ("planDoc" in patch) session.planDoc = patch.planDoc ?? null;
      if ("phase" in patch) setSessionPhaseInMemory(session, patch.phase ?? null);
    },
    blackboardGet: (key) => session.fsmBlackboard?.[key],
    blackboardSet: (key, value) => {
      const next: Record<string, unknown> = { ...(session.fsmBlackboard ?? {}) };
      if (value === null || value === undefined) delete next[key];
      else next[key] = value;
      session.fsmBlackboard = Object.keys(next).length > 0 ? next : null;
      if (key === SESSION_PHASE_BLACKBOARD_KEY) {
        session.phase =
          typeof value === "string" && value.trim() ? value.trim() : null;
      }
      return { ok: true as const };
    },
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
  };
}

function passingTx(stepIds: string[]): StepClaimTx {
  return {
    pendingStepIds: stepIds,
    verifyResult: "pass",
    verifiedStepIds: stepIds,
    failedStepId: null,
    waitingOn: [],
  };
}

describe("NodeActionCommitStep plan closure", () => {
  it("closes plan / doc / phase when the last group commits", () => {
    const session = makeSession({
      plan: makePlan([
        { id: "s1", title: "A", status: "completed" },
        { id: "s2", title: "B", status: "completed" },
      ]),
      phase: "executing",
    });
    const scope = makeScope(session, "executor");

    const result = new NodeActionCommitStep({
      onResume: "executor",
      onReflect: ROUTE_TARGET_REFLECT,
    }).Exec({
      turnContext: { turnScope: scope, stepClaimTx: passingTx(["s2"]) },
      nodeContext: {},
      host: makeHost(session),
    });

    assert.equal(result.nodeContextPatch?.routeTarget, ROUTE_TARGET_REFLECT);
    assert.equal(session.plan?.status, "completed");
    assert.equal(getSessionPhase(session), null);
    assert.equal(session.planDoc, null);
  });

  it("keeps the plan open while steps remain", () => {
    const session = makeSession({
      plan: makePlan([
        { id: "s1", title: "A", status: "completed" },
        { id: "s2", title: "B", status: "in_progress" },
      ]),
      phase: "executing",
    });
    const scope = makeScope(session, "executor");

    const result = new NodeActionCommitStep({
      onResume: "executor",
      onReflect: ROUTE_TARGET_REFLECT,
    }).Exec({
      turnContext: { turnScope: scope, stepClaimTx: passingTx(["s1"]) },
      nodeContext: {},
      host: makeHost(session),
    });

    assert.equal(result.nodeContextPatch?.routeTarget, "executor");
    assert.equal(session.plan?.status, "active");
    assert.equal(getSessionPhase(session), "executing");
    assert.equal(session.planDoc?.path, PLAN_DOC.path);
  });
});

describe("NodeActionApplyToolEffects card visibility", () => {
  it("syncs session.plan.cardVisible from turnContext.planCardVisible", () => {
    const session = makeSession({
      plan: { ...makePlan([{ id: "s1", title: "A", status: "pending" }]), cardVisible: false },
      phase: null,
    });

    new NodeActionApplyToolEffects({}).Exec({
      turnContext: {
        turnScope: makeScope(session, "planner"),
        planCardVisible: true,
      },
      nodeContext: {},
      host: makeHost(session),
    });

    assert.equal(session.plan?.cardVisible, true);
  });
});

describe("NodeActionStartTurn", () => {
  const turnInput = (session: Session) =>
    ({ session, userText: "next task" }) as RunAgentTurnInput;

  it("does not seed routeTarget (routing is RouteTo's job)", async () => {
    const session = makeSession({
      plan: makePlan([{ id: "s1", title: "A", status: "completed" }]),
      phase: "executing",
    });

    const result = await new NodeActionStartTurn({}).Exec({
      turnContext: { turnScope: makeScope(session, "analyser") },
      nodeContext: {},
      host: makeHost(session),
      turnInput: turnInput(session),
    });

    assert.equal(result.nodeContextPatch?.activeRole, "agent");
    assert.equal(result.nodeContextPatch?.routeTarget, undefined);
    assert.equal(getSessionPhase(session), "executing");
  });

  it("uses approvedUserText from turnContext on approve", async () => {
    const session = makeSession({ phase: "review", plan: null });
    let submitted = "";
    const host = {
      ...makeHost(session),
      startTurn: async (input: { userText: string }) => {
        submitted = input.userText;
        return "ok" as const;
      },
    };

    await new NodeActionStartTurn({}).Exec({
      turnContext: {
        turnScope: makeScope(session, "planner"),
        controlResult: "approved",
        approvedUserText: "Go plan.",
      },
      nodeContext: { activeRole: "planner", routeTarget: "planner" },
      host,
      turnInput: turnInput(session),
    });

    assert.equal(submitted, "Go plan.");
  });
});

describe("NodeActionCompleteActivePlan whenPhaseUnset", () => {
  it("closes a Direct leftover plan when phase is unset", () => {
    const session = makeSession({
      plan: makePlan([{ id: "s1", title: "A", status: "pending" }]),
      phase: null,
    });
    new NodeActionCompleteActivePlan({ whenPhaseUnset: true }).Exec({
      turnContext: { turnScope: makeScope(session, "agent") },
      nodeContext: {},
      host: makeHost(session),
    });
    assert.equal(session.plan?.status, "completed");
  });

  it("does not close an executor plan while phase is executing", () => {
    const session = makeSession({
      plan: makePlan([{ id: "s1", title: "A", status: "pending" }]),
      phase: "executing",
    });
    const result = new NodeActionCompleteActivePlan({
      whenPhaseUnset: true,
    }).Exec({
      turnContext: { turnScope: makeScope(session, "executor") },
      nodeContext: {},
      host: makeHost(session),
    });
    assert.equal(session.plan?.status, "active");
    assert.equal(result.nodeContextPatch?.completeActivePlanSkipped, "phase_set");
  });
});
