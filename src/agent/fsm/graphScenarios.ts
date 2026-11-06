/**
 * Benchmark scenario definitions S1–S8 — docs/plans/20260827-fsm-graph-benchmark-suite.md.
 *
 * Each scenario is a named, repeatable full-graph run against production
 * configs. Returns FSM result + instrumented metrics; the behavior suite
 * asserts on result semantics, the baseline suite compares metrics against
 * git-tracked JSON (single authority — Review inventory #1).
 *
 * Known limits (documented, intentional):
 * - Hostless stub scenarios (S2) cannot expose model-window sizes, so their
 *   estPromptTokens is structurally 0 — a stable value, still comparable.
 * - Skill-reflect ELIGIBLE branch (S7a) needs seeded host counters above the
 *   SKILL_REFLECT thresholds; no prior test exercised it, so the expected
 *   trajectory here doubles as its first characterization.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "../../session/types.js";
import type { StreamEvent } from "../../llm/streamEvents.js";
import type {
  OpenAiCompatibleClientConfig,
  StreamChatOptions,
} from "../../llm/types.js";
import { configureUserMemoryRoot } from "../../memory/store.js";
import { configurePromptDefaults } from "../../settings/promptDefaults.js";
import { registerBuiltins } from "../../tools/index.js";
import { createDefaultActionRegistry } from "./actions/createDefaultActionRegistry.js";
import { FSMGraph } from "./FSMGraph.js";
import { createTurnHost } from "../turnHost/createTurnHost.js";
import { createTurnScope } from "../workflow/turnScope.js";
import {
  createReactGraphConfig,
  createSubagentGraphConfig,
  createPlanExecuteV3GraphConfig,
} from "./configs/sampleGraphs.js";
import { resolveCustomFsmGraphForTurn } from "./graphLibrary/manager.js";
import {
  collectStructure,
  configFingerprint,
  emptyMetrics,
  instrumentFakeHost,
  instrumentStreamChat,
  type GraphRunMetrics,
} from "./graphMetrics.js";
import {
  makeFakeHost,
  makeScope,
  makeSession,
  makeToolCall,
  makeTurnInput,
  type ScriptedRound,
} from "./graphScenariosFixtures.js";

// ---------------------------------------------------------------------------
// One-shot env setup (memory root / prompts / builtin tools)
// ---------------------------------------------------------------------------

let envReady: Promise<void> | null = null;
let envDir = "";

export function initBenchmarkEnv(): Promise<void> {
  if (!envReady) {
    envReady = (async () => {
      envDir = await mkdtemp(join(tmpdir(), "fsm-bench-"));
      configureUserMemoryRoot(envDir);
      configurePromptDefaults(join(process.cwd(), "resources", "prompts"));
      registerBuiltins();
    })();
  }
  return envReady;
}

export async function disposeBenchmarkEnv(): Promise<void> {
  if (envDir) {
    await rm(envDir, { recursive: true, force: true });
    envDir = "";
    envReady = null;
  }
}

// ---------------------------------------------------------------------------
// Scenario plumbing
// ---------------------------------------------------------------------------

export type ScenarioOutcome = {
  /** Config identity + content fingerprint for baseline keying. */
  configLabel: string;
  fingerprint: string;
  exitReason: string;
  finalNodeId: string;
  /** Assistant-facing text produced by the last scripted round, if any. */
  tailText: string | null;
  /** Live session handed to the run — for status/message assertions. */
  session: Session | null;
  /** scope.turnState.activeRole at the end of scripted v3 runs. */
  activeRoleAfter?: string;
  metrics: GraphRunMetrics;
};

type ScriptedTextStream = (script: string[]) => {
  stream: (
    config: OpenAiCompatibleClientConfig,
    options: StreamChatOptions,
  ) => AsyncGenerator<StreamEvent, void, undefined>;
  texts: () => string[];
};

