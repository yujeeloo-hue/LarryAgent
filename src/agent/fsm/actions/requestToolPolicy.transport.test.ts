import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRoleLlmBinding } from "../../roles/llmBinding.js";
import { createTurnHost } from "../../turnHost/createTurnHost.js";
import { makeSession } from "../graphScenariosFixtures.js";
import { Node } from "../Node.js";
import { createDefaultActionRegistry } from "./createDefaultActionRegistry.js";

describe("FSM tool policy on the HTTP request", () => {
  for (const deny of [["blocked_write"], ["*"]]) {
    it(`excludes ${deny.join(", ")} from the serialized request with legacy hardFilter false`, async () => {
      const originalFetch = globalThis.fetch;
      const bodies: Array<Record<string, unknown>> = [];
      globalThis.fetch = (async (url, init) => {
        assert.equal(String(url), "https://gateway.example.com/full-chat-endpoint");
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(
          `data: ${JSON.stringify({ choices: [{ delta: { content: "Done." }, finish_reason: "stop" }] })}\n\n` +
          "data: [DONE]\n\n",
          { headers: { "Content-Type": "text/event-stream" } },
        );
      }) as typeof fetch;
      const session = makeSession({ id: `http-policy-${deny[0]}` });
      const client = {
        baseUrl: "https://gateway.example.com/full-chat-endpoint",
        model: "test-model", apiKey: "test-key", rawEndpoint: true,
      };
      let id = 0;
      const host = createTurnHost({
        session, client, isSubagentTurn: true,
        gate: {
          fullPermissionsEnabled: true, enableFullPermissions: () => {},
          requestConfirmation: async () => false, requestUserAsk: async () => null,
        },
        createId: () => `policy-${++id}`,
        runChildTurn: async () => ({ status: "idle", modelIterations: 0 }),
      });
      try {
        const registry = createDefaultActionRegistry();
        const node = new Node({
          id: "restricted",
          actions: [
            registry.createAction("NodeActionDisableTools", {
              toolNames: deny, hardFilter: false,
            }, "restricted.DisableTools"),
            registry.createAction("NodeActionCallModel", {}, "restricted.CallModel"),
          ],
        });
        const result = await node.run({}, {
          activeLlm: createRoleLlmBinding({ providerId: "test", client }),
          messages: [{ role: "user", content: "Check the policy" }],
          tools: ["safe_lookup", "blocked_write"].map((name) => ({
            type: "function", function: { name, parameters: { type: "object", properties: {} } },
          })),
        }, { host });
        assert.equal(result.status, "continue");
        assert.equal(bodies.length, 1);
        const offered = bodies[0]!.tools as Array<{ function: { name: string } }> | undefined;
        assert.deepEqual(offered?.map((tool) => tool.function.name) ?? [],
          deny[0] === "*" ? [] : ["safe_lookup"]);
      } finally {
        host.dispose();
        globalThis.fetch = originalFetch;
      }
    });
  }
});
