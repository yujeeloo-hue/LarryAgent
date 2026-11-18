import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PlanStep, SessionPlan } from "../../session/types.js";
import { ToolReturnCode } from "../../session/returnCodes.js";
import type { ToolExecuteContext, ToolExecuteResult } from "../types.js";
import { updatePlanDefinition, updatePlanHandler } from "./updatePlan.js";

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

  it("completes a contiguous run from the current step in one call", async () => {
    const result = await updatePlanHandler(
      {
        steps: [
          { id: "s3", status: "completed", title: "Nope" },
          { id: "s1", status: "completed", title: "Renamed" },
          { id: "s2", status: "completed" },
          { id: "s4", status: "in_progress" },
        ],
      },
      context(
        plan([
          { id: "s1", title: "First", status: "in_progress" },
          { id: "s2", title: "Second", status: "pending", dependsOn: ["s1"] },
          { id: "s3", title: "Third", status: "pending", dependsOn: ["s2"] },
          { id: "s4", title: "Fourth", status: "pending", dependsOn: ["s3"] },
        ]),
      ),
    );

    assert.equal(result.returnCode, ToolReturnCode.Success);
    const next = updatedPlan(result);
    assert.deepEqual(
      next.steps.map((step) => [step.id, step.status, step.title]),
      [
        ["s1", "completed", "Renamed"],
        ["s2", "completed", "Second"],
        ["s3", "completed", "Nope"],
        ["s4", "in_progress", "Fourth"],
      ],
    );
    const text = resultText(result);
    assert.match(text, /^Completed s1, s2, s3\./);
    assert.match(text, /s4 is now in_progress/);
    assert.doesNotMatch(text, /Did not start/);
    assert.equal(result.routeEvent?.event, "plan_resume");
  });

  it("starts the real next step when a batch names a later one", async () => {
    const result = await updatePlanHandler(
      {
        steps: [
          { id: "s1", status: "completed" },
          { id: "s2", status: "completed" },
          { id: "s4", status: "in_progress" },
        ],
      },
      context(
        plan([
          { id: "s1", title: "First", status: "in_progress" },
          { id: "s2", title: "Second", status: "pending", dependsOn: ["s1"] },
          { id: "s3", title: "Third", status: "pending", dependsOn: ["s2"] },
          { id: "s4", title: "Fourth", status: "pending", dependsOn: ["s3"] },
        ]),
      ),
    );

    assert.equal(result.returnCode, ToolReturnCode.Success);
    assert.deepEqual(
      updatedPlan(result).steps.map((step) => [step.id, step.status]),
      [
        ["s1", "completed"],
        ["s2", "completed"],
        ["s3", "in_progress"],
        ["s4", "pending"],
      ],
    );
    assert.match(resultText(result), /Completed s1, s2\./);
    assert.match(resultText(result), /Did not start s4\./);
    assert.match(resultText(result), /s3 is now in_progress/);
  });

  it("rejects a completion list that skips the current step", async () => {
    const result = await updatePlanHandler(
      {
        steps: [
          { id: "s2", status: "completed" },
          { id: "s3", status: "completed" },
        ],
      },
      context(
        plan([
          { id: "s1", title: "First", status: "in_progress" },
          { id: "s2", title: "Second", status: "pending", dependsOn: ["s1"] },
          { id: "s3", title: "Third", status: "pending", dependsOn: ["s2"] },
        ]),
      ),
    );

    assert.equal(result.returnCode, ToolReturnCode.InvalidArguments);
    assert.equal(result.sessionPatch, undefined);
    assert.match(
      resultText(result),
      /^Invalid arguments: Send only \{"steps":\[\{"id":"s1","status":"completed"\}\]\}, or a contiguous run of completions starting at s1\. Leave s2, s3 unchanged/,
    );
  });

  it("rejects a completion list that skips a middle step", async () => {
    const result = await updatePlanHandler(
      {
        steps: [
          { id: "s1", status: "completed" },
          { id: "s3", status: "completed" },
        ],
      },
      context(
        plan([
          { id: "s1", title: "First", status: "in_progress" },
          { id: "s2", title: "Second", status: "pending", dependsOn: ["s1"] },
          { id: "s3", title: "Third", status: "pending", dependsOn: ["s2"] },
        ]),
      ),
    );

    assert.equal(result.returnCode, ToolReturnCode.InvalidArguments);
    assert.equal(result.sessionPatch, undefined);
    assert.match(resultText(result), /Send only \{"steps":\[\{"id":"s1","status":"completed"\}\]\}/);
    assert.match(resultText(result), /Leave s3 unchanged — the list skips a step/);
  });

  it("leads with the current step when a later step is completed", async () => {
    const result = await updatePlanHandler(
      { steps: [{ id: "s2", status: "completed" }] },
      context(
        plan([
          { id: "s1", title: "First", status: "in_progress" },
          { id: "s2", title: "Second", status: "pending", dependsOn: ["s1"] },
        ]),
      ),
    );

    assert.equal(result.returnCode, ToolReturnCode.InvalidArguments);
    assert.match(
      resultText(result),
      /^Invalid arguments: Send only \{"steps":\[\{"id":"s1","status":"completed"\}\]\}\. Leave "s2" unchanged while "s1" is in_progress/,
    );
  });

  it("keeps a cancelled gap out of a fast-forward prefix", async () => {
    const result = await updatePlanHandler(
      {
        steps: [
          { id: "s1", status: "completed" },
          { id: "s3", status: "completed" },
        ],
      },
      context(
        plan([
          { id: "s1", title: "First", status: "in_progress" },
          { id: "s2", title: "Skipped", status: "cancelled" },
          { id: "s3", title: "Third", status: "pending", dependsOn: ["s1"] },
        ]),
      ),
    );

    assert.equal(result.returnCode, ToolReturnCode.Success);
    assert.deepEqual(
      updatedPlan(result).steps.map((step) => [step.id, step.status]),
      [
        ["s1", "completed"],
        ["s2", "cancelled"],
        ["s3", "completed"],
      ],
    );
    assert.match(resultText(result), /^Completed s1, s3\./);
    assert.equal(result.routeEvent, undefined);
  });

  it("rejects a batch that still waits on a step outside the run", async () => {
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
            dependsOn: ["s1", "other"],
          },
        ]),
      ),
    );

    assert.equal(result.returnCode, ToolReturnCode.InvalidArguments);
    assert.equal(result.sessionPatch, undefined);
    assert.match(resultText(result), /cannot complete "s2"/);
    assert.match(resultText(result), /other \(missing\)/);
  });

  it("rejects a batch that also cancels another step", async () => {
    const result = await updatePlanHandler(
      {
        steps: [
          { id: "s1", status: "completed" },
          { id: "s2", status: "completed" },
          { id: "s3", status: "cancelled" },
        ],
      },
      context(
        plan([
          { id: "s1", title: "First", status: "in_progress" },
          { id: "s2", title: "Second", status: "pending", dependsOn: ["s1"] },
          { id: "s3", title: "Third", status: "pending", dependsOn: ["s2"] },
        ]),
      ),
    );

    assert.equal(result.returnCode, ToolReturnCode.InvalidArguments);
    assert.equal(result.sessionPatch, undefined);
  });

  it("describes a contiguous batch completion", () => {
    assert.match(updatePlanDefinition.description, /contiguous run of steps/);
    assert.match(updatePlanDefinition.description, /Do not skip steps/);
    assert.match(
      JSON.stringify(updatePlanDefinition.parameters),
      /contiguous run of completions from that step/,
    );
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
