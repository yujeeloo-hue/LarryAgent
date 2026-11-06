import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FsmHostCapabilities } from "../FsmHostCapabilities.js";
import { Node } from "../Node.js";
import { makeFakeHost, makeScope, makeSession } from "../graphScenariosFixtures.js";
import { createDefaultActionRegistry } from "./createDefaultActionRegistry.js";

describe("NodeActionCallModel waiting text", () => {
  for (const testCase of [
    { name: "inherits the prepared role status when its own text is omitted", params: {}, expected: "Reviewing the change…" },
    { name: "keeps an explicit Call model status ahead of the prepared role", params: { waitingMessage: "Checking the answer…" }, expected: "Checking the answer…" },
    { name: "inherits the prepared role status when its own text is empty", params: { waitingMessage: "" }, expected: "Reviewing the change…" },
  ]) {
    it(testCase.name, async () => {
      const session = makeSession();
      const scope = makeScope(session, "agent");
      const { host } = makeFakeHost({ session, rounds: [{ text: "Done." }] });
      const captured: Parameters<FsmHostCapabilities["streamModelRound"]>[0][] = [];
      const streamModelRound = host.streamModelRound;
      host.streamModelRound = async (input) => {
        captured.push(input);
        return streamModelRound(input);
      };
      const registry = createDefaultActionRegistry();
      const node = new Node({
        id: "review",
        actions: [
          registry.createAction("NodeActionPrepareRole", {
            roleKind: "reviewer", rolePromptInline: "Review the change.",
            waitingMessage: "Reviewing the change…",
          }, "review.PrepareRole"),
          registry.createAction("NodeActionCallModel", testCase.params, "review.CallModel"),
        ],
      });

      const result = await node.run(
        { turnScope: scope }, { messages: [], tools: [] }, { host },
      );

      assert.equal(result.status, "continue");
      assert.equal(captured.length, 1);
      assert.equal(captured[0]!.progressText, testCase.expected);
      assert.equal(result.nodeContext.progressLabel, testCase.expected);
    });
  }
});
