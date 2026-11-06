/**
 * Shared fixtures for FSM graph benchmark scenarios (S1–S8).
 *
 * Adapted from the proven mock harnesses in planExecuteV3.test.ts /
 * hostBridge.test.ts — scripted fake host, no real LLM, fully repeatable.
 * Consumed by graphScenarios.ts; kept out of *.test.ts files so both the
 * behavior suite and the baseline suite can import them.
 */
import type {
  AssistantMessage,
  MessagePart,
  Session,
  SessionPlan,
  SessionPlanDoc,
  ToolCallPart,
} from "../../session/types.js";
import type { PermissionGateState } from "../../tools/types.js";
import type { StreamChatFn } from "../types.js";
import type { RunAgentTurnInput } from "../types.js";
import { PlanFacade } from "../roles/PlanFacade.js";
import { createTurnState, type RoleKind } from "../roles/types.js";
import { createUniformRoleLlmBundle } from "../roles/llmBinding.js";
import type { TurnScope } from "./turnScope.js";
import type { FsmHostCapabilities } from "./FsmHostCapabilities.js";
import { mergeLegacyPhaseColumnIntoBlackboard } from "../../session/sessionPhase.js";

// ---------------------------------------------------------------------------
// Session / scope / input fixtures
// ---------------------------------------------------------------------------

export function makeSession(options?: {
  id?: string;
  plan?: SessionPlan | null;
  planDoc?: SessionPlanDoc | null;
  phase?: string | null;
}): Session {
  const now = Date.now();
  return {
    id: options?.id ?? "bench-sess",
    type: "agent",
    title: "Benchmark",
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
    // Production sessions load via sessionRepository, which merges the legacy
    // phases.phase column into fsmBlackboard — mirror that load-time contract
    // so phaseResume (Compare + RouteTo on the session blackboard) sees it.
    fsmBlackboard: mergeLegacyPhaseColumnIntoBlackboard(
      null,
      options?.phase ?? null,
    ),
  } as Session;
}

export function makeScope(
  session: Session,
  activeRole: RoleKind,
): TurnScope {
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

export function makeTurnInput(
  session: Session,
  extra?: Record<string, unknown>,
): RunAgentTurnInput {
  let idSeq = 0;
  return {
    session,
    userText: "benchmark task",
    client: {
      baseUrl: "http://127.0.0.1:9",
      apiKey: "test-key",
      model: "mock-model",
    },
    // TurnHost requires an id factory + permission gate (hostBridge pattern).
    createId: () => `bid-${++idSeq}`,
    gate: { fullPermissionsEnabled: true } as PermissionGateState,
    ...(extra ?? {}),
  } as RunAgentTurnInput;
}

export function makeToolCall(
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

// ---------------------------------------------------------------------------
// Scripted fake host
// ---------------------------------------------------------------------------

export type ScriptedRound = { toolCalls?: ToolCallPart[]; text?: string };

export type FakeHostOptions = {
  session: Session;
  /** One entry per streamModelRound call; extra rounds degrade to empty. */
  rounds: ScriptedRound[];
  /** Seed getCounters() — e.g. skill-reflect thresholds. */
  counterSeed?: { modelIterations?: number; toolFailureCount?: number };
  isSubagentTurn?: boolean;
};

/** Tool-call counting lives in graphMetrics.instrumentFakeHost, not here. */
export function makeFakeHost(options: FakeHostOptions): {
  host: FsmHostCapabilities;
  events: string[];
} {
  const counters = {
    modelIterations: 0,
    turnBillableTokens: 0,
    toolFailureCount: 0,
    ...options.counterSeed,
  };
  const events: string[] = [];
  let roundIndex = 0;
  let abortChecks = 0;
  let idSeq = 0;

  const host: FsmHostCapabilities = {
    session: options.session,
    isSubagentTurn: options.isSubagentTurn === true,
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
      // Legacy mirror: session.phase stays readable for DB migration paths
      // and older assertions (same contract as the real sessionRuntime host).
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
      return false;
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
        ...(round.text ? { textPart: { type: "text", text: round.text } } : {}),
        reasoningBuf: "",
        roundBillableTokens: 0,
      };
    },
    runToolsPhase: async (_assistant, toolCalls) => {
      events.push(`tools:${toolCalls.map((c) => c.name).join(",")}`);
      const routeEvents: import("../contracts/index.js").RouteEventPatch[] = [];
      for (const call of toolCalls) {
        if (call.name === "fsm_route" && call.status === "done") {
          const { fsmRouteHandler } = await import(
            "../../tools/builtin/fsmRoute.js"
          );
          const result = await fsmRouteHandler(call.arguments, {
              workspacePath: options.session.workspacePath || "/tmp/ws",
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
        if (call.name === "write_plan_doc" && call.status === "done") {
          const { writePlanDocHandler } = await import(
            "../../tools/builtin/writePlanDoc.js"
          );
          const result = await writePlanDocHandler(call.arguments, {
              workspacePath: options.session.workspacePath || "/tmp/ws",
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
        if (call.name === "update_plan" && call.status === "done") {
          const { updatePlanHandler } = await import(
            "../../tools/builtin/updatePlan.js"
          );
          const result = await updatePlanHandler(call.arguments, {
              workspacePath: options.session.workspacePath || "/tmp/ws",
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
    onEvent: (event) =>
      void events.push(`onEvent:${event.type}:${"text" in event ? event.text : ""}`),
    emitError: (message) => void events.push(`error:${message}`),
  };
  return { host, events };
}
