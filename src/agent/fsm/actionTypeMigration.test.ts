import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  migrateActionParams,
  migrateFSMGraphConfig,
  resolveActionType,
  resolvePinName,
} from "./actionTypeMigration.js";
import { createDefaultActionRegistry } from "./actions/createDefaultActionRegistry.js";
import { createFSMGraphConfig as createCurrentGraphConfig } from "./types.js";
import type { LegacyFSMGraphConfig } from "./compatibility/types.js";

function createFSMGraphConfig(input: Parameters<typeof createCurrentGraphConfig>[0]): LegacyFSMGraphConfig {
  return { ...createCurrentGraphConfig(input), version: 1 };
}

describe("actionTypeMigration", () => {
  it("resolves legacy action type aliases", () => {
    assert.equal(resolveActionType("NodeActionStreamModelRound"), "NodeActionCallModel");
    assert.equal(resolveActionType("NodeActionAdvanceRole"), "NodeActionRouteTo");
    assert.equal(
      resolveActionType("NodeActionRouteAfterRound"),
      "NodeActionRouteTo",
    );
    assert.equal(
      resolveActionType("NodeActionAnalyserRouteAfter"),
      "NodeActionRouteTo",
    );
    assert.equal(resolveActionType("NodeActionCallModel"), "NodeActionCallModel");
  });

  it("resolves legacy pin names to target node ids", () => {
    assert.equal(resolvePinName("reflect"), "skill_reflect_gate");
    assert.equal(resolvePinName("reflect_done"), "end");
    assert.equal(resolvePinName("step_claim"), "execution_validator");
    assert.equal(resolvePinName("executor"), "executor");
  });

  it("renames legacy param keys and collapses RouteAfter slots into routes", () => {
    assert.deepEqual(
      migrateActionParams("NodeActionCallModel", {
        progressLabel: "Hi",
        disableReasoning: true,
      }),
      { waitingMessage: "Hi", disableReasoning: true },
    );
    assert.deepEqual(
      migrateActionParams("NodeActionSetPlanCard", { cardVisible: false }),
      { visible: false },
    );
    assert.deepEqual(
      migrateActionParams(
        "NodeActionRouteTo",
        { onStay: "agent", onReflect: "reflect" },
        "agent",
      ),
      {
        routes: [
          { event: "stay", to: "agent" },
          { event: "leave", to: "skill_reflect_gate" },
        ],
      },
    );
    assert.deepEqual(
      migrateActionParams(
        "NodeActionRouteTo",
        {
          routes: [
            { event: "stay", to: "planner" },
            { event: "checklist_resume", to: "executor" },
          ],
        },
        "planner",
      ),
      {
        routes: [
          { event: "stay", to: "planner" },
          { event: "plan_resume", to: "executor" },
        ],
      },
    );
  });

  it("strips legacy StartTurn params", () => {
    assert.deepEqual(
      migrateActionParams("NodeActionStartTurn", {
        initialActiveRole: "analyser",
        rolePins: { analyser: "analyser", executor: "executor" },
        phaseResume: {
          gathering: "analyser",
          executing: "executor",
        },
        resumeRequireIncompletePlan: ["executing"],
        clearPhaseWhenResumeSkipped: true,
        approvedUserText: "Approved.",
        clearPhaseUnlessIncompletePlan: ["executing"],
      }),
      {},
    );
  });

  it("lifts plan_execute phaseResume onto Compare + RouteTo when-table", () => {
    const config = migrateFSMGraphConfig({
      version: 1,
      id: "legacy_phase_resume",
      entryNodeId: "start",
      terminalNodeId: "end",
      nodes: [
        {
          id: "start",
          actions: [
            {
              type: "NodeActionStartTurn",
              params: {
                initialActiveRole: "analyser",
                phaseResume: {
                  gathering: "analyser",
                  review: "plan_reviewer",
                  executing: "executor",
                },
                resumeRequireIncompletePlan: ["executing"],
                clearPhaseWhenResumeSkipped: true,
              },
            },
          ],
        },
        { id: "analyser" },
        { id: "plan_reviewer" },
        { id: "planner" },
        { id: "executor" },
        { id: "end" },
      ],
      edges: [],
    });
    const startTurn = config.nodes
      .find((n) => n.id === "start")
      ?.actions?.find((a) => a.type === "NodeActionStartTurn");
    assert.deepEqual(startTurn?.params, {});
    const startActions =
      config.nodes.find((n) => n.id === "start")?.actions ?? [];
    const resumeRoute = startActions.find(
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
      const expr =
        row.expr ??
        (row.allOf?.length ? row.allOf.join(" && ") : row.key ?? "");
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
      { phase: "gathering", pin: "analyser", incomplete: false },
      { phase: "review", pin: "plan_reviewer", incomplete: false },
      { phase: "planning", pin: "planner", incomplete: false },
      { phase: "executing", pin: "executor", incomplete: true },
    ]);
    assert.equal(
      startActions.filter(
        (a) =>
          a.type === "NodeActionRouteTo" &&
          Array.isArray((a.params as { when?: unknown })?.when),
      ).length,
      1,
    );
    assert.equal(
      config.edges.filter(
        (e) => (e.params as { source?: string }).source === "session",
      ).length,
      0,
    );
  });

  it("expands legacy RouteToWhen into Compare + RouteTo when-table", () => {
    const config = migrateFSMGraphConfig({
      version: 1,
      id: "legacy_rtw",
      entryNodeId: "start",
      terminalNodeId: "end",
      nodes: [
        {
          id: "start",
          actions: [
            {
              type: "NodeActionRouteToWhen",
              params: {
                key: "count",
                type: "int",
                operator: ">",
                value: 2,
                pin: "next",
              },
            },
          ],
        },
        { id: "next" },
        { id: "end" },
      ],
      edges: [],
    });
    const actions = config.nodes.find((n) => n.id === "start")?.actions ?? [];
    assert.deepEqual(
      actions.map((a) => a.type),
      ["NodeActionCompare", "NodeActionRouteTo"],
    );
    assert.deepEqual((actions[1]?.params as { when?: unknown }).when, [
      { expr: "flag.rtw.next.count.2", to: "next" },
    ]);
  });

  it("replaces legacy SkillReflectGate with Compare + RouteTo stack", () => {
    const config = migrateFSMGraphConfig({
      version: 1,
      id: "legacy_skill_gate",
      entryNodeId: "start",
      terminalNodeId: "end",
      nodes: [
        { id: "start" },
        {
          id: "skill_reflect_gate",
          actions: [{ type: "NodeActionSkillReflectGate" }],
        },
        { id: "skill_reflector" },
        { id: "end" },
      ],
      edges: [],
    });
    const actions =
      config.nodes.find((n) => n.id === "skill_reflect_gate")?.actions ?? [];
    assert.equal(actions[0]?.type, "NodeActionCompare");
    assert.equal(
      (actions[0]?.params as { source?: string }).source,
      "autoSkillSummarize",
    );
    assert.equal(
      actions.filter((a) => a.type === "NodeActionCompare").length,
      4,
    );
    assert.equal(actions.at(-1)?.type, "NodeActionRouteTo");
    assert.equal(
      actions.some((a) => a.type === "NodeActionSkillReflectGate"),
      false,
    );
  });

  it("aliases RouteToIf to RouteTo when-table", () => {
    assert.equal(resolveActionType("NodeActionRouteToIf"), "NodeActionRouteTo");
    const config = migrateFSMGraphConfig({
      version: 1,
      id: "legacy_route_to_if",
      entryNodeId: "start",
      terminalNodeId: "end",
      nodes: [
        {
          id: "start",
          actions: [
            {
              type: "NodeActionRouteToIf",
              params: {
                key: "flag",
                pin: "next",
                onlyIfRouteTargetUnset: true,
              },
            },
          ],
        },
        { id: "next" },
        { id: "end" },
      ],
      edges: [],
    });
    const action = config.nodes.find((n) => n.id === "start")?.actions?.[0];
    assert.equal(action?.type, "NodeActionRouteTo");
    assert.deepEqual(action?.params, {
      when: [{ expr: "flag", to: "next" }],
      onlyIfRouteTargetUnset: true,
    });
  });

  it("migrates SetPhase into WriteBlackboard session phase", () => {
    const config = migrateFSMGraphConfig({
      version: 1,
      id: "legacy_set_phase",
      entryNodeId: "start",
      terminalNodeId: "end",
      nodes: [
        {
          id: "analyser",
          actions: [
            { type: "NodeActionPrepareRole", params: { roleKind: "analyser" } },
            { type: "NodeActionSetPhase", params: { phase: "gathering" } },
          ],
        },
        {
          id: "agent",
          actions: [
            { type: "NodeActionSetPhase", params: { phase: "clear" } },
          ],
        },
        { id: "start" },
        { id: "end" },
      ],
      edges: [],
    });
    const analyser = config.nodes.find((n) => n.id === "analyser")?.actions ?? [];
    assert.ok(!analyser.some((a) => a.type === "NodeActionSetPhase"));
    assert.deepEqual(
      analyser.find((a) => a.type === "NodeActionWriteBlackboard")?.params,
      { key: "phase", scope: "session", value: "gathering" },
    );
    assert.deepEqual(
      config.nodes
        .find((n) => n.id === "agent")
        ?.actions?.find((a) => a.type === "NodeActionWriteBlackboard")?.params,
      { key: "phase", scope: "session", value: null },
    );
  });

  it("migrates ApplyControlIntent approveSetPhase for review gate", () => {
    assert.deepEqual(
      migrateActionParams("NodeActionApplyControlIntent", {
        onApproved: "planner",
        onDiscarded: "discarded",
        onRejected: "rejected",
        approveRequirePhase: "review",
        approveRequirePlanDoc: true,
      }),
      {
        onApproved: "planner",
        onDiscarded: "discarded",
        onRejected: "rejected",
        approveRequirePhase: "review",
        approveRequirePlanDoc: true,
        approveSetPhase: "planning",
      },
    );
  });

  it("migrates askMode on PrepareTools to allowTools; strips RunTools allowTools", () => {
    const prepare = migrateActionParams("NodeActionPrepareTools", {
      askMode: true,
      useOfferSet: true,
      denyTools: ["write_file"],
      useRoleToolPredicate: false,
      includeForcedMetas: false,
    });
    assert.ok(prepare);
    assert.equal(prepare.askMode, undefined);
    assert.equal(prepare.denyTools, undefined);
    assert.equal(prepare.useRoleToolPredicate, undefined);
    assert.equal(prepare.includeForcedMetas, undefined);
    assert.ok(Array.isArray(prepare.allowTools));
    assert.ok((prepare.allowTools as string[]).includes("read_file"));
    assert.ok((prepare.allowTools as string[]).includes("mcp__tavily__*"));

    const run = migrateActionParams("NodeActionRunTools", {
      askMode: true,
      allowTools: ["read_file"],
    });
    assert.ok(run);
    assert.equal(run.askMode, undefined);
    assert.equal(run.allowTools, undefined);

    const role = migrateActionParams("NodeActionPrepareRole", {
      roleKind: "agent",
      askMode: true,
      onEnter: { phase: "gathering" },
    });
    assert.ok(role);
    assert.equal(role.askMode, undefined);
    assert.equal(role.onEnter, undefined);
  });

  it("splits PrepareRole.onEnter into WriteBlackboard phase and CompleteActivePlan", () => {
    const config = migrateFSMGraphConfig(
      createFSMGraphConfig({
        entryNodeId: "start",
        terminalNodeId: "end",
        nodes: [
          {
            id: "plan_writer",
            actions: [
              {
                type: "NodeActionPrepareRole",
                params: {
                  roleKind: "plan_writer",
                  onEnter: {
                    phase: "drafting",
                    completeActivePlan: true,
                  },
                },
              },
            ],
          },
          { id: "start", actions: [] },
          { id: "end", actions: [] },
        ],
        edges: [],
      }),
    );
    const actions = config.nodes.find((n) => n.id === "plan_writer")!.actions!;
    assert.equal(actions[0]?.type, "NodeActionPrepareRole");
    assert.equal(actions[1]?.type, "NodeActionSyncPlanStep");
    assert.equal(actions[2]?.type, "NodeActionWriteBlackboard");
    assert.deepEqual(actions[2]?.params, {
      key: "phase",
      scope: "session",
      value: "drafting",
    });
    assert.equal(actions[3]?.type, "NodeActionCompleteActivePlan");
    assert.equal(
      (actions[0]?.params as { onEnter?: unknown }).onEnter,
      undefined,
    );
  });

  it("collapses specialized RouteAfter types without inventing role defaults", () => {
    const config = migrateFSMGraphConfig(
      createFSMGraphConfig({
        entryNodeId: "start",
        terminalNodeId: "end",
        nodes: [
          {
            id: "analyser",
            pins: [
              { name: "analyser" },
              { name: "agent" },
              { name: "plan_writer" },
              { name: "skill_reflect_gate" },
            ],
            actions: [
              {
                type: "NodeActionAdvanceRole",
                params: { onStay: "analyser", onReflect: "reflect" },
              },
            ],
          },
          { id: "end", actions: [] },
          { id: "start", actions: [] },
        ],
        edges: [],
      }),
    );
    const action = config.nodes.find((n) => n.id === "analyser")!.actions![0]!;
    assert.equal(action.type, "NodeActionRouteTo");
    assert.deepEqual(action.params?.routes, [
      { event: "stay", to: "analyser" },
      { event: "leave", to: "skill_reflect_gate" },
    ]);
  });

  it("loads legacy types before passing canonical actions to the registry", () => {
    const registry = createDefaultActionRegistry();
    assert.throws(() => registry.createAction("NodeActionStreamModelRound", { progressLabel: "Working…" }, "test"));
    const migrated = migrateFSMGraphConfig(createFSMGraphConfig({
      entryNodeId: "review", nodes: [{ id: "review", actions: [{
        type: "NodeActionStreamModelRound", params: { progressLabel: "Working…" },
      }] }], edges: [],
    }));
    const config = migrated.nodes[0]!.actions![0]!;
    assert.equal(registry.createAction(config.type, config.params, "test").type, "NodeActionCallModel");
  });

  it("migrates a graph config including pin names", () => {
    const config = migrateFSMGraphConfig(
      createFSMGraphConfig({
        entryNodeId: "start",
        terminalNodeId: "end",
        nodes: [
          {
            id: "agent",
            pins: [{ name: "reflect" }],
            actions: [
              {
                type: "NodeActionStreamModelRound",
                params: { progressLabel: "Go" },
              },
              {
                type: "NodeActionAdvanceRole",
                params: { onStay: "agent", onReflect: "reflect" },
              },
            ],
          },
          { id: "end", actions: [] },
        ],
        edges: [
          {
            from: "agent",
            to: "skill_reflect_gate",
            type: "EdgeWhen",
            params: {
              turnKey: "routeTarget",
              equals: "reflect",
              source: "node",
            },
          },
        ],
      }),
    );
    assert.equal(config.nodes[0]!.actions![0]!.type, "NodeActionCallModel");
    assert.deepEqual(config.nodes[0]!.actions![0]!.params, {
      waitingMessage: "Go",
    });
    assert.equal(config.nodes[0]!.pins![0]!.name, "skill_reflect_gate");
    assert.deepEqual(
      (config.nodes[0]!.actions![1]!.params as { routes: unknown }).routes,
      [
        { event: "stay", to: "agent" },
        { event: "leave", to: "skill_reflect_gate" },
      ],
    );
    assert.equal(config.nodes[0]!.actions![1]!.type, "NodeActionRouteTo");
    assert.equal(
      (config.edges[0]!.params as { equals?: string }).equals,
      "skill_reflect_gate",
    );
  });

  it("injects PromptInject from legacy PrepareRole overlayPreset", () => {
    const config = migrateFSMGraphConfig(
      createFSMGraphConfig({
        entryNodeId: "start",
        terminalNodeId: "end",
        nodes: [
          {
            id: "planner",
            actions: [
              {
                type: "NodeActionPrepareRole",
                params: {
                  roleKind: "planner",
                  overlayPreset: "planner",
                },
              },
              { type: "NodeActionCallModel", params: {} },
            ],
          },
          { id: "end", actions: [] },
        ],
        edges: [],
      }),
    );
    const actions = config.nodes.find((n) => n.id === "planner")!.actions!;
    assert.equal(actions[0]!.type, "NodeActionPrepareRole");
    assert.equal(actions[1]!.type, "NodeActionSyncPlanStep");
    assert.equal(actions[2]!.type, "NodeActionWriteBlackboard");
    assert.deepEqual(actions[2]!.params, {
      key: "phase",
      scope: "session",
      value: "planning",
    });
    // note → planDoc → phase (preset static text + legacy preset toggles)
    assert.deepEqual(
      actions
        .filter((a) => a.type === "NodeActionPromptInject")
        .map((a) => (a.params as { source?: string }).source),
      ["note", "planDoc", "phase"],
    );
    const note = actions.find(
      (a) =>
        a.type === "NodeActionPromptInject" &&
        (a.params as { source?: string }).source === "note",
    )!.params as { note?: string };
    assert.match(note.note ?? "", /Plan checklist phase/);
  });

  it("moves PrepareRole.phaseOverlay onto PromptInject(note)", () => {
    const config = migrateFSMGraphConfig(
      createFSMGraphConfig({
        entryNodeId: "start",
        terminalNodeId: "end",
        nodes: [
          {
            id: "analyser",
            actions: [
              {
                type: "NodeActionPrepareRole",
                params: {
                  roleKind: "analyser",
                  phaseOverlay: "[Analyse phase]\nGather context.",
                },
              },
            ],
          },
          { id: "end", actions: [] },
        ],
        edges: [],
      }),
    );
    const actions = config.nodes.find((n) => n.id === "analyser")!.actions!;
    assert.equal(actions[1]!.type, "NodeActionSyncPlanStep");
    assert.equal(actions[2]!.type, "NodeActionPromptInject");
    assert.deepEqual(actions[2]!.params, {
      source: "note",
      note: "[Analyse phase]\nGather context.",
    });
    assert.deepEqual(actions[3]!.params, {
      source: "phase",
      placement: "system",
    });
  });

  it("expands legacy BuildNodeOverlay into a PromptInject sequence", () => {
    const config = migrateFSMGraphConfig(
      createFSMGraphConfig({
        entryNodeId: "start",
        terminalNodeId: "end",
        nodes: [
          {
            id: "executor",
            actions: [
              {
                type: "NodeActionBuildNodeOverlay",
                params: {
                  phaseOverlay: "[Execute phase]",
                  includePlanPhase: true,
                  includePlan: true,
                  includePlanDoc: true,
                  routeGuide: [
                    { when: "a step is blocked", routeTo: "step_blocked" },
                  ],
                },
              },
            ],
          },
          { id: "end", actions: [] },
        ],
        edges: [],
      }),
    );
    const actions = config.nodes.find((n) => n.id === "executor")!.actions!;
    // note → routeGuide → plan → planDoc → phase
    // (includePlanPhase alias-renamed to includePhase by PARAM_KEY_ALIASES)
    assert.deepEqual(
      actions.map((a) => ({
        type: a.type,
        params: a.params as Record<string, unknown>,
      })),
      [
        {
          type: "NodeActionPromptInject",
          params: { source: "note", note: "[Execute phase]" },
        },
        {
          type: "NodeActionPromptInject",
          params: {
            source: "routeGuide",
            placement: "system",
            routeGuide: [{ when: "a step is blocked", routeTo: "step_blocked" }],
          },
        },
        { type: "NodeActionPromptInject", params: { source: "plan" } },
        { type: "NodeActionPromptInject", params: { source: "planDoc" } },
        {
          type: "NodeActionPromptInject",
          params: { source: "phase", placement: "system" },
        },
      ],
    );
  });

  it("drops an empty legacy BuildNodeOverlay", () => {
    const config = migrateFSMGraphConfig(
      createFSMGraphConfig({
        entryNodeId: "start",
        terminalNodeId: "end",
        nodes: [
          { id: "agent", actions: [{ type: "NodeActionBuildNodeOverlay", params: {} }] },
          { id: "end", actions: [] },
        ],
        edges: [],
      }),
    );
    const actions = config.nodes.find((n) => n.id === "agent")!.actions!;
    assert.equal(actions.length, 0);
  });

  it("drops removed PreferSkills actions on migrate", () => {
    const config = migrateFSMGraphConfig(
      createFSMGraphConfig({
        entryNodeId: "start",
        terminalNodeId: "end",
        nodes: [
          {
            id: "agent",
            actions: [
              { type: "NodeActionPrepareRole", params: { roleKind: "agent" } },
              { type: "NodeActionPreferSkills", params: {} },
              { type: "NodeActionPrepareTools", params: {} },
            ],
          },
          { id: "start", actions: [] },
          { id: "end", actions: [] },
        ],
        edges: [],
      }),
    );
    const types = (
      config.nodes.find((n) => n.id === "agent")?.actions ?? []
    ).map((a) => a.type);
    assert.deepEqual(types, [
      "NodeActionPrepareRole",
      "NodeActionSyncPlanStep",
      "NodeActionPrepareTools",
    ]);
  });

  it("inserts EmitRouteEvent after ApplyToolEffects; drops reactToRouteEvent ApplyPlanEffects", () => {
    const reactConfig = migrateFSMGraphConfig(
      createFSMGraphConfig({
        entryNodeId: "start",
        terminalNodeId: "end",
        nodes: [
          {
            id: "agent",
            actions: [
              { type: "NodeActionApplyToolEffects", params: {} },
              { type: "NodeActionRouteTo", params: {} },
            ],
          },
          { id: "start", actions: [] },
          { id: "end", actions: [] },
        ],
        edges: [],
      }),
    );
    assert.deepEqual(
      (reactConfig.nodes.find((n) => n.id === "agent")?.actions ?? []).map(
        (a) => a.type,
      ),
      [
        "NodeActionApplyToolEffects",
        "NodeActionEmitRouteEvent",
        "NodeActionRouteTo",
      ],
    );

    const plannerConfig = migrateFSMGraphConfig(
      createFSMGraphConfig({
        entryNodeId: "start",
        terminalNodeId: "end",
        nodes: [
          {
            id: "planner",
            actions: [
              { type: "NodeActionApplyToolEffects", params: {} },
              { type: "NodeActionEmitRouteEvent", params: {} },
              { type: "NodeActionRouteTo", params: {} },
            ],
          },
          { id: "start", actions: [] },
          { id: "end", actions: [] },
        ],
        edges: [],
      }),
    );
    assert.deepEqual(
      (plannerConfig.nodes.find((n) => n.id === "planner")?.actions ?? []).map(
        (a) => a.type,
      ),
      [
        "NodeActionApplyToolEffects",
        "NodeActionEmitRouteEvent",
        "NodeActionRouteTo",
      ],
    );

    const planConfig = migrateFSMGraphConfig(
      createFSMGraphConfig({
        entryNodeId: "start",
        terminalNodeId: "end",
        nodes: [
          {
            id: "analyser",
            actions: [
              { type: "NodeActionApplyToolEffects", params: {} },
              {
                type: "NodeActionApplyPlanEffects",
                params: { reactToRouteEvent: true },
              },
              { type: "NodeActionAwaitSubagents", params: {} },
            ],
          },
          { id: "plan_writer", actions: [] },
          { id: "start", actions: [] },
          { id: "end", actions: [] },
        ],
        edges: [],
      }),
    );
    const analyser = planConfig.nodes.find((n) => n.id === "analyser")!.actions!;
    assert.deepEqual(
      analyser.map((a) => a.type),
      [
        "NodeActionApplyToolEffects",
        "NodeActionEmitRouteEvent",
        "NodeActionAwaitSubagents",
      ],
    );
  });

  it("drops legacy ApplyPlanEffects ensureInProgress (handled at load + update_plan)", () => {
    const config = migrateFSMGraphConfig(
      createFSMGraphConfig({
        entryNodeId: "start",
        terminalNodeId: "end",
        nodes: [
          {
            id: "executor",
            actions: [
              {
                type: "NodeActionApplyPlanEffects",
                params: { ensureInProgress: true },
              },
            ],
          },
          { id: "start", actions: [] },
          { id: "end", actions: [] },
        ],
        edges: [],
      }),
    );
    assert.deepEqual(
      (config.nodes.find((n) => n.id === "executor")?.actions ?? []).map(
        (a) => a.type,
      ),
      [],
    );
  });

  it("strips retired NodeActionEnsurePlanInProgress from saved graphs", () => {
    const config = migrateFSMGraphConfig(
      createFSMGraphConfig({
        entryNodeId: "start",
        terminalNodeId: "end",
        nodes: [
          {
            id: "executor",
            actions: [
              { type: "NodeActionSetPhase", params: { phase: "executing" } },
              { type: "NodeActionEnsurePlanInProgress", params: {} },
            ],
          },
          { id: "start", actions: [] },
          { id: "end", actions: [] },
        ],
        edges: [],
      }),
    );
    assert.deepEqual(
      (config.nodes.find((n) => n.id === "executor")?.actions ?? []).map(
        (a) => a.type,
      ),
      ["NodeActionWriteBlackboard"],
    );
    assert.deepEqual(
      config.nodes.find((n) => n.id === "executor")?.actions?.[0]?.params,
      { key: "phase", scope: "session", value: "executing" },
    );
  });
});
