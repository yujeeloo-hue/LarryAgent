import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  composeBucket0SystemExtras,
  composeTrailingOverlay,
  planRoleSystemPromptForPrefix,
} from "./overlayCompose.js";

describe("composeTrailingOverlay", () => {
  it("keeps only the live phase overlay (plan-role body is Bucket0)", () => {
    const planner = composeTrailingOverlay({
      promptPlacement: "system",
      roleSystemPrompt: "[PLANNER]\nDecide the route.",
      phaseOverlay: "[Plan phase]\nCall create_plan.",
    });
    assert.equal(planner, "[Plan phase]\nCall create_plan.");
    assert.doesNotMatch(planner, /\[PLANNER\]/);

    const agent = composeTrailingOverlay({
      promptPlacement: "persona",
      roleSystemPrompt: "[AGENT]\nCoding agent.",
      phaseOverlay: "[Ask mode]",
    });
    assert.equal(agent, "[Ask mode]");

    const subagent = composeTrailingOverlay({
      promptPlacement: "persona",
      roleSystemPrompt: "[SUBAGENT]\nJSON reply.",
    });
    assert.equal(subagent, "");
  });
});

describe("planRoleSystemPromptForPrefix", () => {
  it("returns plan-role bodies and skips agent/subagent", () => {
    assert.equal(
      planRoleSystemPromptForPrefix({
        promptPlacement: "system",
        roleSystemPrompt: "[EXECUTOR]\nRun the plan.",
      }),
      "[EXECUTOR]\nRun the plan.",
    );
    assert.equal(
      planRoleSystemPromptForPrefix({
        promptPlacement: "persona",
        roleSystemPrompt: "[AGENT]\nCoding agent.",
      }),
      undefined,
    );
    assert.equal(
      planRoleSystemPromptForPrefix({
        promptPlacement: "persona",
        roleSystemPrompt: "[SUBAGENT]\nJSON reply.",
      }),
      undefined,
    );
  });
});

describe("composeBucket0SystemExtras", () => {
  it("joins plan-role markdown then PromptInject system blocks", () => {
    assert.equal(
      composeBucket0SystemExtras({
        promptPlacement: "system",
        roleSystemPrompt: "[PLANNER]\nDecide.",
        systemInject: "[Injected system]",
      }),
      "[PLANNER]\nDecide.\n\n[Injected system]",
    );
  });

  it("allows agent-only systemInject without plan-role body", () => {
    assert.equal(
      composeBucket0SystemExtras({
        promptPlacement: "persona",
        roleSystemPrompt: "[AGENT]\nCoding agent.",
        systemInject: "[Agent system inject]",
      }),
      "[Agent system inject]",
    );
  });
});
