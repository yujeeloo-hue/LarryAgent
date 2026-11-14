import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PlanStep, SessionPlan } from "../../session/types.js";
import { ToolReturnCode } from "../../session/returnCodes.js";
import type { ToolExecuteContext, ToolExecuteResult } from "../types.js";
import { updatePlanHandler } from "./updatePlan.js";

function plan(steps: PlanStep[]): SessionPlan {
  return {
    id: "p1",
    title: "Serial plan",
    status: "active",
    steps,
    createdAt: 1,
    updatedAt: 1,
    createToolCallId: "create-1",
  };
}

function context(planSnapshot: SessionPlan): ToolExecuteContext {
  return {
    workspacePath: "/tmp/ws",
    fullPermissionsEnabled: true,
    planSnapshot,
  };
}

function updatedPlan(result: ToolExecuteResult): SessionPlan {
  assert.ok(result.sessionPatch?.plan);
  return result.sessionPatch.plan;
}

function resultText(result: ToolExecuteResult): string {
  return result.content
    .filter((part) => part.type === "text")
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n");
}

describe("update_plan serial progression", () => {
  it("completes the current step and starts the next ready step automatically", async () => {
    const result = await updatePlanHandler(
      { steps: [{ id: "s1", status: "completed" }] },
      context(
        plan([
          { id: "s1", title: "First", status: "in_progress" },
          {
            id: "s2",
            title: "Second",
            status: "pending",
            dependsOn: ["s1"],
          },
        ]),
      ),
    );

    assert.equal(result.returnCode, ToolReturnCode.Success);
    assert.deepEqual(
      updatedPlan(result).steps.map((step) => [step.id, step.status]),
      [
        ["s1", "completed"],
        ["s2", "in_progress"],
      ],
    );
  });

  it("applies complete + start transactionally regardless of argument order", async () => {
    const result = await updatePlanHandler(
      {
        steps: [
          { id: "s2", status: "in_progress" },
          { id: "s1", status: "completed" },
        ],
      },
      context(
        plan([
          { id: "s1", title: "First", status: "in_progress" },
          {
            id: "s2",
            title: "Second",
            status: "pending",
            dependsOn: ["s1"],
          },
        ]),
      ),
    );

    assert.equal(result.returnCode, ToolReturnCode.Success);
    assert.deepEqual(
      updatedPlan(result).steps.map((step) => step.status),
      ["completed", "in_progress"],
    );
  });

  it("atomically completes a ready pending step in a legacy idle plan", async () => {
    const result = await updatePlanHandler(
      { steps: [{ id: "s1", status: "completed" }] },
      context(
        plan([
          { id: "s1", title: "First", status: "pending" },
          {
            id: "s2",
            title: "Second",
            status: "pending",
            dependsOn: ["s1"],
          },
        ]),
      ),
    );

    assert.equal(result.returnCode, ToolReturnCode.Success);
    assert.deepEqual(
      updatedPlan(result).steps.map((step) => step.status),
      ["completed", "in_progress"],
    );
  });

  it("rejects completing more than one unfinished step", async () => {
    const result = await updatePlanHandler(
      {
        steps: [
          { id: "s1", status: "completed" },
          { id: "s2", status: "completed" },
        ],
      },
      context(
        plan([
          { id: "s1", title: "First", status: "in_progress" },
          {
            id: "s2",
            title: "Second",
            status: "pending",
            dependsOn: ["s1"],
          },
        ]),
      ),
    );

    assert.equal(result.returnCode, ToolReturnCode.InvalidArguments);
    assert.equal(result.sessionPatch, undefined);
    assert.match(resultText(result), /complete only one unfinished step/i);
    assert.match(resultText(result), /"s1","status":"completed"/);
  });

  it("explains how to advance when a later step is started too early", async () => {
    const result = await updatePlanHandler(
      { steps: [{ id: "s2", status: "in_progress" }] },
      context(
        plan([
          { id: "s1", title: "First", status: "in_progress" },
          {
            id: "s2",
            title: "Second",
            status: "pending",
            dependsOn: ["s1"],
          },
        ]),
      ),
    );

    assert.equal(result.returnCode, ToolReturnCode.InvalidArguments);
    assert.match(resultText(result), /cannot start "s2" while "s1" is in_progress/i);
    assert.match(resultText(result), /next ready step starts automatically/i);
  });

});
