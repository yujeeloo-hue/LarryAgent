import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reasoningScopeForClient } from "../../llm/contextScope.js";
import type { OpenAiCompatibleClientConfig } from "../../llm/types.js";
import type { Message } from "../../session/types.js";
import { makeSession } from "../fsm/graphScenariosFixtures.js";
import { summarizeSessionForArchive } from "./summarizeForArchive.js";
import { maybeCompactBeforeIteration } from "./strategies/iterationProtectV1/compactContext.js";

const sourceClient: OpenAiCompatibleClientConfig = { baseUrl: "https://source.example/v1", apiKey: "source-key", model: "model-a" };
const otherClient: OpenAiCompatibleClientConfig = { baseUrl: "https://summary.example/v1", apiKey: "summary-key", model: "model-b" };

function transcript(): Message[] {
  return [
    { id: "user", role: "user", createdAt: 1, parts: [{ type: "text", text: "Keep the public decision." }] },
    { id: "assistant", role: "assistant", createdAt: 2, parts: [
      { type: "reasoning", text: "source-private-thought", providerScope: reasoningScopeForClient(sourceClient) },
      { type: "reasoning", text: "summary-private-thought", providerScope: reasoningScopeForClient(otherClient) },
      { type: "reasoning", text: "legacy-private-thought" },
      { type: "text", text: "Public decision: keep compatibility." },
      { type: "tool_call", id: "call", name: "read_file", status: "done", arguments: { path: "/workspace/visible.txt" }, argumentsRaw: '{"path":"/workspace/visible.txt"}' },
    ] },
    { id: "result", role: "tool", toolCallId: "call", createdAt: 3, parts: [
      { type: "tool_result", toolCallId: "call", returnCode: 0, content: [{ type: "text", text: "Public tool result." }] },
    ] },
  ];
}

describe("summary reasoning binding isolation", () => {
  for (const purpose of ["compact", "archive"] as const) {
    for (const client of [sourceClient, otherClient]) {
      it(`${purpose} sends reasoning only from its actual summary client ${client.model}`, async () => {
        let payload = "";
        const summarize = async (actualClient: OpenAiCompatibleClientConfig, options: Parameters<NonNullable<Parameters<typeof summarizeSessionForArchive>[0]["summarize"]>>[1]) => {
          assert.equal(actualClient, client);
          payload = String(options.messages[0]!.content);
          return { content: "Public summary." };
        };
        const messages = transcript();
        const original = structuredClone(messages);
        if (purpose === "compact") {
          const session = makeSession();
          session.messages = messages;
          let nextId = 0;
          const result = await maybeCompactBeforeIteration({
            session, client, summarize, createId: () => `summary-${++nextId}`,
            contextLimitTokens: 8_000, force: true,
            iterationProtectRawIterationCount: 0, iterationProtectTokenRatio: 0,
          });
          assert.equal(result.compacted, true);
        } else {
          const result = await summarizeSessionForArchive({ messages, sessionId: "summary", client, contextLimitTokens: 8_000, summarize });
          assert.equal(result.kind, "summarized");
        }
        assert.match(payload, /Public decision: keep compatibility\./);
        assert.match(payload, /read_file/);
        assert.match(payload, /visible\.txt/);
        assert.doesNotMatch(payload, /legacy-private-thought/);
        if (client === sourceClient) {
          assert.match(payload, /source-private-thought/);
          assert.doesNotMatch(payload, /summary-private-thought/);
        } else {
          assert.match(payload, /summary-private-thought/);
          assert.doesNotMatch(payload, /source-private-thought/);
        }
        assert.deepEqual(messages.slice(0, original.length), original, "reasoning remains intact in stored history");
      });
    }
  }
});
