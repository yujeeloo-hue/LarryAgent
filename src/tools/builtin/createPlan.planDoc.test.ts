import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPlanDefinition, createPlanHandler } from "./createPlan.js";
import { ToolReturnCode } from "../../session/returnCodes.js";
import type { ToolExecuteContext } from "../types.js";

describe("create_plan planDoc gate", () => {
  it("exposes a serial string checklist — no dependsOn in the schema", () => {
    const json = JSON.stringify(createPlanDefinition);
    assert.equal(json.includes("dependsOn"), false);
    const steps = (
      createPlanDefinition.parameters as {
        properties?: { steps?: { items?: { type?: string } } };
      }
    ).properties?.steps;
    assert.equal(steps?.items?.type, "string");
  });
  it("rejects create_plan when requirePlanDocForCreatePlan and no planDoc", async () => {
    const result = await createPlanHandler(
      { title: "T", steps: ["One", "Two"] },
      {
        workspacePath: "/tmp/ws",
        fullPermissionsEnabled: true,
        toolCallId: "c1",
        requirePlanDocForCreatePlan: true,
        planDocSnapshot: null,
      } satisfies ToolExecuteContext,
    );
    assert.equal(result.returnCode, ToolReturnCode.InvalidArguments);
    assert.ok(
      result.content.some(
        (p) =>
          p.type === "text" &&
          p.text.includes("write_plan_doc"),
      ),
    );
  });

  it("allows create_plan when planDoc is present and links the plan to the doc", async () => {
    const result = await createPlanHandler(
      { title: "T", steps: ["One", "Two"] },
      {
        workspacePath: "/tmp/ws",
        fullPermissionsEnabled: true,
        toolCallId: "c1",
        requirePlanDocForCreatePlan: true,
        planDocSnapshot: {
          path: "/tmp/ws/docs/plans/x.md",
          summary: "ok",
          updatedAt: 1,
        },
      } satisfies ToolExecuteContext,
    );
    assert.equal(result.returnCode, ToolReturnCode.Success);
    assert.ok(result.sessionPatch?.plan);
    const created = result.sessionPatch.plan;
    assert.deepEqual(created.planDoc, {
      path: "/tmp/ws/docs/plans/x.md",
      summary: "ok",
    });
    assert.deepEqual(
      created.steps.map((step) => step.status),
      ["in_progress", "pending"],
    );
  });

  it("creates a plan without a doc ref when no planDoc snapshot exists", async () => {
    for (const planDocSnapshot of [
      undefined,
      null,
      { path: "  ", summary: "s", updatedAt: 1 },
    ] as Array<import("../../session/types.js").SessionPlanDoc | null | undefined>) {
      const result = await createPlanHandler(
        { title: "T", steps: ["One", "Two"] },
        {
          workspacePath: "/tmp/ws",
          fullPermissionsEnabled: true,
          toolCallId: "c1",
          ...(planDocSnapshot === undefined
            ? {}
            : { planDocSnapshot }),
        } satisfies ToolExecuteContext,
      );
      assert.equal(result.returnCode, ToolReturnCode.Success);
      const created = result.sessionPatch?.plan;
      assert.ok(created);
      assert.equal(created.planDoc, undefined);
    }
  });

  it("rejects object steps (serial string[] only)", async () => {
    const result = await createPlanHandler(
      {
        title: "T",
        steps: [
          { title: "Continue", dependsOn: ["s1"] },
          { title: "Next", dependsOn: ["s1"] },
        ],
      },
      {
        workspacePath: "/tmp/ws",
        fullPermissionsEnabled: true,
        toolCallId: "c-self",
      } satisfies ToolExecuteContext,
    );
    assert.equal(result.returnCode, ToolReturnCode.InvalidArguments);
    assert.ok(
      result.content.some(
        (p) =>
          p.type === "text" &&
          typeof p.text === "string" &&
          p.text.includes("non-empty string"),
      ),
    );
  });
});
