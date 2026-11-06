import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NodeActionPromptInject } from "./NodeActionPromptInject.js";
import type { RoleIterationSpec } from "../../roles/types.js";

const baseSpec = {
  roleKind: "planner" as const,
  personaLabel: "PLANNER" as const,
  roleSystemPrompt: "body",
  includeSkills: false,
};

const hostWith = (session: Record<string, unknown>) =>
  ({
    session,
    gate: {},
    createId: () => "id",
    resetTurnBudgets: () => {},
  }) as never;

describe("NodeActionPromptInject", () => {
  it("no-ops when the note is empty", () => {
    const action = new NodeActionPromptInject({ source: "note" });
    const result = action.Exec({
      turnContext: {},
      nodeContext: { iterationSpec: { ...baseSpec, phaseOverlay: "static" } },
    });
    assert.equal(result.status, "continue");
    assert.equal(result.nodeContextPatch, undefined);
  });

  it("applies the visit note without host", () => {
    const action = new NodeActionPromptInject({
      source: "note",
      note: "[Analyse phase]",
    });
    const result = action.Exec({
      turnContext: {},
      nodeContext: { iterationSpec: { ...baseSpec } },
    });
    assert.equal(result.status, "continue");
    const spec = result.nodeContextPatch?.iterationSpec as RoleIterationSpec;
    assert.equal(spec.phaseOverlay, "[Analyse phase]");
  });

  it("creates a minimal agent spec when iterationSpec is absent", () => {
    const action = new NodeActionPromptInject({
      source: "note",
      note: "bare node",
    });
    const result = action.Exec({ turnContext: {}, nodeContext: {} });
    const spec = result.nodeContextPatch?.iterationSpec as RoleIterationSpec;
    assert.equal(spec.roleKind, "agent");
    assert.equal(spec.phaseOverlay, "bare node");
  });

  it("stacks planDoc on overlay and phase on systemInject", () => {
    const nodeContext: Record<string, unknown> = {
      iterationSpec: { ...baseSpec, phaseOverlay: "[Plan checklist phase]" },
    };
    const doc = new NodeActionPromptInject({ source: "planDoc" });
    const docResult = doc.Exec({
      turnContext: {
        turnScope: {
          turnState: { pendingPlanDraft: undefined },
          plan: { get: () => null },
        },
      },
      nodeContext,
      host: hostWith({
        planDoc: { path: "/ws/docs/plans/a.md", summary: "Ship it", updatedAt: 1 },
      }),
    });
    Object.assign(nodeContext, docResult.nodeContextPatch);

    const phase = new NodeActionPromptInject({
      source: "phase",
      placement: "system",
    });
    const phaseResult = phase.Exec({
      turnContext: { turnScope: { turnState: {}, plan: { get: () => null } } },
      nodeContext,
      host: hostWith({ phase: "executing" }),
    });

    const spec = phaseResult.nodeContextPatch?.iterationSpec as RoleIterationSpec;
    const overlay = spec.phaseOverlay ?? "";
    assert.match(overlay, /\[Plan checklist phase\]/);
    assert.match(overlay, /Plan doc: \/ws\/docs\/plans\/a\.md/);
    assert.match(overlay, /Summary: Ship it/);
    assert.doesNotMatch(overlay, /Phase: executing/);
    assert.equal(spec.systemInject, "Phase: executing");
  });

  it("plan frontier omits completed step titles", () => {
    const action = new NodeActionPromptInject({ source: "plan" });
    const result = action.Exec({
      turnContext: {
        turnScope: {
          turnState: { pendingPlanDraft: undefined },
          plan: { get: () => null },
        },
      },
      nodeContext: { iterationSpec: { ...baseSpec } },
      host: hostWith({
        plan: {
          id: "p1",
          title: "Ship auth",
          status: "active",
          steps: [
            { id: "s1", title: "Read module", status: "completed" },
            { id: "s2", title: "Patch store", status: "in_progress" },
            { id: "s3", title: "Add tests", status: "pending", dependsOn: ["s2"] },
          ],
          createdAt: 1,
          updatedAt: 1,
          createToolCallId: "tc1",
        },
      }),
    });
    const spec = result.nodeContextPatch?.iterationSpec as RoleIterationSpec;
    const overlay = spec.phaseOverlay ?? "";
    assert.match(overlay, /Plan: "Ship auth"/);
    assert.match(overlay, /Progress: 1\/3 completed, 2 remaining/);
    assert.match(overlay, /Now: s2 — Patch store/);
    assert.match(overlay, /Next: s3 — Add tests/);
    assert.doesNotMatch(overlay, /Read module/);
  });

  it("routeGuide renders fsm_route rows", () => {
    const action = new NodeActionPromptInject({
      source: "routeGuide",
      placement: "system",
      routeGuide: [
        { when: "the plan is ready", routeTo: "ready" },
        { when: "", routeTo: "dropped" },
        "not-an-object",
      ],
    });
    const result = action.Exec({
      turnContext: {},
      nodeContext: { iterationSpec: { ...baseSpec } },
    });
    const spec = result.nodeContextPatch?.iterationSpec as RoleIterationSpec;
    assert.match(spec.systemInject ?? "", /## FSM routes/);
    assert.match(
      spec.systemInject ?? "",
      /- When the plan is ready: call fsm_route with route="ready"/,
    );
    assert.doesNotMatch(spec.systemInject ?? "", /dropped/);
  });

  it("same source twice on one node is a no-op the second time", () => {
    const nodeContext: Record<string, unknown> = {
      iterationSpec: { ...baseSpec },
    };
    const first = new NodeActionPromptInject({
      source: "note",
      note: "only once",
    });
    const firstResult = first.Exec({ turnContext: {}, nodeContext });
    Object.assign(nodeContext, firstResult.nodeContextPatch);

    const second = new NodeActionPromptInject({
      source: "note",
      note: "must not appear",
    });
    const secondResult = second.Exec({ turnContext: {}, nodeContext });
    assert.equal(secondResult.nodeContextPatch, undefined);

    const spec = nodeContext.iterationSpec as RoleIterationSpec;
    assert.doesNotMatch(spec.phaseOverlay ?? "", /must not appear/);
  });

  it("live sources no-op without a host (stub path)", () => {
    for (const source of ["plan", "planDoc", "pendingPlanDraft", "phase"]) {
      const action = new NodeActionPromptInject({ source });
      const result = action.Exec({
        turnContext: {},
        nodeContext: { iterationSpec: { ...baseSpec } },
      });
      assert.equal(result.nodeContextPatch, undefined, source);
    }
  });

  describe("blackboard source", () => {
    const blackboardHost = (store: Record<string, unknown>) =>
      ({
        session: {},
        gate: {},
        createId: () => "id",
        resetTurnBudgets: () => {},
        blackboardGet: (key: string) => store[key],
      }) as never;

    it("reads a session key via host.blackboardGet", () => {
      const action = new NodeActionPromptInject({
        source: "blackboard",
        key: "focus",
        scope: "session",
      });
      const result = action.Exec({
        turnContext: {},
        nodeContext: { iterationSpec: { ...baseSpec } },
        host: blackboardHost({ focus: "auth module" }),
      });
      const spec = result.nodeContextPatch?.iterationSpec as RoleIterationSpec;
      assert.equal(
        spec.phaseOverlay,
        "[Blackboard — focus]\nauth module",
      );
    });

    it("reads a turn key from turnContext and formats objects as JSON", () => {
      const action = new NodeActionPromptInject({
        source: "blackboard",
        key: "hits",
        scope: "turn",
      });
      const result = action.Exec({
        turnContext: { hits: { total: 3 } },
        nodeContext: { iterationSpec: { ...baseSpec } },
        host: blackboardHost({}),
      });
      const spec = result.nodeContextPatch?.iterationSpec as RoleIterationSpec;
      assert.equal(spec.phaseOverlay, '[Blackboard — hits]\n{"total":3}');
    });

    it("supports a custom heading via label", () => {
      const action = new NodeActionPromptInject({
        source: "blackboard",
        key: "k1",
        label: "Search focus",
      });
      const result = action.Exec({
        turnContext: {},
        nodeContext: { iterationSpec: { ...baseSpec } },
        host: blackboardHost({ k1: "v" }),
      });
      const spec = result.nodeContextPatch?.iterationSpec as RoleIterationSpec;
      assert.match(spec.phaseOverlay ?? "", /\[Blackboard — Search focus\]/);
    });

    it("no-ops on missing key, empty key, or missing capability", () => {
      const missing = new NodeActionPromptInject({
        source: "blackboard",
        key: "nope",
      });
      assert.equal(
        missing.Exec({
          turnContext: {},
          nodeContext: { iterationSpec: { ...baseSpec } },
          host: blackboardHost({}),
        }).nodeContextPatch,
        undefined,
      );
      const noKey = new NodeActionPromptInject({ source: "blackboard" });
      assert.equal(
        noKey.Exec({
          turnContext: {},
          nodeContext: { iterationSpec: { ...baseSpec } },
          host: blackboardHost({ k: 1 }),
        }).nodeContextPatch,
        undefined,
      );
      const noHost = new NodeActionPromptInject({
        source: "blackboard",
        key: "k",
      });
      assert.equal(
        noHost.Exec({
          turnContext: { k: undefined },
          nodeContext: { iterationSpec: { ...baseSpec } },
        }).nodeContextPatch,
        undefined,
      );
    });

    it("guards per scope+key: different keys stack, same key dedups", () => {
      const nodeContext: Record<string, unknown> = {
        iterationSpec: { ...baseSpec },
      };
      const first = new NodeActionPromptInject({
        source: "blackboard",
        key: "a",
      });
      Object.assign(
        nodeContext,
        first.Exec({ turnContext: {}, nodeContext, host: blackboardHost({ a: "1" }) })
          .nodeContextPatch,
      );
      const second = new NodeActionPromptInject({
        source: "blackboard",
        key: "b",
      });
      const secondResult = second.Exec({
        turnContext: {},
        nodeContext,
        host: blackboardHost({ b: "2" }),
      });
      Object.assign(nodeContext, secondResult.nodeContextPatch);
      const dup = new NodeActionPromptInject({
        source: "blackboard",
        key: "a",
      });
      assert.equal(
        dup.Exec({
          turnContext: {},
          nodeContext,
          host: blackboardHost({ a: "again" }),
        }).nodeContextPatch,
        undefined,
      );

      const spec = nodeContext.iterationSpec as RoleIterationSpec;
      const overlay = spec.phaseOverlay ?? "";
      assert.match(overlay, /\[Blackboard — a\]\n1/);
      assert.match(overlay, /\[Blackboard — b\]\n2/);
      assert.doesNotMatch(overlay, /again/);
    });
  });

  it("placement=system writes systemInject and leaves phaseOverlay alone", () => {
    const action = new NodeActionPromptInject({
      source: "note",
      note: "[System note]",
      placement: "system",
    });
    const result = action.Exec({
      turnContext: {},
      nodeContext: { iterationSpec: { ...baseSpec, phaseOverlay: "keep me" } },
    });
    const spec = result.nodeContextPatch?.iterationSpec as RoleIterationSpec;
    assert.equal(spec.systemInject, "[System note]");
    assert.equal(spec.phaseOverlay, "keep me");
  });

  it("placement=overlay still writes phaseOverlay by default", () => {
    const action = new NodeActionPromptInject({
      source: "note",
      note: "[Overlay note]",
    });
    const result = action.Exec({
      turnContext: {},
      nodeContext: { iterationSpec: { ...baseSpec } },
    });
    const spec = result.nodeContextPatch?.iterationSpec as RoleIterationSpec;
    assert.equal(spec.phaseOverlay, "[Overlay note]");
    assert.equal(spec.systemInject, undefined);
  });

  it("frequency=oncePerNode skips re-inject on the same nodeId across visits", () => {
    const action = new NodeActionPromptInject({
      source: "note",
      note: "once only",
      frequency: "oncePerNode",
      placement: "overlay",
    });
    const turnContext: Record<string, unknown> = {};
    const first = action.Exec({
      turnContext,
      nodeContext: { iterationSpec: { ...baseSpec } },
      nodeId: "analyser",
    });
    Object.assign(turnContext, first.turnContextPatch);
    const firstSpec = first.nodeContextPatch?.iterationSpec as RoleIterationSpec;
    assert.equal(firstSpec.phaseOverlay, "once only");

    const second = action.Exec({
      turnContext,
      nodeContext: { iterationSpec: { ...baseSpec } },
      nodeId: "analyser",
    });
    assert.equal(second.nodeContextPatch, undefined);

    const otherNode = action.Exec({
      turnContext,
      nodeContext: { iterationSpec: { ...baseSpec } },
      nodeId: "executor",
    });
    const otherSpec = otherNode.nodeContextPatch?.iterationSpec as RoleIterationSpec;
    assert.equal(otherSpec.phaseOverlay, "once only");
  });

  it("frequency=everyRound re-injects after nodeContext reset (self-loop)", () => {
    const action = new NodeActionPromptInject({
      source: "note",
      note: "each round",
      frequency: "everyRound",
    });
    const first = action.Exec({
      turnContext: {},
      nodeContext: { iterationSpec: { ...baseSpec } },
      nodeId: "analyser",
    });
    assert.equal(
      (first.nodeContextPatch?.iterationSpec as RoleIterationSpec).phaseOverlay,
      "each round",
    );
    const second = action.Exec({
      turnContext: {},
      nodeContext: { iterationSpec: { ...baseSpec } },
      nodeId: "analyser",
    });
    assert.equal(
      (second.nodeContextPatch?.iterationSpec as RoleIterationSpec).phaseOverlay,
      "each round",
    );
  });

  it("placement=system ignores oncePerNode and re-injects every visit", () => {
    const action = new NodeActionPromptInject({
      source: "note",
      note: "system every round",
      placement: "system",
      frequency: "oncePerNode",
    });
    const turnContext: Record<string, unknown> = {};
    const first = action.Exec({
      turnContext,
      nodeContext: { iterationSpec: { ...baseSpec } },
      nodeId: "analyser",
    });
    Object.assign(turnContext, first.turnContextPatch ?? {});
    assert.equal(
      (first.nodeContextPatch?.iterationSpec as RoleIterationSpec).systemInject,
      "system every round",
    );
    assert.equal(first.turnContextPatch?.promptInjectedOnce, undefined);

    const second = action.Exec({
      turnContext,
      nodeContext: { iterationSpec: { ...baseSpec } },
      nodeId: "analyser",
    });
    assert.equal(
      (second.nodeContextPatch?.iterationSpec as RoleIterationSpec).systemInject,
      "system every round",
    );
  });
});
