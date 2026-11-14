/**
 * plan_execute V3 — self-looping role nodes, zero control nodes.
 * Topology invariants + hostless stub runs + fake-host behavior runs.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { StreamChatFn, RunAgentTurnInput } from "../types.js";
import type { PermissionGateState } from "../../tools/types.js";
import type {
  AssistantMessage,
  MessagePart,
  Session,
  SessionPlan,
  SessionPlanDoc,
  ToolCallPart,
} from "../../session/types.js";
import { PlanFacade } from "../roles/PlanFacade.js";
import { createTurnState, type RoleKind } from "../roles/types.js";
import { createUniformRoleLlmBundle } from "../roles/llmBinding.js";
import type { TurnScope } from "./turnScope.js";
import type { FsmHostCapabilities } from "./FsmHostCapabilities.js";
import type { TurnHostCounters } from "../turnHost/types.js";
import { createDefaultActionRegistry } from "./actions/createDefaultActionRegistry.js";
import { legacyWhenRowToExpr } from "./actions/routeWhenExpr.js";
import { createPlanExecuteV3GraphConfig } from "./configs/sampleGraphs.js";
import { FSMGraph } from "./FSMGraph.js";
import {
  ROUTE_TARGET_REFLECT,
  ROUTE_TARGET_REFLECT_DONE,
} from "./actions/NodeActionRouteTo.js";

const V3_ROLES: RoleKind[] = [
  "analyser",
  "planner",
  "plan_writer",
  "plan_reviewer",
  "executor",
  "replanner",
  "agent",
];

/** Role → cross-role moves the domain router can pick (mirrors domain/*.ts). */
const EXPECTED_TRANSITIONS: Record<string, string[]> = {
  analyser: ["agent", "plan_writer", "plan_reviewer"],
  planner: ["executor"],
  plan_writer: ["plan_reviewer"],
  plan_reviewer: ["plan_writer", "planner"],
  executor: ["replanner"],
  replanner: ["executor"],
  agent: [],
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSession(options?: {
  plan?: SessionPlan | null;
  planDoc?: SessionPlanDoc | null;
  phase?: string | null;
}): Session {
  const now = Date.now();
  return {
    id: "v3-test-sess",
    type: "agent",
    title: "V3 test",
    createdAt: now,
    updatedAt: now,
    status: "idle",
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
    plan: options?.plan ?? null,
    planDoc: options?.planDoc ?? null,
    phase: (options?.phase ?? null) as Session["phase"],
    fsmBlackboard: options?.phase
      ? { phase: options.phase }
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

function makeTurnInput(
  session: Session,
  extra?: Record<string, unknown>,
): RunAgentTurnInput {
  return { session, userText: "test", ...extra } as RunAgentTurnInput;
}

function makeToolCall(
  id: string,
  name: string,
  args: Record<string, unknown>,
): ToolCallPart {
  return {
    type: "tool_call",
    id,
    name,
    status: "done",
    arguments: args as ToolCallPart["arguments"],
    argumentsRaw: JSON.stringify(args),
  };
}

type ScriptedRound = { toolCalls?: ToolCallPart[]; text?: string };

type FakeHostOptions = {
  session: Session;
  rounds: ScriptedRound[];
  counters?: Partial<TurnHostCounters>;
  /** checkAbort starts returning true after this many false checks. */
  abortAfter?: number;
};

function makeFakeHost(options: FakeHostOptions): {
  host: FsmHostCapabilities;
  events: string[];
} {
  const counters: TurnHostCounters = {
    modelIterations: 0,
    turnBillableTokens: 0,
    toolFailureCount: 0,
    turnModelIterations: 0,
    toolErrorCount: 0,
    toolRecoveryCount: 0,
    skillsReadCount: 0,
    ...options.counters,
  };
  const events: string[] = [];
  let roundIndex = 0;
  let abortChecks = 0;
  let idSeq = 0;

  const host: FsmHostCapabilities = {
    session: options.session,
    isSubagentTurn: false,
    createId: () => `id-${++idSeq}`,
    gate: { fullPermissionsEnabled: true } as PermissionGateState,
    getCounters: () => ({ ...counters }),
    setCounters: (next) => void Object.assign(counters, next),
    resetTurnBudgets: () => {},
    applySessionPatch: (patch) => {
      if ("plan" in patch) options.session.plan = patch.plan ?? null;
      if ("planDoc" in patch) options.session.planDoc = patch.planDoc ?? null;
      if ("phase" in patch) {
        const phase = patch.phase ?? null;
        options.session.phase = phase;
        const next = { ...(options.session.fsmBlackboard ?? {}) };
        if (phase === null) delete next.phase;
        else next.phase = phase;
        options.session.fsmBlackboard =
          Object.keys(next).length > 0 ? next : null;
      }
    },
    blackboardGet: (key) => options.session.fsmBlackboard?.[key],
    blackboardSet: (key, value) => {
      const next: Record<string, unknown> = {
        ...(options.session.fsmBlackboard ?? {}),
      };
      if (value === null || value === undefined) delete next[key];
      else next[key] = value;
      options.session.fsmBlackboard =
        Object.keys(next).length > 0 ? next : null;
      if (key === "phase") {
        options.session.phase =
          typeof value === "string" && value.trim() ? value.trim() : null;
      }
      return { ok: true as const };
    },
    planDocExists: () => true,
    deletePlanDoc: () => {},
    startTurn: async () => "ok" as const,
    checkAbort: () => {
      abortChecks += 1;
      return options.abortAfter !== undefined && abortChecks > options.abortAfter;
    },
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
      counters.modelIterations += 1;
      const round = options.rounds[roundIndex++] ?? {};
      const parts: MessagePart[] = [];
      if (round.text) parts.push({ type: "text", text: round.text });
      for (const call of round.toolCalls ?? []) parts.push(call);
      const assistant: AssistantMessage = {
        id: `a-${++idSeq}`,
        role: "assistant",
        parts,
        createdAt: Date.now(),
      };
      return {
        kind: "ok",
        assistant,
        toolCalls: round.toolCalls ?? [],
        ...(round.text
          ? { textPart: { type: "text", text: round.text } }
          : {}),
        reasoningBuf: "",
        roundBillableTokens: 0,
      };
    },
    runToolsPhase: async (_assistant, toolCalls) => {
      events.push(`tools:${toolCalls.map((c) => c.name).join(",")}`);
      const routeEvents: import("../contracts/index.js").RouteEventPatch[] = [];
      for (const call of toolCalls) {
        if (call.name === "update_plan" && call.status === "done") {
          const { updatePlanHandler } = await import(
            "../../tools/builtin/updatePlan.js"
          );
          const result = await updatePlanHandler(call.arguments, {
              workspacePath: options.session.workspacePath ?? "/tmp/ws",
              fullPermissionsEnabled: true,
              planSnapshot: options.session.plan ?? null,
              planDocSnapshot: options.session.planDoc ?? null,
            },
          );
          if (result.sessionPatch) {
            host.applySessionPatch(result.sessionPatch);
          }
          if (result.routeEvent) routeEvents.push(result.routeEvent);
        }
        if (call.name === "fsm_route" && call.status === "done") {
          const { fsmRouteHandler } = await import(
            "../../tools/builtin/fsmRoute.js"
          );
          const result = await fsmRouteHandler(call.arguments, {
            workspacePath: options.session.workspacePath ?? "/tmp/ws",
            fullPermissionsEnabled: true,
            planSnapshot: options.session.plan ?? null,
            planDocSnapshot: options.session.planDoc ?? null,
          });
          if (result.sessionPatch) {
            host.applySessionPatch(result.sessionPatch);
          }
          if (result.routeEvent) routeEvents.push(result.routeEvent);
        }
        if (call.name === "write_plan_doc" && call.status === "done") {
          const args = call.arguments as {
            path?: unknown;
            summary?: unknown;
          };
          if (typeof args.path === "string" && args.path.trim()) {
            options.session.planDoc = {
              path: args.path.trim(),
              summary:
                typeof args.summary === "string" ? args.summary : "",
              updatedAt: Date.now(),
            };
            routeEvents.push({ event: "doc_written", source: "tool" });
          }
        }
        if (call.name === "create_plan" && call.status === "done") {
          const { createPlanHandler } = await import(
            "../../tools/builtin/createPlan.js"
          );
          const result = await createPlanHandler(call.arguments, {
            workspacePath: options.session.workspacePath ?? "/tmp/ws",
            fullPermissionsEnabled: true,
            planSnapshot: options.session.plan ?? null,
            planDocSnapshot: options.session.planDoc ?? null,
          });
          if (result.sessionPatch) {
            host.applySessionPatch(result.sessionPatch);
          }
          if (result.routeEvent) routeEvents.push(result.routeEvent);
        }
        if (call.name === "report_step_blocked" && call.status === "done") {
          routeEvents.push({ event: "step_blocked", source: "tool" });
        }
      }
      return {
        kind: "ok",
        cancelled: false,
        toolFailureCount: 0,
        routeEvents,
      };
    },
    awaitSubagentBatches: async () => "none",
    finalizeEmptyAssistant: () => {},
    finish: async (status) => {
      events.push(`finish:${status}`);
      options.session.status = status;
      return { status, modelIterations: counters.modelIterations };
    },
    emitProgress: (text) => void events.push(`progress:${text}`),
    onEvent: (event) => void events.push(`onEvent:${event.type}:${"text" in event ? event.text : ""}`),
    emitError: (message) => void events.push(`error:${message}`),
  };
  return { host, events };
}

// ---------------------------------------------------------------------------
// Topology invariants
// ---------------------------------------------------------------------------

describe("plan_execute v3 topology", () => {
  const config = createPlanExecuteV3GraphConfig();

  it("collapses skill reflect into gate + reflector nodes", () => {
    const reflectIds = config.nodes
      .map((n) => n.id)
      .filter((id) => id.startsWith("skill_reflect"));
    assert.deepEqual(reflectIds, ["skill_reflect_gate", "skill_reflector"]);
  });

  it("keeps start / execution_validator / end plus the seven roles", () => {
    const ids = new Set(config.nodes.map((n) => n.id));
    for (const required of [
      "start",
      "execution_validator",
      "plan_done",
      "end",
      ...V3_ROLES,
      "skill_reflect_gate",
      "skill_reflector",
    ]) {
      assert.ok(ids.has(required), `node "${required}" missing`);
    }
    assert.equal(config.nodes.length, 13);
    assert.equal(config.entryNodeId, "start");
    assert.equal(config.terminalNodeId, "end");
  });

  it("start resumes by Compare + RouteTo when-table on session blackboard phase", () => {
    const start = config.nodes.find((n) => n.id === "start");
    const control = start?.actions?.find(
      (a) => a.type === "NodeActionApplyControlIntent",
    );
    assert.equal(
      (control?.params as { approveRequirePhase?: string }).approveRequirePhase,
      "review",
    );
    assert.equal(
      (control?.params as { approveSetPhase?: string }).approveSetPhase,
      "planning",
    );
    assert.equal(
      (control?.params as { approveRequirePlanDoc?: boolean })
        .approveRequirePlanDoc,
      true,
    );

    const startTurn = start?.actions?.find(
      (a) => a.type === "NodeActionStartTurn",
    );
    assert.deepEqual(startTurn?.params, {});

    const controlParams = control?.params as {
      approvedUserText?: string;
    };
    assert.ok(
      typeof controlParams.approvedUserText === "string" &&
        controlParams.approvedUserText.length > 0,
    );

    const resumeRoute = (start?.actions ?? []).find(
      (a) =>
        a.type === "NodeActionRouteTo" &&
        Array.isArray((a.params as { when?: unknown })?.when),
    );
    assert.ok(resumeRoute);
    const rp = resumeRoute.params as {
      when: Array<{ expr?: string; key?: string; allOf?: string[]; to?: string }>;
      onlyIfRouteTargetUnset?: boolean;
      defaultPin?: string;
    };
    assert.equal(rp.onlyIfRouteTargetUnset, true);
    assert.equal(rp.defaultPin, "analyser");
    const phaseRoutes = rp.when.map((row) => {
      const expr = legacyWhenRowToExpr(row);
      const parts = expr
        .split(/\s*&&\s*/)
        .map((s) => s.trim())
        .filter(Boolean);
      const phase = parts
        .find((f) => f.startsWith("resume.phase."))
        ?.slice("resume.phase.".length);
      return {
        phase,
        pin: row.to,
        incomplete: parts.some((f) => f.startsWith("resume.planOpen.")),
      };
    });
    assert.deepEqual(phaseRoutes, [
      { phase: "executing", pin: "executor", incomplete: true },
      { phase: "planning", pin: "planner", incomplete: false },
      { phase: "drafting", pin: "plan_writer", incomplete: false },
      { phase: undefined, pin: "planner", incomplete: false },
      { phase: undefined, pin: "plan_reviewer", incomplete: false },
    ]);
    assert.equal(
      (start?.actions ?? []).filter(
        (a) =>
          a.type === "NodeActionRouteTo" &&
          Array.isArray((a.params as { when?: unknown })?.when),
      ).length,
      1,
    );
    assert.equal(
      config.edges.filter(
        (e) =>
          e.from === "start" &&
          (e.params as { source?: string }).source === "session",
      ).length,
      0,
    );
  });

  it("executor overlay includes the live plan frontier", () => {
    const executor = config.nodes.find((n) => n.id === "executor");
    const injectSources = (executor?.actions ?? [])
      .filter((a) => a.type === "NodeActionPromptInject")
      .map((a) => (a.params as { source?: string }).source);
    assert.ok(injectSources.includes("plan"));
    assert.ok(injectSources.includes("planDoc"));
  });

  it("every role self-loops and owns its tool phase (gate → stream → tools → RouteTo)", () => {
    for (const role of V3_ROLES) {
      const node = config.nodes.find((n) => n.id === role);
      assert.ok(node);
      assert.equal(
        node.selfLoop,
        true,
        `role "${role}" must self-loop via the node selfLoop flag`,
      );
      const actionTypes = (node.actions ?? []).map((a) => a.type);
      for (const required of [
        "NodeActionRoundGate",
        "NodeActionPrepareRole",
        "NodeActionPrepareTools",
        "NodeActionBuildModelWindow",
        "NodeActionCallModel",
        "NodeActionRunTools",
        "NodeActionApplyToolEffects",
        "NodeActionEmitRouteEvent",
        "NodeActionAwaitSubagents",
        "NodeActionRouteTo",
      ]) {
        assert.ok(
          actionTypes.includes(required),
          `role "${role}" missing ${required}`,
        );
      }
      const routeAfter = (node.actions ?? []).find(
        (a) => a.type === "NodeActionRouteTo",
      );
      assert.ok(routeAfter?.params && typeof routeAfter.params === "object");
      assert.ok(
        (routeAfter!.params as { routes?: unknown }).routes,
        `role "${role}" RouteTo must have routes`,
      );
      const stream = (node.actions ?? []).find(
        (a) => a.type === "NodeActionCallModel",
      );
      assert.ok(stream, `role "${role}" must stream`);
      assert.equal(
        (stream?.params as { routing?: string } | undefined)?.routing,
        undefined,
        `role "${role}" stream must not carry a routing param`,
      );
    }
  });

  it("entry WriteBlackboard phase / dedicated plan Actions only on roles that need them", () => {
    const actionsOf = (id: string) =>
      config.nodes.find((n) => n.id === id)?.actions ?? [];
    const typesOf = (id: string) => actionsOf(id).map((a) => a.type);
    const hasType = (id: string, type: string) => typesOf(id).includes(type);
    const phaseWrite = (id: string) =>
      actionsOf(id).find(
        (a) =>
          a.type === "NodeActionWriteBlackboard" &&
          (a.params as { key?: string }).key === "phase" &&
          (a.params as { scope?: string }).scope === "session",
      );

    assert.ok(phaseWrite("analyser"));
    assert.equal(
      (phaseWrite("analyser")?.params as { value?: string }).value,
      "gathering",
    );
    assert.equal(hasType("analyser", "NodeActionCompleteActivePlan"), false);

    assert.ok(phaseWrite("plan_writer"));
    assert.ok(hasType("plan_writer", "NodeActionCompleteActivePlan"));
    assert.ok(hasType("plan_writer", "NodeActionSetPlanApprovalPending"));

    assert.ok(phaseWrite("plan_reviewer"));
    assert.ok(hasType("plan_reviewer", "NodeActionClearPlanDraft"));

    assert.ok(hasType("planner", "NodeActionSetPlanApprovalPending"));
    assert.ok(phaseWrite("planner"));
    assert.ok(hasType("planner", "NodeActionCheckPlan"));
    assert.equal(
      (phaseWrite("planner")?.params as { value?: string }).value,
      "planning",
    );

    assert.ok(phaseWrite("executor"));
    assert.equal(
      (phaseWrite("executor")?.params as { value?: string }).value,
      "executing",
    );

    assert.equal(phaseWrite("replanner"), undefined);
    assert.ok(hasType("replanner", "NodeActionWriteBlackboard"));
    assert.ok(hasType("replanner", "NodeActionCheckPlan"));
    assert.equal(hasType("analyser", "NodeActionCheckPlan"), false);
    assert.equal(hasType("executor", "NodeActionCheckPlan"), false);

    assert.ok(phaseWrite("agent"));
    assert.equal((phaseWrite("agent")?.params as { value?: unknown }).value, null);
    assert.equal(hasType("agent", "NodeActionCompleteActivePlan"), false);

    const gateTypes = typesOf("skill_reflect_gate");
    assert.ok(gateTypes.includes("NodeActionCompleteActivePlan"));
    const gateComplete = actionsOf("skill_reflect_gate").find(
      (a) => a.type === "NodeActionCompleteActivePlan",
    );
    assert.equal(
      (gateComplete?.params as { whenPhaseUnset?: boolean } | undefined)
        ?.whenPhaseUnset,
      true,
    );

    // Control / reflect / end nodes stay free of plan entry Actions
    // (skill_reflect_gate is the Direct leftover closer, not a role entry).
    for (const id of ["start", "end", "skill_reflector", "execution_validator"]) {
      const types = typesOf(id);
      assert.equal(types.includes("NodeActionSetPhase"), false, id);
      assert.equal(types.includes("NodeActionCompleteActivePlan"), false, id);
      assert.equal(types.includes("NodeActionClearPlanDraft"), false, id);
    }
    assert.equal(typesOf("skill_reflect_gate").includes("NodeActionSetPhase"), false);
    assert.equal(typesOf("skill_reflect_gate").includes("NodeActionClearPlanDraft"), false);
    assert.equal(
      gateTypes.filter((t) => t === "NodeActionCompare").length,
      6,
    );
    const gateAutoCompare = actionsOf("skill_reflect_gate").find(
      (a) =>
        a.type === "NodeActionCompare" &&
        (a.params as { source?: string })?.source === "autoSkillSummarize",
    );
    assert.ok(gateAutoCompare);
    assert.ok(gateTypes.includes("NodeActionRouteTo"));
    assert.equal(gateTypes.includes("NodeActionSkillReflectGate"), false);
  });

  it("SetPlanCard only on planner (extraBeforeStream)", () => {
    const typesOf = (id: string) =>
      (config.nodes.find((n) => n.id === id)?.actions ?? []).map((a) => a.type);
    assert.ok(typesOf("planner").includes("NodeActionSetPlanCard"));
    for (const id of V3_ROLES.filter((r) => r !== "planner")) {
      assert.equal(
        typesOf(id).includes("NodeActionSetPlanCard"),
        false,
        `${id} must not SetPlanCard`,
      );
    }
  });

  it("only executor carries DetectStepClaim → execution_validator; cross-role edges mirror transitions", () => {
    for (const role of V3_ROLES) {
      const node = config.nodes.find((n) => n.id === role);
      const hasClaim = (node?.actions ?? []).some(
        (a) => a.type === "NodeActionDetectStepClaim",
      );
      assert.equal(hasClaim, role === "executor", `DetectStepClaim on ${role}`);

      const targets = config.edges
        .filter(
          (e) =>
            e.from === role &&
            e.type === "EdgeWhen" &&
            (e.params as { turnKey?: string })?.turnKey === "routeTarget",
        )
        .map((e) => e.to)
        .sort();
      const expected = [
        ...EXPECTED_TRANSITIONS[role]!,
        "skill_reflect_gate",
        ...(role === "executor" ? ["execution_validator"] : []),
      ].sort();
      assert.deepEqual(
        targets,
        expected,
        `routeTarget edges from ${role}`,
      );

      const reflectEdge = config.edges.find(
        (e) =>
          e.from === role &&
          e.to === "skill_reflect_gate" &&
          (e.params as { equals?: unknown })?.equals ===
            ROUTE_TARGET_REFLECT,
      );
      assert.ok(reflectEdge, `role "${role}" missing reflect edge`);
    }
  });

  it("Direct agent is restricted to read-only Q&A", () => {
    const node = config.nodes.find((n) => n.id === "agent");
    const disable = (node?.actions ?? []).find(
      (a) => a.type === "NodeActionDisableTools",
    );
    const denied = (disable?.params as { toolNames?: string[] })?.toolNames ?? [];

    for (const blocked of ["create_plan", "update_plan", "complete_plan", "write_file", "patch", "dispatch_subagent", "adopt_plan_doc"]) {
      assert.ok(
        denied.includes(blocked),
        `Direct agent must not call ${blocked}`,
      );
    }
    for (const blocked of ["write_plan_doc", "report_step_blocked", "fsm_route"]) {
      assert.ok(denied.includes(blocked), `Direct agent must not call ${blocked}`);
    }

    const tools = node?.actions?.find((a) => a.type === "NodeActionPrepareTools");
    assert.ok((tools?.params?.allowTools as string[]).includes("read_file"));
    assert.ok(!(tools?.params?.allowTools as string[]).includes("write_file"));
    const prepare = (node?.actions ?? []).find(
      (a) => a.type === "NodeActionPrepareRole",
    );
    assert.equal(
      (prepare?.params as { requirePlanDocForCreatePlan?: boolean })
        ?.requirePlanDocForCreatePlan,
      undefined,
    );
  });

  it("start fans out on routeTarget pins (discarded/rejected → end; roles → role nodes)", () => {
    const startWhens = config.edges.filter(
      (e) =>
        e.from === "start" &&
        e.type === "EdgeWhen" &&
        (e.params as { turnKey?: string }).turnKey === "routeTarget",
    );
    const toEnd = startWhens.filter((e) => e.to === "end");
    assert.equal(toEnd.length, 2); // discarded + rejected
    const roleTargets = startWhens
      .filter((e) => e.to !== "end")
      .map((e) => e.to)
      .sort();
    assert.deepEqual(roleTargets, [...V3_ROLES].sort());
  });

  it("execution_validator / reflector branch on distinct routeTargets; zero EdgeAlways in the whole graph", () => {
    // New V3.1 invariant: every node is a branch point — no unconditional hop.
    assert.equal(
      config.edges.filter((e) => e.type === "EdgeAlways").length,
      0,
    );

    const validatorEquals = config.edges
      .filter((e) => e.from === "execution_validator" && e.type === "EdgeWhen")
      .map((e) => (e.params as { equals?: unknown })?.equals);
    assert.deepEqual(
      [...validatorEquals].sort(),
      ["plan_done", "executor"].sort(),
    );
    const planDoneEquals = config.edges
      .filter((e) => e.from === "plan_done" && e.type === "EdgeWhen")
      .map((e) => (e.params as { equals?: unknown })?.equals);
    assert.deepEqual(planDoneEquals, [ROUTE_TARGET_REFLECT]);
    assert.deepEqual(
      (config.nodes.find((n) => n.id === "plan_done")?.actions ?? []).map((a) => a.type),
      ["NodeActionSetComposerRunMode", "NodeActionRouteTo"],
    );
    assert.equal(
      config.nodes.find((n) => n.id === "execution_validator")?.selfLoop,
      undefined,
      "execution_validator must not self-loop after serial single-claim groups",
    );

    const validatorNode = config.nodes.find(
      (n) => n.id === "execution_validator",
    );
    const actionTypes = (validatorNode?.actions ?? []).map((a) => a.type);
    assert.deepEqual(actionTypes, ["NodeActionValidateCommitStep"]);

    const reflectorEquals = config.edges
      .filter((e) => e.from === "skill_reflector" && e.type === "EdgeWhen")
      .map((e) => (e.params as { equals?: unknown })?.equals);
    // "skill_reflector" continuation is the reflector's selfLoop fallback, not an edge.
    assert.equal(
      config.nodes.find((n) => n.id === "skill_reflector")?.selfLoop,
      true,
      "skill_reflector must self-loop via the node selfLoop flag",
    );
    assert.deepEqual(
      [...reflectorEquals].sort(),
      [ROUTE_TARGET_REFLECT_DONE].sort(),
    );
  });

  it("every node's EdgeWhen conditions are pairwise disjoint (exactly-one-match)", () => {
    const byFrom = new Map<string, Array<{ to: string; equals: unknown }>>();
    for (const edge of config.edges) {
      if (edge.type !== "EdgeWhen") continue;
      const params = edge.params as { turnKey?: string; equals?: unknown };
      if (params?.turnKey !== "routeTarget")
        continue;
      const list = byFrom.get(edge.from) ?? [];
      list.push({ to: edge.to, equals: params?.equals });
      byFrom.set(edge.from, list);
    }
      // Per (from, turnKey) group the equals values must be pairwise
      // distinct — all fan-out now uses routeTarget + pin.name.
      const groups = new Map<string, Set<string>>();
      for (const edge of config.edges) {
        if (edge.type !== "EdgeWhen") continue;
        const params = edge.params as { turnKey?: string; equals?: unknown };
        if (!params?.turnKey) continue;
        const key = `${edge.from}|${params.turnKey}`;
        const set = groups.get(key) ?? new Set<string>();
        set.add(String(params.equals));
        groups.set(key, set);
      }
      for (const [key, values] of groups) {
        const list = [...values];
        for (const value of list) {
          assert.ok(value !== "undefined", `edge ${key} missing equals`);
        }
      }
      // Distinctness is structural: no duplicate (from, turnKey, equals).
      const seen = new Set<string>();
      for (const edge of config.edges) {
        if (edge.type !== "EdgeWhen") continue;
        const params = edge.params as { turnKey?: string; equals?: unknown };
        if (!params?.turnKey) continue;
        const key = `${edge.from}|${params.turnKey}|${String(params.equals)}`;
        assert.ok(
          !seen.has(key),
          `duplicate edge condition ${key} — exactly-one-match broken`,
        );
        seen.add(key);
      }
  });

  it("V3-only Actions never reference node ids (topology-blind source scan)", () => {
    for (const file of [
      "NodeActionRouteTo.ts",
      "NodeActionRoundGate.ts",
      "NodeActionValidateCommitStep.ts",
      "routeAfterCommon.ts",
      "routeEvents.ts",
    ]) {
      const source = readFileSync(
        new URL(`./actions/${file}`, import.meta.url),
        "utf8",
      );
      assert.ok(
        !/\bNODE_[A-Z_]+\b/.test(source),
        `${file} must not reference node-id constants`,
      );
      assert.ok(
        !source.includes("from \"../constants.js\""),
        `${file} must not import node-id constants module`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Hostless stub runs
// ---------------------------------------------------------------------------

describe("plan_execute v3 hostless stub runs", () => {
  it("start → analyser bare reply → reflect skip → end", async () => {
    const result = await FSMGraph.run(createPlanExecuteV3GraphConfig(), {}, {
      registries: createDefaultActionRegistry(),
    });
    assert.equal(result.reason, "end_node");
    assert.deepEqual(result.nodesVisited, [
      "start",
      "analyser",
      "skill_reflect_gate",
      "end",
    ]);
    assert.equal(result.turnContext.finishedIdle, true);
    // Guard: A-group round keys never leak onto turnContext — the round
    // container is nodeContext (fresh per visit); only lastAssistantRound
    // (typed turn slot) and the stepClaimTx transaction may survive.
    for (const key of [
      "assistant",
      "toolCalls",
      "routeTarget",
      "toolsRan",
      "stepClaimed",
      "subagentInjected",
      "hasPendingToolCalls",
      "toolEffects",
      "activeRole",
    ]) {
      assert.equal(
        (result.turnContext as Record<string, unknown>)[key],
        undefined,
        `turnContext.${key} must stay round-scoped (nodeContext)`,
      );
    }
  });

  it("stub tool round self-loops the role once, then exits", async () => {
    const result = await FSMGraph.run(
      createPlanExecuteV3GraphConfig(),
      { stubForceToolCalls: true },
      { registries: createDefaultActionRegistry() },
    );
    assert.equal(result.reason, "end_node");
    assert.deepEqual(result.nodesVisited, [
      "start",
      "analyser",
      "analyser",
      "skill_reflect_gate",
      "end",
    ]);
    // toolsRan is round-scoped (nodeContext) — no turnContext mirror to read;
    // the trajectory above already proves round 2 ran no tools.
    for (const key of ["toolsRan", "hasPendingToolCalls", "routeTarget"]) {
      assert.equal(
        (result.turnContext as Record<string, unknown>)[key],
        undefined,
        `turnContext.${key} must stay round-scoped`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Fake-host behavior runs
// ---------------------------------------------------------------------------

describe("plan_execute v3 host runs", () => {
  it("analyser fsm_route=direct → agent answers → reflect skip → end", async () => {
    const session = makeSession();
    const { host, events } = makeFakeHost({
      session,
      rounds: [
        {
          toolCalls: [
            makeToolCall("t1", "fsm_route", {
              route: "direct",
              reason: "simple question",
            }),
          ],
        },
        { text: "Answered directly." },
      ],
    });

    const scope = makeScope(session, "analyser");
    const result = await FSMGraph.run(
      createPlanExecuteV3GraphConfig(),
      { turnScope: scope },
      { registries: createDefaultActionRegistry(), host, turnInput: makeTurnInput(session) },
    );

    assert.equal(result.reason, "end_node");
    assert.deepEqual(result.nodesVisited, [
      "start",
      "analyser",
      "agent",
      "skill_reflect_gate",
      "end",
    ]);
    // activeRole single ledger: scope.turnState (mirrors were deleted).
    assert.equal(scope.turnState.activeRole, "agent");
    assert.equal(session.status, "idle");
    assert.ok(events.includes("tools:fsm_route"));
    assert.ok(events.includes("finish:idle"));
  });

  it("analyser route=plan → plan_writer write_plan_doc → plan_reviewer ready → end", async () => {
    const session = makeSession();
    const { host, events } = makeFakeHost({
      session,
      rounds: [
        {
          toolCalls: [
            makeToolCall("t1", "fsm_route", { route: "plan", reason: "needs a plan" }),
          ],
        },
        {
          toolCalls: [
            makeToolCall("t2", "write_plan_doc", {
              path: "/tmp/plan.md",
              title: "T",
              content: "# T",
              summary: "s",
            }),
          ],
        },
        {
          toolCalls: [
            makeToolCall("t3", "fsm_route", { route: "ready", reason: "plan ready" }),
          ],
        },
      ],
    });

    const result = await FSMGraph.run(
      createPlanExecuteV3GraphConfig(),
      { turnScope: makeScope(session, "analyser"), activeRole: "analyser" },
      { registries: createDefaultActionRegistry(), host, turnInput: makeTurnInput(session) },
    );

    assert.equal(result.reason, "end_node");
    assert.deepEqual(result.nodesVisited, [
      "start",
      "analyser",
      "plan_writer",
      "plan_reviewer",
      "skill_reflect_gate",
      "end",
    ]);
    assert.equal(session.phase, "review");
    assert.equal(session.planDoc?.approvalPending, true);
    assert.equal(session.status, "idle");
  });

  it("executor step claim: execution_validator commits → back to executor; semantic signals only", async () => {
    const plan: SessionPlan = {
      id: "plan-1",
      title: "T",
      status: "active",
      steps: [
        { id: "s1", title: "First", status: "completed" },
        { id: "s2", title: "Second", status: "pending" },
      ],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      createToolCallId: "tc0",
    };
    // Production-equivalent seeding: phase executing + incomplete plan
    // → EdgeWhen source=session resumes executor (StartTurn leaves routeTarget unset).
    const session = makeSession({ plan, phase: "executing" });
    const scope = makeScope(session, "executor");
    const { host } = makeFakeHost({
      session,
      rounds: [
        {
          toolCalls: [
            makeToolCall("t1", "update_plan", {
              steps: [
                { id: "s1", status: "completed" },
                { id: "s2", status: "in_progress" },
              ],
            }),
          ],
        },
        { text: "Step done." },
      ],
    });

    const result = await FSMGraph.run(
      createPlanExecuteV3GraphConfig(),
      { turnScope: scope },
      { registries: createDefaultActionRegistry(), host, turnInput: makeTurnInput(session) },
    );

    assert.equal(result.reason, "end_node");
    assert.deepEqual(result.nodesVisited, [
      "start",
      "executor",
      "execution_validator",
      "executor",
      "skill_reflect_gate",
      "end",
    ]);
    // Claim verified and committed (s1); serial update_plan auto-started s2.
    assert.equal(session.plan?.steps.find((s) => s.id === "s1")?.status, "completed");
    assert.equal(session.plan?.steps.find((s) => s.id === "s2")?.status, "in_progress");
    // stepClaimTx transaction closed after commit (single-key container).
    assert.equal(
      (result.turnContext as Record<string, unknown>).stepClaimTx,
      null,
    );
    // Round keys never leak onto turnContext (round container = nodeContext).
    for (const key of ["stepClaimed", "routeTarget", "toolsRan"]) {
      assert.equal(
        (result.turnContext as Record<string, unknown>)[key],
        undefined,
        `turnContext.${key} must stay round-scoped`,
      );
    }
    assert.equal(session.status, "idle");
  });

  it("execution_validator commits a single claim then resumes executor", async () => {
    // Serial plans: one completed step per update_plan round.
    const plan: SessionPlan = {
      id: "plan-q",
      title: "Queue",
      status: "active",
      steps: [
        { id: "s1", title: "A", status: "completed" },
        { id: "s2", title: "B", status: "pending", dependsOn: ["s1"] },
        { id: "s3", title: "C", status: "pending" },
      ],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      createToolCallId: "tc0",
    };
    const session = makeSession({ plan, phase: "executing" });
    const { host } = makeFakeHost({
      session,
      rounds: [
        {
          toolCalls: [
            makeToolCall("t1", "update_plan", {
              steps: [{ id: "s1", status: "completed" }],
            }),
          ],
        },
        { text: "Step committed." },
      ],
    });

    const result = await FSMGraph.run(
      createPlanExecuteV3GraphConfig(),
      { turnScope: makeScope(session, "executor") },
      { registries: createDefaultActionRegistry(), host, turnInput: makeTurnInput(session) },
    );

    assert.equal(result.reason, "end_node");
    assert.deepEqual(result.nodesVisited, [
      "start",
      "executor",
      "execution_validator",
      "executor",
      "skill_reflect_gate",
      "end",
    ]);
    assert.equal(
      (result.turnContext as Record<string, unknown>).stepClaimTx,
      null,
    );
    assert.equal(session.status, "idle");
  });

  it("last step commit closes the plan via plan_done and requests the Agent composer", async () => {
    const plan: SessionPlan = {
      id: "plan-done",
      title: "Done",
      status: "active",
      steps: [
        { id: "s1", title: "A", status: "completed" },
        { id: "s2", title: "B", status: "in_progress", dependsOn: ["s1"] },
      ],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      createToolCallId: "tc0",
    };
    const session = makeSession({ plan, phase: "executing" });
    const { host } = makeFakeHost({
      session,
      rounds: [
        {
          toolCalls: [
            makeToolCall("t1", "update_plan", {
              steps: [{ id: "s2", status: "completed" }],
            }),
          ],
        },
      ],
    });
    const requested: string[] = [];
    Object.assign(host, {
      requestComposerRunMode: (mode: string) => void requested.push(mode),
    });

    const result = await FSMGraph.run(
      createPlanExecuteV3GraphConfig(),
      { turnScope: makeScope(session, "executor") },
      { registries: createDefaultActionRegistry(), host, turnInput: makeTurnInput(session) },
    );

    assert.equal(result.reason, "end_node");
    assert.deepEqual(result.nodesVisited, [
      "start",
      "executor",
      "execution_validator",
      "plan_done",
      "skill_reflect_gate",
      "end",
    ]);
    assert.equal(session.plan?.status, "completed");
    assert.deepEqual(requested, ["agent"]);
    assert.equal(session.status, "idle");
  });

  it("execution_validator fail branch reverts the step and returns to executor", async () => {
    // s2 claims completed but its dependency s1 is still pending → verify
    // fail → CommitStep reverts s2 to in_progress and routes back to executor.
    const plan: SessionPlan = {
      id: "plan-f",
      title: "Fail",
      status: "active",
      steps: [
        { id: "s1", title: "A", status: "pending" },
        { id: "s2", title: "B", status: "completed", dependsOn: ["s1"] },
        { id: "s3", title: "C", status: "pending" },
      ],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      createToolCallId: "tc0",
    };
    // Production-equivalent seeding: phase executing → executor.
    const session = makeSession({ plan, phase: "executing" });
    const { host, events } = makeFakeHost({
      session,
      rounds: [
        {
          toolCalls: [
            makeToolCall("t1", "update_plan", {
              steps: [
                { id: "s2", status: "completed" },
              ],
            }),
          ],
        },
        { text: "Will retry." },
      ],
    });

    const result = await FSMGraph.run(
      createPlanExecuteV3GraphConfig(),
      { turnScope: makeScope(session, "executor") },
      { registries: createDefaultActionRegistry(), host, turnInput: makeTurnInput(session) },
    );

    assert.equal(result.reason, "end_node");
    assert.deepEqual(result.nodesVisited, [
      "start",
      "executor",
      "execution_validator",
      "executor",
      "skill_reflect_gate",
      "end",
    ]);
    // The claimed-but-blocked step was reverted to in_progress.
    assert.equal(session.plan?.steps.find((s) => s.id === "s2")?.status, "in_progress");
    assert.ok(
      events.some((e) => e.includes("cannot commit yet")),
    );
    assert.equal(session.status, "idle");
  });

  it("abort mid self-loop halts cancelled at the role's Round gate", async () => {
    const session = makeSession();
    const { host } = makeFakeHost({
      session,
      rounds: [
        { toolCalls: [makeToolCall("t1", "read_file", { path: "/tmp/x" })] },
        { text: "never reached" },
      ],
      abortAfter: 1,
    });

    const result = await FSMGraph.run(
      createPlanExecuteV3GraphConfig(),
      { turnScope: makeScope(session, "analyser"), activeRole: "analyser" },
      { registries: createDefaultActionRegistry(), host, turnInput: makeTurnInput(session) },
    );

    assert.equal(result.reason, "halt");
    assert.deepEqual(result.nodesVisited, ["start", "analyser", "analyser"]);
    assert.equal(session.status, "cancelled");
  });

  it("eligible reflect runs a tool round, self-loops once, caps and ends", async () => {
    // Production-equivalent path into the agent role: analyser fsm_route
    // direct → agent (StartTurn seeds analyser when no phase resumes).
    const session = makeSession();
    const { host, events } = makeFakeHost({
      session,
      rounds: [
        {
          toolCalls: [
            makeToolCall("t0", "fsm_route", { route: "direct", reason: "simple" }),
          ],
        },
        { text: "main loop done" },
        { toolCalls: [makeToolCall("t1", "read_file", { path: "/tmp/x" })] },
        { text: "reflect done" },
      ],
      counters: { turnModelIterations: 20 },
    });

    const scope = makeScope(session, "agent");
    const result = await FSMGraph.run(
      createPlanExecuteV3GraphConfig(),
      { turnScope: scope },
      {
        registries: createDefaultActionRegistry(),
        host,
        turnInput: makeTurnInput(session, { autoSkillSummarize: true }),
      },
    );

    assert.equal(result.reason, "end_node");
    assert.deepEqual(result.nodesVisited, [
      "start",
      "analyser",
      "agent",
      "skill_reflect_gate",
      "skill_reflector",
      "skill_reflector",
      "end",
    ]);
    assert.ok(events.includes("tools:read_file"));
    assert.equal(scope.turnState.activeRole, "skill_reflector");
    assert.equal(session.status, "idle");
  });

  it("Approve controlIntent routes start → planner and sets phase=planning", async () => {
    const session = makeSession({
      phase: "review",
      planDoc: {
        path: "/tmp/plan.md",
        summary: "s",
        updatedAt: Date.now(),
        approvalPending: true,
      },
    });
    const { host } = makeFakeHost({
      session,
      rounds: [{ text: "creating checklist next" }],
    });

    const result = await FSMGraph.run(
      createPlanExecuteV3GraphConfig(),
      { turnScope: makeScope(session, "analyser") },
      {
        registries: createDefaultActionRegistry(),
        host,
        turnInput: makeTurnInput(session, {
          controlIntent: "approve",
          suppressUserMessage: true,
        }),
      },
    );

    assert.equal(result.reason, "end_node");
    assert.equal(result.nodesVisited[0], "start");
    assert.equal(result.nodesVisited[1], "planner");
    assert.equal(session.phase, "planning");
    assert.notEqual(session.planDoc?.approvalPending, true);
  });

  it("StartTurn resumes planner when session.phase is planning", async () => {
    const session = makeSession({
      phase: "planning",
      planDoc: {
        path: "/tmp/plan.md",
        summary: "s",
        updatedAt: Date.now(),
      },
    });
    const { host } = makeFakeHost({
      session,
      rounds: [{ text: "resume planner" }],
    });

    const result = await FSMGraph.run(
      createPlanExecuteV3GraphConfig(),
      { turnScope: makeScope(session, "analyser") },
      {
        registries: createDefaultActionRegistry(),
        host,
        turnInput: makeTurnInput(session),
      },
    );

    assert.equal(result.reason, "end_node");
    assert.equal(result.nodesVisited[0], "start");
    assert.equal(result.nodesVisited[1], "planner");
    assert.equal(session.phase, "planning");
  });
});
