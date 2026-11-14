import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

function src(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), "utf8");
}

/**
 * Wiring-existence regression for the FSM session blackboard capability
 * (fsmGraphTool.test.ts precedent): the five-hop chain is typed loosely at
 * object-spread boundaries, so typecheck alone cannot catch a dropped hop.
 */
describe("blackboard host-capability wiring", () => {
  it("FsmHostCapabilities declares the optional accessors", () => {
    const caps = src("./FsmHostCapabilities.ts");
    assert.match(caps, /readonly blackboardGet\?: \(key: string\) => unknown;/);
    assert.match(caps, /readonly blackboardSet\?: \(/);
  });

  it("RunAgentTurnInput declares the accessors (agent/types.ts)", () => {
    const types = src("../types.ts");
    assert.match(types, /blackboardGet\?: \(key: string\) => unknown;/);
    assert.match(types, /blackboardSet\?: \(/);
  });

  it("turnHost declares them on the input config and TurnHost", () => {
    const turnTypes = src("../turnHost/types.ts");
    assert.match(turnTypes, /blackboardGet\?: \(key: string\) => unknown;/);
    assert.match(turnTypes, /readonly blackboardGet\?: \(key: string\) => unknown;/);
    assert.match(turnTypes, /readonly blackboardSet\?: \(/);
  });

  it("createTurnHost destructures and forwards them", () => {
    const createTurnHost = src("../turnHost/createTurnHost.ts");
    assert.match(
      createTurnHost,
      /\r?\n    blackboardGet,\r?\n    blackboardSet,\r?\n/,
      "createTurnHost must destructure blackboardGet/blackboardSet from input",
    );
    assert.match(
      createTurnHost,
      /\.\.\.\(blackboardGet \? \{ blackboardGet \} : \{\}\),/,
      "createTurnHost must forward blackboardGet into the host",
    );
    assert.match(
      createTurnHost,
      /\.\.\.\(blackboardSet \? \{ blackboardSet \} : \{\}\),/,
      "createTurnHost must forward blackboardSet into the host",
    );
  });

  it("sessionRuntime injects the real implementation with the 64KB cap", () => {
    const runtime = src("../../main/sessionRuntime.ts");
    assert.match(
      runtime,
      /blackboardGet: \(key\) => current\.session\.fsmBlackboard\?\.\[key\]/,
      "sessionRuntime must read the live session blackboard",
    );
    assert.match(runtime, /blackboardSet: \(key, value\) => \{/);
    assert.match(
      runtime,
      /FSM_BLACKBOARD_MAX_BYTES/,
      "sessionRuntime must enforce the serialized-size cap",
    );
    assert.match(
      runtime,
      /updateFsmBlackboard\(db, sessionId, current\.session\.fsmBlackboard\)/,
      "sessionRuntime must persist through the dedicated repository path",
    );
  });

  it("sessionRepository maps fsm_blackboard in both directions", () => {
    const repo = src("../../session/db/sessionRepository.ts");
    assert.match(repo, /fsm_blackboard: string \| null;/);
    assert.match(
      repo,
      /mergeLegacyPhaseColumnIntoBlackboard\(\s*parseFsmBlackboard\(row\.fsm_blackboard\)/,
    );
    assert.match(repo, /export function updateFsmBlackboard\(/);
  });
});
