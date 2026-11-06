import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NodeActionRoleRoundBuilder } from "./NodeActionRoleRoundBuilder.js";
import type { RoleIterationSpec } from "../../roles/types.js";
import type { FsmHostCapabilities } from "../FsmHostCapabilities.js";
import { makeFakeHost, makeScope, makeSession } from "../graphScenariosFixtures.js";

describe("NodeActionRoleRoundBuilder", () => {
  it("forwards Call model settings from the default round to the streaming host", async () => {
    const action = new NodeActionRoleRoundBuilder({
      callModel: { disableReasoning: true, waitingMessage: "Reviewing the answer…" },
      routeTo: { routes: [{ event: "leave", to: "done" }] },
    });
    const callModel = action.getChildren().find((child) => child.type === "NodeActionCallModel")!;
    const session = makeSession();
    const scope = makeScope(session, "agent");
    const { host } = makeFakeHost({ session, rounds: [{ text: "Reviewed." }] });
    const captured: Parameters<FsmHostCapabilities["streamModelRound"]>[0][] = [];
    const streamModelRound = host.streamModelRound;
    host.streamModelRound = async (input) => {
      captured.push(input);
      return streamModelRound(input);
    };

    const result = await callModel.Exec({
      host,
      turnContext: { turnScope: scope },
      nodeContext: { messages: [], tools: [] },
    });

    assert.equal(result.status, "continue");
    assert.equal(captured.length, 1);
    assert.equal(captured[0]!.progressText, "Reviewing the answer…");
    assert.equal(captured[0]!.llm.client.disableReasoning, true);
    assert.equal(scope.llmBundle.sessionDefault.client.disableReasoning, undefined);
  });

  it("keeps Call model defaults when the optional settings are omitted", async () => {
    const action = new NodeActionRoleRoundBuilder({
      routeTo: { routes: [{ event: "leave", to: "done" }] },
    });
    const callModel = action.getChildren().find((child) => child.type === "NodeActionCallModel")!;
    const result = await callModel.Exec({ turnContext: {}, nodeContext: {} });
    assert.equal(result.status, "continue");
    assert.equal(result.nodeContextPatch!.progressLabel, "Waiting for model…");
  });

  it("requires explicit routing before running a default round", async () => {
    const result = await new NodeActionRoleRoundBuilder({ roleKind: "planner" })
      .Exec({ turnContext: {}, nodeContext: {} });
    assert.equal(result.status, "halt");
    assert.match(result.errorMessage!, /explicit routeTo/);
    const missingPin = await new NodeActionRoleRoundBuilder({
      detectStepClaim: true,
      routeTo: { routes: [{ event: "leave", to: "done" }] },
    }).Exec({ turnContext: {}, nodeContext: {} });
    assert.equal(missingPin.status, "halt");
    assert.match(missingPin.errorMessage!, /explicit onStepClaim/);
  });

  it("forwards explicit settings without deriving step state or routing from role identity", async () => {
    for (const roleKind of ["planner", "executor", "reviewer"]) {
      const action = new NodeActionRoleRoundBuilder({
        roleKind,
        prepareRole: {
          personaLabel: "REVIEW", rolePromptInline: "Review the change.",
          promptPlacement: "overlay", modelBinding: "sessionDefault",
        },
        prepareTools: { toolPolicy: "subagent_explore", useOfferSet: false },
        awaitSubagents: false,
        routeTo: { routes: [{ event: "leave", to: "review_done" }] },
      });
      const result = await action.Exec({ turnContext: {}, nodeContext: {} });
      assert.equal(result.status, "continue");
      const patch = result.nodeContextPatch!;
      const spec = patch.iterationSpec as RoleIterationSpec;
      assert.equal(spec.roleKind, roleKind);
      assert.equal(spec.personaLabel, "REVIEW");
      assert.equal(spec.promptPlacement, "overlay");
      assert.match(spec.roleSystemPrompt, /^\[REVIEW\]\nReview the change\./);
      assert.equal(patch.toolPolicy, "subagent_explore");
      assert.equal(patch.useOfferSet, false);
      assert.equal(patch.currentStepId, undefined);
      assert.equal(patch.routeTarget, "review_done");
    }
  });

  it("runs explicit child steps sequentially on the stub path", async () => {
    const action = new NodeActionRoleRoundBuilder({
      steps: [
        { type: "NodeActionRoundGate", params: {} },
        { type: "NodeActionEmitRouteEvent", params: {} },
      ],
    });
    const result = await action.Exec({
      turnContext: {},
      nodeContext: {},
    });
    assert.equal(result.status, "continue");
  });

  it("halts when an inner step halts", async () => {
    const action = new NodeActionRoleRoundBuilder({
      steps: [
        {
          type: "NodeActionRouteTo",
          params: { routes: [{ event: "leave", to: "skill_reflect_gate" }] },
        },
      ],
    });
    // No stay binding + tools ran → the fallback has nowhere to go.
    const result = await action.Exec({
      turnContext: {},
      nodeContext: { toolsRan: true },
    });
    assert.equal(result.status, "halt");
  });
});
