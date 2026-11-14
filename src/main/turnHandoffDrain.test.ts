import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  HANDOFF_PROMPT_PART_ID,
  STEER_CONTINUATION_PART_ID,
  type SessionStatus,
} from "../session/types.js";
import {
  handoffDrainDropReason,
  TURN_HANDOFF_CHAIN_DEPTH_CAP,
} from "./turnHandoffDrain.js";

const PROCEED = {
  planApprovalTookPrecedence: false,
  status: "idle" as SessionStatus,
  handoffEnabled: true,
  chainDepth: 0,
};

describe("handoffDrainDropReason (turn finally fail-stop table)", () => {
  it("proceeds only for a completed turn with gate on and depth below cap", () => {
    assert.equal(handoffDrainDropReason(PROCEED), null);
    assert.equal(
      handoffDrainDropReason({ ...PROCEED, chainDepth: TURN_HANDOFF_CHAIN_DEPTH_CAP - 1 }),
      null,
    );
  });

  it("a queued plan approval takes precedence over the handoff", () => {
    const reason = handoffDrainDropReason({
      ...PROCEED,
      planApprovalTookPrecedence: true,
    });
    assert.match(reason ?? "", /plan approval ran instead/);
    // Precedence wins even over every other drop cause.
    const combined = handoffDrainDropReason({
      planApprovalTookPrecedence: true,
      status: "error",
      handoffEnabled: false,
      chainDepth: 99,
    });
    assert.match(combined ?? "", /plan approval ran instead/);
  });

  it("a queued user prompt takes precedence over the handoff", () => {
    const reason = handoffDrainDropReason({
      ...PROCEED,
      promptQueueTookPrecedence: true,
    });
    assert.match(reason ?? "", /queued user message started the next turn/);
    // A queued plan approval is reported first when both happened.
    const both = handoffDrainDropReason({
      ...PROCEED,
      planApprovalTookPrecedence: true,
      promptQueueTookPrecedence: true,
    });
    assert.match(both ?? "", /plan approval ran instead/);
  });

  it("drops for every non-completed terminal status", () => {
    // Agent turns finish "idle" on success; "completed" belongs to subagent
    // runs and must NOT drain a session handoff either.
    for (const status of [
      "paused",
      "cancelled",
      "error",
      "running",
      "completed",
    ] as SessionStatus[]) {
      const reason = handoffDrainDropReason({ ...PROCEED, status });
      assert.ok(reason, `status ${status} must drop`);
      assert.match(reason ?? "", new RegExp(`status: ${status}`));
      assert.match(reason ?? "", /Only completed turns hand off/);
    }
  });

  it("drops when the gate was flipped off mid-turn (null/false/undefined)", () => {
    for (const handoffEnabled of [null, false, undefined]) {
      const reason = handoffDrainDropReason({ ...PROCEED, handoffEnabled });
      assert.match(reason ?? "", /disabled/);
      assert.match(reason ?? "", /Self Learning/);
    }
  });

  it("drops at the chain depth cap (runaway self-loop guard)", () => {
    const reason = handoffDrainDropReason({
      ...PROCEED,
      chainDepth: TURN_HANDOFF_CHAIN_DEPTH_CAP,
    });
    assert.match(
      reason ?? "",
      new RegExp(`chain depth cap \\(${TURN_HANDOFF_CHAIN_DEPTH_CAP}\\)`),
    );
    assert.match(reason ?? "", /send a message to take over/);
  });

  it("chain depth cap is the shared tools-layer constant (8)", () => {
    assert.equal(TURN_HANDOFF_CHAIN_DEPTH_CAP, 8);
  });

  it("status drop is reported before the gate drop", () => {
    const reason = handoffDrainDropReason({
      ...PROCEED,
      status: "cancelled",
      handoffEnabled: false,
    });
    assert.match(reason ?? "", /status: cancelled/);
  });
});

describe("handoff prompt marker + override persistence invariants", () => {
  it("HANDOFF_PROMPT_PART_ID is exported and distinct from the steer marker", () => {
    assert.equal(typeof HANDOFF_PROMPT_PART_ID, "string");
    assert.ok(HANDOFF_PROMPT_PART_ID.length > 0);
    assert.notEqual(HANDOFF_PROMPT_PART_ID, STEER_CONTINUATION_PART_ID);
  });

  it("one-shot graph override never touches the session row", () => {
    // handoffGraphId is a request-scoped field (StartTurnRequest); the
    // repository layer must stay unaware of it so the override cannot pin.
    const repo = readFileSync(
      fileURLToPath(
        new URL("../session/db/sessionRepository.ts", import.meta.url),
      ),
      "utf8",
    );
    assert.equal(repo.includes("handoffGraphId"), false);
    assert.equal(repo.includes("handoff_graph_id"), false);
  });
});
