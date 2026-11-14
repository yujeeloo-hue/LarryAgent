import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { reasoningScopeForClient } from "../../llm/contextScope.js";
import type { OpenAiCompatibleClientConfig } from "../../llm/types.js";
import { configureUserMemoryRoot } from "../../memory/store.js";
import { loadAllSessions, openSessionDb, upsertSession } from "../../session/db/index.js";
import type { JsonObject, ModelResponsePart, Session } from "../../session/types.js";
import { configurePromptDefaults } from "../../settings/promptDefaults.js";
import type { PermissionGateState } from "../../tools/types.js";
import { runAgentTurn } from "../runAgentTurn.js";
import type { RunAgentTurnInput } from "../types.js";

const originalFetch = globalThis.fetch;
let tempRoot = "";
let sequence = 0;
before(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "jb-responses-recovery-"));
  configureUserMemoryRoot(tempRoot);
  configurePromptDefaults(join(process.cwd(), "resources", "prompts"));
});
afterEach(() => { globalThis.fetch = originalFetch; });
after(async () => {
  assert.equal(dirname(resolve(tempRoot)), resolve(tmpdir()));
  assert.ok(basename(tempRoot).startsWith("jb-responses-recovery-"));
  await rm(tempRoot, { recursive: true, force: true });
});

const client: OpenAiCompatibleClientConfig = { baseUrl: "https://request-recovery.example.com/v1/responses",
  apiKey: "mock-only-key", model: "mock-model", responsesTools: [{ type: "mcp", server_label: "docs", server_url: "https://mcp.example.com" }] };
const gate: PermissionGateState = { fullPermissionsEnabled: true, requestConfirmation: async () => true,
  enableFullPermissions: () => {}, requestUserAsk: async () => null };
function session(): Session {
  return { id: `recovery-${++sequence}`, type: "agent", title: "Request recovery", status: "idle", progressText: "",
    createdAt: 1, updatedAt: 1, messages: [], providerId: "p", model: client.model, workspaceId: "w", workspacePath: "",
    pinned: false, archived: false, archivedAt: null, contextUsage: { usedTokens: 0 }, plan: null };
}
function input(state: Session, overrides: Partial<RunAgentTurnInput> = {}): RunAgentTurnInput {
  return { session: state, client, gate, userText: "Continue", createId: () => `message-${++sequence}`,
    unlimitedTurnBudgets: true, ...overrides };
}
function nativeParts(state: Session): ModelResponsePart[] {
  return state.messages.flatMap((message) => message.parts)
    .filter((part): part is ModelResponsePart => part.type === "model_response");
}
const answer = (value: string): JsonObject => ({ type: "message", id: `msg-${++sequence}`, role: "assistant", status: "completed",
  content: [{ type: "output_text", text: value, annotations: [] }] });