/** TurnHost-style mock: one scripted text reply per model call. */
const scriptedTextStream: ScriptedTextStream = (script) => {
  const emitted: string[] = [];
  let index = 0;
  const stream = async function* (
    _config: OpenAiCompatibleClientConfig,
    _options: StreamChatOptions,
  ): AsyncGenerator<StreamEvent, void, undefined> {
    const text = script[index] ?? "Fallback reply.";
    index += 1;
    emitted.push(text);
    yield { type: "text_delta", text };
    yield { type: "usage", promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    yield { type: "done", reason: "completed" };
  };
  return { stream, texts: () => [...emitted] };
};

async function runWithTurnHost(options: {
  session: Session;
  script: string[];
  config: ReturnType<typeof createReactGraphConfig>;
  subagent?: { roleKind: "general" | "explore" | "worker"; parentId: string; childId: string };
}): Promise<ScenarioOutcome> {
  const metrics = emptyMetrics();
  const mocked = scriptedTextStream(options.script);
  const turnInput = makeTurnInput(options.session, {
    ...(options.subagent
      ? {
          isSubagentTurn: true,
          subagentRoleKind: options.subagent.roleKind,
          parentSessionId: options.subagent.parentId,
          subagentId: options.subagent.childId,
        }
      : {}),
    streamChat: instrumentStreamChat(
      mocked.stream as never,
      metrics,
    ),
  });
  const host = createTurnHost({
    ...turnInput,
    runChildTurn: async () => ({ status: "idle", modelIterations: 0 }),
  });
  try {
    const result = await FSMGraph.run(
      options.config,
      { turnScope: createTurnScope(turnInput) },
      {
        registries: createDefaultActionRegistry(),
        host,
        turnInput,
      },
    );
    return {
      configLabel: "",
      fingerprint: configFingerprint(options.config),
      exitReason: result.reason,
      finalNodeId: result.currentNodeId,
      tailText: mocked.texts().at(-1) ?? null,
      session: options.session,
      metrics: { ...metrics, ...collectStructure(result) },
    };
  } finally {
    host.dispose();
  }
}

async function runScriptedV3(options: {
  session: Session;
  activeRole: Parameters<typeof makeScope>[1];
  rounds: ScriptedRound[];
  counterSeed?: { modelIterations?: number; toolFailureCount?: number };
  /** Seed turnContext.autoSkillSummarize — part of the S7a eligibility AND. */
  autoSkillSummarize?: boolean;
}): Promise<ScenarioOutcome> {
  const metrics = emptyMetrics();
  const { host } = makeFakeHost({
    session: options.session,
    rounds: options.rounds,
    ...(options.counterSeed !== undefined
      ? { counterSeed: options.counterSeed }
      : {}),
  });
  const instrumented = instrumentFakeHost(host, metrics);
  const scope = makeScope(options.session, options.activeRole);
  const config = createPlanExecuteV3GraphConfig();
  const result = await FSMGraph.run(
    config,
    {
      turnScope: scope,
      ...(options.autoSkillSummarize ? { autoSkillSummarize: true } : {}),
    },
    {
      registries: createDefaultActionRegistry(),
      host: instrumented,
      turnInput: makeTurnInput(options.session),
    },
  );
  return {
    configLabel: "",
    fingerprint: configFingerprint(config),
    exitReason: result.reason,
    finalNodeId: result.currentNodeId,
    tailText: null,
    session: options.session,
    activeRoleAfter: String(scope.turnState.activeRole ?? ""),
    metrics: { ...metrics, ...collectStructure(result) },
  };
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

/** Config labels double as baseline keys alongside the content fingerprint. */
export const SCENARIOS: Record<string, () => Promise<ScenarioOutcome>> = {  /** S1 · react baseline — direct answer, minimal loop. */
  S1_react_baseline: async () => {
    await initBenchmarkEnv();
    return runWithTurnHost({
      session: makeSession({ id: "bench-s1" }),
      script: ["Hello from benchmark."],
      config: createReactGraphConfig(),
    }).then((outcome) => ({ ...outcome, configLabel: "S1_react_baseline" }));
  },

  /** S2 · react self-loop — forced tool round loops agent once (hostless stub). */
  S2_react_selfloop: async () => {
    await initBenchmarkEnv();
    const metrics = emptyMetrics();
    const config = createReactGraphConfig();
    const result = await FSMGraph.run(
      config,
      { stubForceToolCalls: true },
      {
        registries: createDefaultActionRegistry(),
      },
    );
    return {
      configLabel: "S2_react_selfloop",
      fingerprint: configFingerprint(config),
      exitReason: result.reason,
      finalNodeId: result.currentNodeId,
      tailText: null,
      // Hostless stub run — no session object participates.
      session: null,
      // No host/window seam in hostless mode → prompt estimate stays 0.
      metrics: { ...metrics, ...collectStructure(result) },
    };
  },

  /** S3 · v3 direct lane — analyser routes direct, agent answers, skip → end. */
  S3_v3_direct: async () => {
    await initBenchmarkEnv();
    return runScriptedV3({
      session: makeSession({ id: "bench-s3" }),
      activeRole: "analyser",
      rounds: [
        {
          toolCalls: [
            makeToolCall("b-t1", "fsm_route", { route: "direct", reason: "simple" }),
          ],
        },
        { text: "Answered directly." },
      ],
    }).then((outcome) => ({ ...outcome, configLabel: "S3_v3_direct" }));
  },

  /** S4 · v3 planning lane — route=plan → write_plan_doc → ready → end. */
  S4_v3_plan_lane: async () => {
    await initBenchmarkEnv();
    return runScriptedV3({
      session: makeSession({
        id: "bench-s4",
      }),
      activeRole: "analyser",
      rounds: [
        {
          toolCalls: [
            makeToolCall("b-t1", "fsm_route", { route: "plan", reason: "needs a plan" }),
          ],
        },
        {
          toolCalls: [
            makeToolCall("b-t2", "write_plan_doc", {
              path: "/tmp/bench-plan.md",
              title: "Bench",
              content: "# Bench",
              summary: "s",
            }),
          ],
        },
        {
          toolCalls: [
            makeToolCall("b-t3", "fsm_route", { route: "ready", reason: "plan ready" }),
          ],
        },
      ],
    }).then((outcome) => ({ ...outcome, configLabel: "S4_v3_plan_lane" }));
  },

  /**
   * S5 · v3 validator loopback — executor claims step, validator commits,
   * control returns to executor before finishing (bounded re-entry).
   */
  S5_v3_validator_loop: async () => {
    await initBenchmarkEnv();
    return runScriptedV3({
      session: makeSession({
        id: "bench-s5",
        phase: "executing",
        plan: {
          id: "bench-plan",
          title: "Bench plan",
          status: "active",
          steps: [
            { id: "s1", title: "First", status: "completed" },
            { id: "s2", title: "Second", status: "pending" },
          ],
          createdAt: Date.now(),
          updatedAt: Date.now(),
          createToolCallId: "tc0",
        },
      }),
      activeRole: "executor",
      rounds: [
        {
          toolCalls: [
            makeToolCall("b-t1", "update_plan", {
              steps: [
                { id: "s1", status: "completed" },
                { id: "s2", status: "in_progress" },
              ],
            }),
          ],
        },
        { text: "Step done." },
      ],
    }).then((outcome) => ({ ...outcome, configLabel: "S5_v3_validator_loop" }));
  },

  /** S6 · subagent child loop via TurnHost (isSubagentTurn). */
  S6_subagent_loop: async () => {
    await initBenchmarkEnv();
    return runWithTurnHost({
      session: makeSession({ id: "bench-s6-child" }),
      script: ["Child done."],
      config: createSubagentGraphConfig({ subagentRole: "explore" }),
      subagent: { roleKind: "explore", parentId: "bench-parent", childId: "bench-child-1" },
    }).then((outcome) => ({ ...outcome, configLabel: "S6_subagent_loop" }));
  },

  /** S7a · skill-reflect ELIGIBLE branch — counters seeded past thresholds. */
  S7a_skill_reflect_eligible: async () => {
    await initBenchmarkEnv();
    return runScriptedV3({
      session: makeSession({ id: "bench-s7a" }),
      activeRole: "analyser",
      rounds: [{ text: "Plain answer." }, { text: "Skills reviewed." }],
      // eligible = auto && fullPermissions && iterations > 8 && failures ≥ 1.
      // Scripted rounds can't accumulate 9 iterations — seed getCounters().
      counterSeed: { modelIterations: 9, toolFailureCount: 1 },
      autoSkillSummarize: true,
    }).then((outcome) => ({ ...outcome, configLabel: "S7a_skill_reflect_eligible" }));
  },  /** S7b · skill-reflect SKIP branch — the everyday exit (compare with S7a). */
  S7b_skill_reflect_skip: async () => {
    await initBenchmarkEnv();
    return runScriptedV3({
      session: makeSession({ id: "bench-s7b" }),
      activeRole: "analyser",
      rounds: [{ text: "Plain answer." }],
    }).then((outcome) => ({ ...outcome, configLabel: "S7b_skill_reflect_skip" }));
  },

  /** S8 · saved-graph pipeline — resolve → validate → run to end via library record. */
  S8_custom_graph_pipeline: async () => {
    await initBenchmarkEnv();
    const config = createReactGraphConfig();
    const record = {
      id: "bench-custom-react",
      name: "Benchmark react copy",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      config,
      origin: "user" as const,
      enabled: true,
    };
    const resolved = await resolveCustomFsmGraphForTurn(
      record.id,
      async (id) => (id === record.id ? record : null),
    );
    const outcome = await runWithTurnHost({
      session: makeSession({ id: "bench-s8" }),
      script: ["Custom graph answer."],
      config: resolved.config,
    });
    return { ...outcome, configLabel: "S8_custom_graph_pipeline" };
  },
};

export const SCENARIO_NAMES = Object.keys(SCENARIOS);

// Re-exported so suites don't import internals scattered across modules.