function response(id: string, output: JsonObject[]): Response {
  const frame = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`;
  return new Response(frame({ type: "response.created", response: { id, status: "in_progress", store: true } })
    + frame({ type: "response.completed", response: { id, status: "completed", store: true, output } }),
  { headers: { "Content-Type": "text/event-stream" } });
}

describe("Responses request recovery checkpoints", () => {
  for (const cancellation of ["Stop", "direct interrupt"] as const) {
    it(`preserves completed MCP state when ${cancellation} cancels the continuation before fetch`, async () => {
      let state = session();
      const recoveryClient = { ...client, responsesStateful: true };
      const db = openSessionDb(join(tempRoot, state.id));
      const stop = new AbortController();
      const port: { fire: (() => boolean) | null } = { fire: null };
      let pauseRequested = false;
      let cancelled = false;
      let expected: ModelResponsePart | undefined;
      const bodies: JsonObject[] = [];
      const checkpoint = (): void => {
        const part = nativeParts(state).at(-1);
        if (part?.status === "completed" && part.responseId === "resp_before_unsent"
          && part.continuationInput?.[0]?.approve === true && !expected) expected = structuredClone(part);
        upsertSession(db, state);
        if (!cancelled && part?.status === "submitting" && part.continuationInput?.[0]?.approve === true) {
          cancelled = true;
          if (cancellation === "Stop") stop.abort();
          else {
            pauseRequested = true; // Observe the interrupted boundary before any deliberate resume.
            assert.equal(port.fire?.(), true);
          }
        }
      };
      globalThis.fetch = async (_url, init) => {
        assert.equal(init?.method, "POST");
        bodies.push(JSON.parse(String(init?.body)) as JsonObject);
        if (bodies.length === 1) return response("resp_before_unsent", [
          { type: "reasoning", id: "reasoning-original", encrypted_content: "opaque-original", summary: [{ type: "summary_text", text: "Ready to request approval" }] },
          { type: "mcp_approval_request", id: "approval-unsent", server_label: "docs", name: "write", arguments: "{}" },
        ]);
        assert.equal(bodies.length, 2, "only the explicit resumed turn can send the continuation");
        assert.equal(bodies[1]!.previous_response_id, "resp_before_unsent");
        assert.deepEqual((bodies[1]!.input as JsonObject[]).find((item) => item.type === "mcp_approval_response"),
          { type: "mcp_approval_response", approval_request_id: "approval-unsent", approve: true });
        return response("resp_resumed", [{ type: "mcp_call", id: "mcp-finished", server_label: "docs", name: "write",
          approval_request_id: "approval-unsent", status: "completed", output: "Saved once" }, answer("Finished")]);
      };
      try {
        const result = await runAgentTurn(input(state, { client: recoveryClient, signal: stop.signal, interruptPort: port, checkpoint,
          takePauseRequested: () => { const taken = pauseRequested; pauseRequested = false; return taken; } }));
        assert.equal(result.status, cancellation === "Stop" ? "cancelled" : "paused");
        assert.equal(cancelled, true);
        assert.equal(bodies.length, 1, "the interrupted continuation never called fetch");
        assert.ok(expected?.contextHash);
        assert.ok(expected.contextLength);
        assert.deepEqual(nativeParts(state)[0], expected);
        state = loadAllSessions(db).find((item) => item.id === state.id)!;
        assert.deepEqual(nativeParts(state)[0], expected, "SQLite retains the completed snapshot and pending approval");
        assert.equal((await runAgentTurn(input(state, { client: recoveryClient, checkpoint, userText: "Resume" }))).status, "idle");
        assert.equal(bodies.length, 2);
      } finally { db.close(); }
    });
  }

  it("retrieves a potentially writing legacy response with a known ID despite stored:false", async () => {
    const state = session();
    state.messages.push({ id: "legacy-owner", role: "assistant", createdAt: 1, parts: [{ type: "model_response",
      providerScope: reasoningScopeForClient(client), responseId: "resp_legacy_known", status: "in_progress", stored: false,
      hostedEffects: true, output: [] }] });
    const requests: string[] = [];
    globalThis.fetch = async (url, init) => {
      requests.push(`${init?.method} ${String(url)}`);
      if (init?.method === "GET") return Response.json({ id: "resp_legacy_known", status: "completed", store: true, output: [
        { type: "mcp_call", id: "legacy-write", server_label: "docs", name: "write", status: "completed", output: "Already saved" },
        answer("Recovered prior result"),
      ] });
      const body = JSON.parse(String(init?.body)) as JsonObject;
      assert.equal(body.previous_response_id, undefined);
      assert.ok((body.input as JsonObject[]).some((item) => item.type === "mcp_call" && item.id === "legacy-write" && item.output === "Already saved"));
      assert.equal((body.input as JsonObject[]).some((item) => item.type === "mcp_approval_response"), false);
      return response("resp_after_recovery", [answer("New work complete")]);
    };
    assert.equal((await runAgentTurn(input(state))).status, "idle");
    assert.equal(requests.length, 2);
    assert.match(requests[0]!, /^GET .*\/resp_legacy_known$/);
    assert.match(requests[1]!, /^POST /);
    assert.equal(nativeParts(state)[0]!.status, "completed");
    assert.equal(nativeParts(state)[0]!.stored, false, "recovery does not upgrade the requested storage preference");
  });
});
