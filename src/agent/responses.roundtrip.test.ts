import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { configureUserMemoryRoot } from "../memory/store.js";
import { configurePromptDefaults } from "../settings/promptDefaults.js";
import { loadAllSessions, openSessionDb, upsertSession } from "../session/db/index.js";
import type { JsonObject, ModelResponsePart, Session } from "../session/types.js";
import type { PermissionGateState } from "../tools/types.js";
import type { OpenAiCompatibleClientConfig } from "../llm/types.js";
import { reasoningScopeForClient } from "../llm/contextScope.js";
import { upsertTool, unregisterTool } from "../tools/registry.js";
import { ToolReturnCode } from "../session/returnCodes.js";
import { runAgentTurn } from "./runAgentTurn.js";
import { RESPONSES_RECOVERY_GIVE_UP_MS } from "./turnHost/createTurnHost.js";
import { createReactGraphConfig } from "./fsm/configs/sampleGraphs.js";
import type { RunAgentTurnInput } from "./types.js";
import type { StreamEvent } from "../llm/streamEvents.js";
import type { PendingSteer } from "./ipcTypes.js";

const originalFetch = globalThis.fetch;
let root = "";
let sequence = 0;
before(async () => {
  root = await mkdtemp(join(tmpdir(), "jellybot-responses-roundtrip-"));
  configureUserMemoryRoot(root);
  configurePromptDefaults(join(process.cwd(), "resources", "prompts"));
});
afterEach(() => { globalThis.fetch = originalFetch; unregisterTool("responses_cursor_counter"); });
after(async () => { await rm(root, { recursive: true, force: true }); });
const client: OpenAiCompatibleClientConfig = { baseUrl: "https://mock.example/v1/responses", apiKey: "mock-key", model: "m",
  responsesTools: [{ type: "web_search" }, { type: "code_interpreter", container: { type: "auto" } }], responsesStateful: true };
function session(): Session {
  return { id: `response-session-${++sequence}`, type: "agent", title: "Native roundtrip", status: "idle", progressText: "",
    createdAt: 1, updatedAt: 1, messages: [], providerId: "p", model: "m", workspaceId: "w", workspacePath: "",
    pinned: false, archived: false, archivedAt: null, contextUsage: { usedTokens: 0 }, plan: null };
}
function input(state: Session, overrides: Partial<RunAgentTurnInput> = {}): RunAgentTurnInput {
  return { session: state, client: { ...client }, userText: "Continue", createId: () => `message-${++sequence}`,
    gate: { fullPermissionsEnabled: true } as PermissionGateState, unlimitedTurnBudgets: true, ...overrides };
}
const text = (value: string): JsonObject => ({ type: "message", id: `msg-${++sequence}`, role: "assistant", status: "completed",
  content: [{ type: "output_text", text: value, annotations: [{ type: "url_citation", url: "https://example.com/source", title: "Source", start_index: 0, end_index: 3 }] }] });
const reasoning = (): JsonObject => ({ type: "reasoning", id: `rs-${++sequence}`, summary: [{ type: "summary_text", text: "Considering evidence" }], encrypted_content: "opaque-native-reasoning" });
const search = (): JsonObject => ({ type: "web_search_call", id: `ws-${++sequence}`, status: "completed", action: { type: "search", queries: ["evidence"] } });
const functionCall = (): JsonObject => ({ type: "function_call", id: "fc_item", call_id: "call_time", name: "get_current_time", arguments: "{}", status: "completed" });
function response(id: string, output: JsonObject[]): Response {
  const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
  return new Response(frame({ type: "response.created", response: { id, status: "in_progress", store: true } })
    + frame({ type: "response.completed", response: { id, status: "completed", store: true, output,
      usage: { input_tokens: 15, output_tokens: 5, total_tokens: 20 } } }), { headers: { "Content-Type": "text/event-stream" } });
}
function hasNativeApproval(input: unknown): boolean {
  return Array.isArray(input) && input.some((item) => typeof (item as JsonObject)?.type === "string"
    && String((item as JsonObject).type).startsWith("mcp_approval"));
}

function nativeParts(state: Session): ModelResponsePart[] {
  return state.messages.flatMap((message) => message.parts).filter((part): part is ModelResponsePart => part.type === "model_response");
}

function cursorCounter() {
  let executions = 0;
  upsertTool({ name: "responses_cursor_counter", description: "In-memory effect counter",
    parameters: { type: "object", properties: {}, additionalProperties: false }, defaultPermissionLevel: 0 }, async () => {
    executions += 1;
    return { returnCode: ToolReturnCode.Success, content: [{ type: "text", text: `local effect ${executions}` }] };
  });
  return { count: () => executions, call: { type: "function_call", id: "fc_cursor_effect", call_id: "cursor_local_call",
    name: "responses_cursor_counter", arguments: "{}", status: "completed" } satisfies JsonObject };
}

function missingCursor(id: string, status = 400): Response {
  return Response.json({ error: { message: `previous_response_id '${id}' not found`, param: "previous_response_id", code: "not_found" } }, { status });
}

describe("Responses through real FSM and Host", () => {
  for (const { stage, stateful } of [true, false].flatMap((stateful) =>
    (["before response.created", "after response.created"] as const).map((stage) => ({ stage, stateful })))) {
    it(`continues a steered web-search-only request ${stage} with store=${stateful} and starts the next turn after SQLite reload without repeating done tools`, async () => {
      let state = session();
      const db = openSessionDb(join(root, state.id));
      const counter = cursorCounter();
      const webClient = { ...client, responsesStateful: stateful, responsesTools: [{ type: "web_search" }] };
      const port: { fire: (() => boolean) | null } = { fire: null };
      let pending: PendingSteer[] = [];
      const bodies: JsonObject[] = [];
      const events: StreamEvent[] = [];
      const checkpoint = (): void => { upsertSession(db, state); };
      const interrupt = (): void => {
        pending = [{ id: "web-steer", sessionId: state.id, userText: "Use the new direction", attachments: [], mode: "interrupt", createdAt: Date.now() }];
        assert.equal(port.fire?.(), true);
      };
      globalThis.fetch = async (_url, init) => {
        assert.equal(init?.method, "POST");
        const body = JSON.parse(String(init?.body)) as JsonObject;
        assert.equal(body.store, stateful);
        bodies.push(body);
        if (bodies.length === 1) return response("resp_before_web_interrupt", [counter.call]);
        if (bodies.length === 2) {
          assert.equal(counter.count(), 1);
          if (stage === "before response.created") {
            interrupt();
            throw new DOMException("Aborted by steer", "AbortError");
          }
          const frame = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`;
          return new Response(new ReadableStream<Uint8Array>({ start(controller) {
            controller.enqueue(new TextEncoder().encode(
              frame({ type: "response.created", response: { id: "resp_web_interrupted", status: "in_progress", store: true } })
              + frame({ type: "response.output_item.added", item: { type: "web_search_call", id: "web-in-progress", status: "in_progress", action: { type: "search", queries: ["old direction"] } } }),
            ));
          } }), { headers: { "Content-Type": "text/event-stream" } });
        }
        if (bodies.length === 3) {
          assert.match(JSON.stringify(body.input), /Use the new direction/);
          assert.equal(counter.count(), 1);
          return response("resp_after_web_steer", [text("Finished the new direction")]);
        }
        assert.equal(bodies.length, 4);
        return response("resp_web_next_turn", [text("Next turn works")]);
      };
      try {
        const first = await runAgentTurn(input(state, { client: webClient, checkpoint, interruptPort: port,
          hasPendingSteer: () => pending.length > 0,
          takePendingSteer: () => { const taken = pending; pending = []; return taken; },
          onEvent: (event) => {
            events.push(event);
            if (stage === "after response.created" && event.type === "hosted_tool" && event.id === "web-in-progress" && event.status === "in_progress" && pending.length === 0) interrupt();
          } }));
        assert.equal(first.status, "idle");
        assert.equal(first.modelIterations, 3, "the correction continues within the same turn");
        assert.equal(bodies.length, 3);
        assert.equal(events.filter((event) => event.type === "round_interrupted").length, 1);
        assert.equal(events.some((event) => event.type === "error"), false);
        assert.equal(counter.count(), 1);
        state = loadAllSessions(db).find((item) => item.id === state.id)!;
        assert.equal((await runAgentTurn(input(state, { client: webClient, checkpoint, userText: "Another task" }))).status, "idle");
        assert.equal(bodies.length, 4);
        assert.equal(counter.count(), 1);
        assert.equal(state.messages.filter((message) => message.role === "tool").length, 1);
      } finally { db.close(); }
    });
  }

  it("does not submit another request when abandoning an interrupted read-only request cannot be checkpointed", async () => {
    const state = session();
    const db = openSessionDb(join(root, state.id));
    const counter = cursorCounter();
    const webClient = { ...client, responsesTools: [{ type: "web_search" }] };
    const port: { fire: (() => boolean) | null } = { fire: null };
    let pending: PendingSteer[] = [];
    let posts = 0;
    let abandonSaveAttempted = false;
    const checkpoint = (): void => {
      if (!abandonSaveAttempted && nativeParts(state).some((part) => part.status === "abandoned_local")) {
        abandonSaveAttempted = true;
        db.exec("CREATE TRIGGER fail_readonly_abandon BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'readonly abandon checkpoint failed'); END");
      }
      upsertSession(db, state);
    };
    globalThis.fetch = async (_url, init) => {
      assert.equal(init?.method, "POST");
      posts += 1;
      if (posts === 1) return response("resp_before_abandon_failure", [counter.call]);
      assert.equal(posts, 2, "clearing an interrupted request must be durable before another POST");
      assert.equal(counter.count(), 1);
      pending = [{ id: "abandon-failure-steer", sessionId: state.id, userText: "Use another direction", attachments: [], mode: "interrupt", createdAt: Date.now() }];
      assert.equal(port.fire?.(), true);
      throw new DOMException("Aborted read-only request", "AbortError");
    };
    try {
      await runAgentTurn(input(state, { client: webClient, checkpoint, interruptPort: port,
        hasPendingSteer: () => pending.length > 0,
        takePendingSteer: () => { const taken = pending; pending = []; return taken; } })).then(
        (result) => assert.equal(result.status, "error"),
        (error) => assert.match(String(error), /checkpoint failed/),
      );
      assert.equal(abandonSaveAttempted, true);
      assert.equal(posts, 2);
      assert.equal(counter.count(), 1);
      const persisted = loadAllSessions(db).find((item) => item.id === state.id)!;
      assert.equal(nativeParts(persisted).some((part) => part.status === "abandoned_local"), false);
      assert.equal(persisted.messages.filter((message) => message.role === "tool").length, 1);
    } finally { db.close(); }
  });

  it("continues after a steered MCP write approval is lost, denying it instead of resubmitting", async () => {
    let state = session();
    const db = openSessionDb(join(root, state.id));
    const counter = cursorCounter();
    const mcpClient = { ...client, responsesTools: [{ type: "mcp", server_label: "docs", server_url: "https://mcp.example.com", allowed_tools: ["write"] }] };
    const port: { fire: (() => boolean) | null } = { fire: null };
    let pending: PendingSteer[] = [];
    let posts = 0;
    let approvals = 0;
    const gate: PermissionGateState = { fullPermissionsEnabled: true, enableFullPermissions: () => {}, requestUserAsk: async () => null,
      requestConfirmation: async () => { approvals += 1; return true; } };
    const checkpoint = (): void => { upsertSession(db, state); };
    globalThis.fetch = async (_url, init) => {
      assert.equal(init?.method, "POST");
      posts += 1;
      if (posts === 1) return response("resp_before_write_steer", [counter.call,
        { type: "mcp_approval_request", id: "approval-write-steer", server_label: "docs", name: "write", arguments: "{}" }]);
      const body = JSON.parse(String(init?.body)) as JsonObject;
      const items = body.input as JsonObject[];
      if (posts === 2) {
        assert.ok(items.some((item) => item.type === "mcp_approval_response" && item.approve === true));
        assert.equal(counter.count(), 1);
        pending = [{ id: "write-steer", sessionId: state.id, userText: "A different request", attachments: [], mode: "interrupt", createdAt: Date.now() }];
        assert.equal(port.fire?.(), true);
        throw new DOMException("Write response lost during steer", "AbortError");
      }
      if (posts === 3) {
        assert.equal(body.previous_response_id, "resp_before_write_steer");
        assert.equal(items.some((item) => item.type === "mcp_approval_response" && item.approve === true), false,
          "a write approval with an unknown outcome must never be sent again");
        assert.ok(items.some((item) => item.type === "mcp_approval_response" && item.approval_request_id === "approval-write-steer" && item.approve === false));
        assert.match(JSON.stringify(items), /A different request/);
        return response("resp_after_write_steer", [text("Handled the new request")]);
      }
      assert.equal(posts, 4);
      assert.equal(body.previous_response_id, "resp_after_write_steer");
      return response("resp_next_turn", [text("Next turn works")]);
    };
    try {
      const first = await runAgentTurn(input(state, { client: mcpClient, gate, checkpoint, interruptPort: port,
        hasPendingSteer: () => pending.length > 0,
        takePendingSteer: () => { const taken = pending; pending = []; return taken; } }));
      assert.equal(first.status, "idle");
      assert.equal(posts, 3);
      assert.equal(counter.count(), 1);
      assert.equal(approvals, 1);
      assert.ok(nativeParts(state).some((part) => part.status === "outcome_unknown"));
      state = loadAllSessions(db).find((item) => item.id === state.id)!;
      assert.equal((await runAgentTurn(input(state, { client: mcpClient, gate, checkpoint, userText: "Next" }))).status, "idle");
      assert.equal(posts, 4);
      assert.equal(counter.count(), 1);
      assert.equal(approvals, 1);
    } finally { db.close(); }
  });

  it("starts from full input after every stateless-to-stored switch, including a provider falsely reporting store true", async () => {
    const state = session();
    const bodies: JsonObject[] = [];
    globalThis.fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      // Deliberately says store:true even for the requests that disabled it.
      return response(`resp_mode_${bodies.length}`, [reasoning(), text(`Mode answer ${bodies.length}`)]);
    };
    for (const stateful of [false, true, true, false, true, true]) {
      assert.equal((await runAgentTurn(input(state, { client: { ...client, responsesStateful: stateful }, userText: `Mode ${bodies.length + 1}` }))).status, "idle");
    }
    assert.deepEqual(bodies.map((body) => body.store), [false, true, true, false, true, true]);
    assert.deepEqual(bodies.map((body) => body.previous_response_id), [undefined, undefined, "resp_mode_2", undefined, undefined, "resp_mode_5"]);
    assert.equal(nativeParts(state).find((part) => part.responseId === "resp_mode_1")!.stored, false);
    assert.equal(nativeParts(state).find((part) => part.responseId === "resp_mode_4")!.stored, false);
    assert.match(JSON.stringify(bodies[4]!.input), /Mode answer 1/);
    assert.match(JSON.stringify(bodies[4]!.input), /Mode answer 4/);
  });

  it("automatically disables state and retries with local history after store:true is rejected", async () => {
    const state = session();
    const bodies: JsonObject[] = [];
    const reasons: string[] = [];
    const rejectedClient: OpenAiCompatibleClientConfig = {
      ...client,
      onResponsesStatefulDisabled: (reason) => { reasons.push(reason); },
    };
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as JsonObject;
      bodies.push(body);
      if (bodies.length === 1) {
        return Response.json({ error: {
          message: "store=true is not supported: this service does not retain responses, set store to false",
          param: "store",
        } }, { status: 400 });
      }
      return response("resp_store_stateless", [text("Recovered without server state")]);
    };
    assert.equal((await runAgentTurn(input(state, { client: rejectedClient }))).status, "idle");
    assert.deepEqual(reasons, ["store_rejected"]);
    assert.equal(rejectedClient.responsesStateful, false);
    assert.deepEqual(bodies.map((body) => body.store), [true, false]);
    assert.equal(bodies[1]!.previous_response_id, undefined);
    assert.match(JSON.stringify(bodies[1]!.input), /Continue/);
  });

  for (const status of [400, 404]) {
    it(`repairs an exact HTTP ${status} missing cursor once without repeating a completed local effect, including after SQLite reload`, async () => {
      let state = session();
      const db = openSessionDb(join(root, state.id));
      const counter = cursorCounter();
      const bodies: JsonObject[] = [];
      let checkpointedBeforeFallback = false;
      const disableReasons: string[] = [];
      const repairedClient: OpenAiCompatibleClientConfig = {
        ...client,
        onResponsesStatefulDisabled: (reason) => { disableReasons.push(reason); },
      };
      const checkpoint = (): void => { upsertSession(db, state); };
      globalThis.fetch = async (_url, init) => {
        assert.equal(init?.method, "POST");
        const body = JSON.parse(String(init?.body)) as JsonObject;
        bodies.push(body);
        if (bodies.length === 1) return response("resp_lost_cursor", [reasoning(), counter.call]);
        if (bodies.length === 2) {
          assert.equal(body.previous_response_id, "resp_lost_cursor");
          assert.equal(counter.count(), 1);
          return missingCursor("resp_lost_cursor", status);
        }
        if (bodies.length === 3) {
          assert.equal(body.previous_response_id, undefined);
          const persisted = loadAllSessions(db).find((item) => item.id === state.id)!;
          checkpointedBeforeFallback = nativeParts(persisted).find((part) => part.responseId === "resp_lost_cursor")!.stored === false;
          assert.equal(checkpointedBeforeFallback, true);
          const items = body.input as JsonObject[];
          assert.ok(items.some((item) => item.type === "function_call" && item.call_id === "cursor_local_call"));
          assert.ok(items.some((item) => item.type === "function_call_output" && item.call_id === "cursor_local_call" && String(item.output).includes("local effect 1")));
          return response("resp_rebuilt_cursor", [text("Recovered from full input")]);
        }
        assert.equal(bodies.length, 4);
        assert.equal(body.previous_response_id, undefined);
        assert.equal(body.store, false);
        return response("resp_after_reload", [text("Still correct")]);
      };
      try {
        assert.equal((await runAgentTurn(input(state, { checkpoint, client: repairedClient }))).status, "idle");
        assert.equal(bodies.length, 3);
        assert.deepEqual(disableReasons, ["previous_response_id_rejected"]);
        assert.equal(repairedClient.responsesStateful, false);
        assert.equal(bodies[2]!.store, false);
        assert.equal(checkpointedBeforeFallback, true);
        assert.equal(counter.count(), 1);
        assert.equal(state.messages.filter((message) => message.role === "tool").length, 1);
        const call = state.messages.flatMap((message) => message.parts).find((part) => part.type === "tool_call" && part.id === "cursor_local_call")!;
        assert.equal(call.type === "tool_call" && call.status, "done");
        upsertSession(db, state);
        state = loadAllSessions(db).find((item) => item.id === state.id)!;
        assert.equal(nativeParts(state).find((part) => part.responseId === "resp_lost_cursor")!.stored, false);
        assert.equal((await runAgentTurn(input(state, { checkpoint, client: repairedClient, userText: "Continue after reload" }))).status, "idle");
        assert.equal(counter.count(), 1);
        assert.equal(bodies.length, 4);
      } finally { db.close(); }
    });
  }

  it("stops before full-input replay when the cursor invalidation checkpoint fails", async () => {
    const state = session();
    const db = openSessionDb(join(root, state.id));
    const counter = cursorCounter();
    const bodies: JsonObject[] = [];
    let invalidationSaveAttempted = false;
    const checkpoint = (): void => {
      if (!invalidationSaveAttempted && bodies.length === 2 && nativeParts(state).find((part) => part.responseId === "resp_unsaved_invalidation")?.stored === false) {
        invalidationSaveAttempted = true;
        db.exec("CREATE TRIGGER fail_cursor_invalidation BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'cursor invalidation checkpoint failed'); END");
      }
      upsertSession(db, state);
    };
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as JsonObject;
      bodies.push(body);
      if (bodies.length === 1) return response("resp_unsaved_invalidation", [counter.call]);
      assert.equal(bodies.length, 2, "a failed durable invalidation must prevent the fallback POST");
      assert.equal(body.previous_response_id, "resp_unsaved_invalidation");
      assert.equal(counter.count(), 1);
      return missingCursor("resp_unsaved_invalidation");
    };
    try {
      await runAgentTurn(input(state, { checkpoint })).then(
        (result) => assert.equal(result.status, "error"),
        (error: unknown) => assert.match(String(error), /cursor invalidation checkpoint failed/),
      );
      assert.equal(invalidationSaveAttempted, true);
      assert.equal(bodies.length, 2);
      assert.equal(counter.count(), 1);
      const durable = loadAllSessions(db).find((item) => item.id === state.id)!;
      assert.equal(nativeParts(durable).find((part) => part.responseId === "resp_unsaved_invalidation")!.stored, true,
        "the failed save must not be treated as a durable invalidation");
      const result = durable.messages.flatMap((message) => message.parts).find((part) => part.type === "tool_result" && part.toolCallId === "cursor_local_call");
      assert.ok(result, "the completed local result remains durably recorded despite the later save failure");
    } finally { db.close(); }
  });

  it("does not replay full input for authentication, generic route, unsupported-parameter or network failures", async () => {
    for (const failure of ["auth", "route", "unsupported", "network"] as const) {
      const state = session();
      const counter = cursorCounter();
      const bodies: JsonObject[] = [];
      globalThis.fetch = async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        if (bodies.length === 1) return response("resp_not_rejected", [counter.call]);
        assert.equal(bodies.length, 2, `${failure} must not trigger a fallback or submission retry`);
        if (failure === "network") throw new Error("Connection closed after submission");
        const status = failure === "auth" ? 401 : failure === "route" ? 404 : 400;
        const message = failure === "auth" ? "Invalid API key" : failure === "route" ? "Route not found"
          : "Unsupported parameter: previous_response_id 'resp_not_rejected'";
        return Response.json({ error: { message } }, { status });
      };
      assert.equal((await runAgentTurn(input(state))).status, "error", failure);
      assert.equal(bodies.length, 2, failure);
      assert.equal(nativeParts(state).find((part) => part.responseId === "resp_not_rejected")!.stored, true, "unrelated errors must not invalidate a known stored cursor");
      assert.equal(counter.count(), 1);
    }
  });

  it("stops after one full-input fallback when the fallback also fails or loses the connection", async () => {
    for (const secondFailure of ["missing", "network"] as const) {
      const state = session();
      const counter = cursorCounter();
      const bodies: JsonObject[] = [];
      globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as JsonObject;
        bodies.push(body);
        if (bodies.length === 1) return response("resp_retry_once", [counter.call]);
        if (bodies.length === 2) return missingCursor("resp_retry_once");
        assert.equal(bodies.length, 3, "full-input replay must be attempted at most once");
        assert.equal(body.previous_response_id, undefined);
        if (secondFailure === "network") throw new Error("Connection lost during fallback");
        return missingCursor("resp_retry_once", 404);
      };
      assert.equal((await runAgentTurn(input(state, { client: { ...client, responsesTools: [] } }))).status, "error");
      assert.equal(bodies.length, 3);
      assert.equal(counter.count(), 1);
      assert.equal(nativeParts(state).find((part) => part.responseId === "resp_retry_once")!.stored, false);
    }
  });

  it("never falls back to an older stored chain after the newest cursor is rejected", async () => {
    const state = session();
    const bodies: JsonObject[] = [];
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as JsonObject;
      bodies.push(body);
      if (bodies.length === 1) return response("resp_older_chain", [reasoning(), text("Old answer")]);
      if (bodies.length === 2) {
        assert.equal(body.previous_response_id, "resp_older_chain");
        return response("resp_latest_chain", [reasoning(), text("Recent answer")]);
      }
      if (bodies.length === 3) {
        assert.equal(body.previous_response_id, "resp_latest_chain");
        return missingCursor("resp_latest_chain");
      }
      assert.equal(bodies.length, 4);
      assert.equal(body.previous_response_id, undefined);
      assert.match(JSON.stringify(body.input), /Old answer/);
      assert.match(JSON.stringify(body.input), /Recent answer/);
      return response("resp_rebuilt_chain", [text("Fresh chain")]);
    };
    assert.equal((await runAgentTurn(input(state, { userText: "One" }))).status, "idle");
    assert.equal((await runAgentTurn(input(state, { userText: "Two" }))).status, "idle");
    assert.equal((await runAgentTurn(input(state, { userText: "Three" }))).status, "idle");
    assert.equal(bodies.length, 4);
    assert.equal(nativeParts(state).find((part) => part.responseId === "resp_latest_chain")!.stored, false);
  });

  it("continues from visible history instead of replaying a pending positive MCP approval when its stored cursor disappears", async () => {
    const state = session();
    const mcpClient = { ...client, responsesTools: [{ type: "mcp", server_label: "docs", server_url: "https://mcp.example.com" }] };
    const bodies: JsonObject[] = [];
    let approvals = 0;
    const gate: PermissionGateState = { fullPermissionsEnabled: true, enableFullPermissions: () => {}, requestUserAsk: async () => null,
      requestConfirmation: async () => { approvals += 1; return true; } };
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as JsonObject;
      bodies.push(body);
      if (bodies.length === 1) return response("resp_pending_approval", [{ type: "mcp_approval_request", id: "approval-missing", server_label: "docs", name: "write", arguments: "{}" }]);
      if (bodies.length === 2) return missingCursor("resp_pending_approval");
      if (bodies.length === 3) {
        assert.equal(body.previous_response_id, undefined);
        assert.ok(!hasNativeApproval(body.input), "a positive approval must never reach a stateless replay");
        return response("resp_visible_history", [text("Continuing without the lost approval")]);
      }
      assert.equal(bodies.length, 4);
      assert.equal(body.previous_response_id, undefined, "the rejected cursor disables later stored continuations");
      assert.equal(body.store, false);
      assert.ok(!hasNativeApproval(body.input));
      return response("resp_after_visible", [text("Next")]);
    };
    assert.equal((await runAgentTurn(input(state, { client: mcpClient, gate }))).status, "idle");
    assert.equal(bodies.length, 3);
    assert.equal(approvals, 1);
    assert.equal((await runAgentTurn(input(state, { client: mcpClient, gate, userText: "Next" }))).status, "idle");
    assert.equal(bodies.length, 4);
    assert.equal(approvals, 1);
  });

  it("replays a mixed local-tool continuation from visible records when its cursor is lost, never resubmitting the approval", async () => {
    let state = session();
    const db = openSessionDb(join(root, state.id));
    const counter = cursorCounter();
    const mcpClient = { ...client, responsesTools: [{ type: "mcp", server_label: "docs", server_url: "https://mcp.example.com" }] };
    let posts = 0;
    let approvals = 0;
    const gate: PermissionGateState = { fullPermissionsEnabled: true, enableFullPermissions: () => {}, requestUserAsk: async () => null,
      requestConfirmation: async () => { approvals += 1; return true; } };
    const checkpoint = (): void => { upsertSession(db, state); };
    globalThis.fetch = async (_url, init) => {
      posts += 1;
      if (posts === 1) return response("resp_mixed_missing", [reasoning(), counter.call,
        { type: "mcp_approval_request", id: "approval-mixed-missing", server_label: "docs", name: "write", arguments: "{}" }]);
      const body = JSON.parse(String(init?.body)) as JsonObject;
      const items = body.input as JsonObject[];
      if (posts === 2) {
        assert.equal(body.previous_response_id, "resp_mixed_missing");
        assert.ok(items.some((item) => item.type === "function_call_output" && item.call_id === "cursor_local_call"));
        assert.ok(items.some((item) => item.type === "mcp_approval_response" && item.approval_request_id === "approval-mixed-missing" && item.approve === true));
        assert.equal(counter.count(), 1);
        return missingCursor("resp_mixed_missing");
      }
      if (posts === 3) {
        assert.equal(body.previous_response_id, undefined);
        assert.ok(!hasNativeApproval(items), "a rejected mixed continuation must not replay its approval");
        assert.ok(items.some((item) => item.type === "function_call" && item.call_id === "cursor_local_call"));
        assert.ok(items.some((item) => item.type === "function_call_output" && item.call_id === "cursor_local_call"));
        return response("resp_mixed_visible", [text("Recovered from visible records")]);
      }
      assert.equal(posts, 4);
      assert.equal(body.previous_response_id, undefined, "the rejection stays disabled after reload");
      assert.equal(body.store, false);
      assert.ok(!hasNativeApproval(items));
      return response("resp_mixed_next", [text("Next")]);
    };
    try {
      assert.equal((await runAgentTurn(input(state, { client: mcpClient, gate, checkpoint }))).status, "idle");
      assert.equal(posts, 3);
      assert.equal(counter.count(), 1);
      assert.equal(approvals, 1);
      state = loadAllSessions(db).find((item) => item.id === state.id)!;
      assert.ok(nativeParts(state).some((part) => part.responseId === "resp_mixed_missing" && part.contextReplayBlocked === true),
        "the unsafe native history stays durably excluded from replay");
      assert.equal((await runAgentTurn(input(state, { client: mcpClient, gate, checkpoint, userText: "Next" }))).status, "idle");
      assert.equal(posts, 4);
      assert.equal(counter.count(), 1);
      assert.equal(approvals, 1);
    } finally { db.close(); }
  });

  it("drops consumed historical approvals to visible history when their cursor is lost", async () => {
    let state = session();
    const db = openSessionDb(join(root, state.id));
    const mcpClient = { ...client, responsesTools: [{ type: "mcp", server_label: "docs", server_url: "https://mcp.example.com" }] };
    let posts = 0;
    let approvals = 0;
    const gate: PermissionGateState = { fullPermissionsEnabled: true, enableFullPermissions: () => {}, requestUserAsk: async () => null,
      requestConfirmation: async () => { approvals += 1; return true; } };
    const checkpoint = (): void => { upsertSession(db, state); };
    globalThis.fetch = async (_url, init) => {
      posts += 1;
      const body = JSON.parse(String(init?.body)) as JsonObject;
      if (posts === 1) return response("resp_historical_approval", [{ type: "mcp_approval_request", id: "approval-history", server_label: "docs", name: "write", arguments: "{}" }]);
      if (posts === 2) {
        assert.equal(body.previous_response_id, "resp_historical_approval");
        return response("resp_historical_done", [{ type: "mcp_call", id: "call-history", server_label: "docs", name: "write",
          approval_request_id: "approval-history", status: "completed", output: "Already saved" }, text("Historical write finished")]);
      }
      if (posts === 3) {
        assert.equal(body.previous_response_id, "resp_historical_done");
        return missingCursor("resp_historical_done", 404);
      }
      if (posts === 4) {
        assert.equal(body.previous_response_id, undefined);
        assert.ok(!hasNativeApproval(body.input));
        assert.match(JSON.stringify(body.input), /Historical write finished/, "visible answers stay in context");
        return response("resp_after_visible_history", [text("Fresh task")]);
      }
      assert.equal(posts, 5);
      assert.equal(body.previous_response_id, undefined);
      assert.equal(body.store, false);
      return response("resp_after_reload", [text("Still fine")]);
    };
    try {
      assert.equal((await runAgentTurn(input(state, { client: mcpClient, gate, checkpoint }))).status, "idle");
      assert.equal((await runAgentTurn(input(state, { client: mcpClient, gate, checkpoint, userText: "Two" }))).status, "idle");
      assert.equal(posts, 4);
      state = loadAllSessions(db).find((item) => item.id === state.id)!;
      assert.ok(nativeParts(state).some((part) => part.contextReplayBlocked === true));
      assert.equal((await runAgentTurn(input(state, { client: mcpClient, gate, checkpoint, userText: "Three" }))).status, "idle");
      assert.equal(posts, 5);
      assert.equal(approvals, 1);
    } finally { db.close(); }
  });

  it("migrates a legacy replay barrier into visible-only history instead of refusing new turns", async () => {
    const state = session();
    const scope = reasoningScopeForClient(client);
    state.messages.push(
      { id: "legacy-user", role: "user", createdAt: 1, parts: [{ type: "text", text: "Earlier" }] },
      { id: "legacy-done", role: "assistant", createdAt: 1, parts: [{ type: "text", text: "Earlier write done" }, { type: "model_response",
        providerScope: scope, responseId: "resp_legacy_done", status: "completed", stored: false,
        output: [{ type: "mcp_approval_request", id: "approval-legacy", server_label: "docs", name: "write", arguments: "{}" },
          { type: "mcp_approval_response", approval_request_id: "approval-legacy", approve: true }, text("Earlier write done")] }] },
      { id: "legacy-blocked", role: "assistant", createdAt: 1, parts: [{ type: "model_response",
        providerScope: scope, responseId: "", status: "rejected", stored: false, output: [], contextReplayBlocked: true }] },
    );
    let sent: JsonObject | undefined;
    globalThis.fetch = async (_url, init) => { sent = JSON.parse(String(init?.body)); return response("resp_after_legacy", [text("Works")]); };
    assert.equal((await runAgentTurn(input(state))).status, "idle");
    assert.equal(sent!.previous_response_id, undefined);
    assert.ok(!hasNativeApproval(sent!.input));
    assert.match(JSON.stringify(sent!.input), /Earlier write done/);
    assert.equal(nativeParts(state).find((part) => part.responseId === "resp_legacy_done")!.contextReplayBlocked, true);
  });

  it("records hosted activities and citations without local execution or duplicated final text", async () => {
    const state = session();
    const bodies: JsonObject[] = [];
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), client.baseUrl);
      bodies.push(JSON.parse(String(init?.body)));
      return response("resp_native", [reasoning(), search(), text("Answer from hosted search")]);
    };
    assert.equal((await runAgentTurn(input(state))).status, "idle");
    assert.equal(bodies.length, 1);
    assert.equal((bodies[0]!.tools as JsonObject[]).filter((tool) => tool.type === "web_search").length, 1);
    const assistant = state.messages.find((message) => message.role === "assistant")!;
    assert.equal(assistant.parts.find((part) => part.type === "text")?.text, "Answer from hosted search");
    assert.equal(assistant.parts.find((part) => part.type === "text")?.annotations?.[0]!.type, "url_citation");
    assert.equal(assistant.parts.filter((part) => part.type === "hosted_tool").length, 1);
    assert.equal(state.messages.filter((message) => message.role === "tool").length, 0);
    assert.match(JSON.stringify(nativeParts(state)[0]!.output), /opaque-native-reasoning/);
  });

  for (const stateful of [true, false]) {
    it(`mixes hosted and local tools with ${stateful ? "stored cursor" : "stateless exact item replay"}`, async () => {
      const state = session();
      const bodies: JsonObject[] = [];
      globalThis.fetch = async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return bodies.length === 1 ? response("resp_tools", [reasoning(), search(), functionCall()])
          : response("resp_done", [text("Finished")]);
      };
      assert.equal((await runAgentTurn(input(state, { client: { ...client, responsesStateful: stateful } }))).status, "idle");
      assert.equal(bodies.length, 2);
      const next = bodies[1]!;
      const items = next.input as JsonObject[];
      assert.ok(items.some((item) => item.type === "function_call_output" && item.call_id === "call_time"));
      assert.equal(next.previous_response_id, stateful ? "resp_tools" : undefined);
      if (stateful) assert.equal(items.some((item) => item.type === "reasoning"), false);
      else assert.ok(items.some((item) => item.type === "reasoning" && item.encrypted_content === "opaque-native-reasoning"));
      assert.equal(state.messages.filter((message) => message.role === "tool").length, 1);
    });
  }

  it("preserves a stored cursor through SQLite reload and resets it after clear or binding changes", async () => {
    let state = session();
    const db = openSessionDb(join(root, state.id));
    const bodies: JsonObject[] = [];
    globalThis.fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return response(`resp_${bodies.length}`, [reasoning(), text(`Answer ${bodies.length}`)]);
    };
    try {
      await runAgentTurn(input(state, { checkpoint: () => upsertSession(db, state) }));
      upsertSession(db, state);
      state = loadAllSessions(db)[0]!;
      await runAgentTurn(input(state, { userText: "Next" }));
      assert.equal(bodies[1]!.previous_response_id, "resp_1");
      await runAgentTurn(input(state, { client: { ...client, model: "different" }, userText: "Switch model" }));
      assert.equal(bodies[2]!.previous_response_id, undefined);
      assert.ok(!JSON.stringify(bodies[2]!.input).includes("opaque-native-reasoning"));
      state.messages.push({ id: `clear-${++sequence}`, role: "system", createdAt: 3,
        parts: [{ type: "context_clear", id: "clear", clearedMessageCount: state.messages.length }] });
      await runAgentTurn(input(state, { userText: "Fresh" }));
      assert.equal(bodies[3]!.previous_response_id, undefined);
      assert.ok(!JSON.stringify(bodies[3]!.input).includes("Answer 1"));
    } finally { db.close(); }
  });

  it("filters hosted tools at the final Graph request boundary", async () => {
    const state = session();
    const graph = createReactGraphConfig();
    const agent = graph.nodes.find((node) => node.id === "agent")!;
    const actions = agent.actions!;
    const callIndex = actions.findIndex((action) => action.type === "NodeActionCallModel");
    assert.ok(callIndex > 0);
    actions.splice(callIndex, 0, { type: "NodeActionDisableTools", params: { toolNames: ["web_search"], merge: true } });
    let tools: JsonObject[] = [];
    globalThis.fetch = async (_url, init) => {
      tools = JSON.parse(String(init?.body)).tools;
      return response("resp_policy", [text("Allowed")]);
    };
    assert.equal((await runAgentTurn(input(state, { fsmGraphConfig: graph }))).status, "idle");
    assert.equal(tools.some((tool) => tool.type === "web_search"), false);
    assert.equal(tools.some((tool) => tool.type === "code_interpreter"), true);
  });

  it("does not submit a saved MCP approval after Graph policy disables its server", async () => {
    const state = session();
    const mcpClient: OpenAiCompatibleClientConfig = { ...client,
      responsesTools: [{ type: "mcp", server_label: "docs", server_url: "https://mcp.example.com" }] };
    state.messages.push({ id: "saved-mixed", role: "assistant", createdAt: 1, parts: [{ type: "model_response",
      providerScope: reasoningScopeForClient(mcpClient), responseId: "resp_saved_mixed", status: "completed", stored: true,
      output: [functionCall(), { type: "mcp_approval_request", id: "approval-saved", server_label: "docs", name: "write", arguments: "{}" }],
      continuationInput: [{ type: "mcp_approval_response", approval_request_id: "approval-saved", approve: true }],
      hostedEffects: true,
    }] });
    const graph = createReactGraphConfig();
    const actions = graph.nodes.find((node) => node.id === "agent")!.actions!;
    actions.splice(actions.findIndex((action) => action.type === "NodeActionCallModel"), 0,
      { type: "NodeActionDisableTools", params: { toolNames: ["docs"], merge: true, hardFilter: false } });
    const bodies: JsonObject[] = [];
    let denialCheckpointed = false;
    const checkpoint = (): void => {
      if (nativeParts(state).find((part) => part.responseId === "resp_saved_mixed")?.continuationInput?.[0]!.approve === false) denialCheckpointed = true;
    };
    globalThis.fetch = async (_url, init) => {
      assert.equal(denialCheckpointed, true);
      bodies.push(JSON.parse(String(init?.body)));
      return response(`resp_policy_resume_${bodies.length}`, [text("Done")]);
    };
    assert.equal((await runAgentTurn(input(state, { client: mcpClient, fsmGraphConfig: graph, checkpoint }))).status, "idle");
    assert.equal((bodies[0]!.tools as JsonObject[]).some((tool) => tool.type === "mcp"), false);
    assert.deepEqual((bodies[0]!.input as JsonObject[]).find((item) => item.type === "mcp_approval_response"),
      { type: "mcp_approval_response", approval_request_id: "approval-saved", approve: false });
    assert.equal(nativeParts(state)[0]!.continuationInput?.[0]!.approve, false);
    assert.equal((await runAgentTurn(input(state, { client: mcpClient, fsmGraphConfig: graph, checkpoint }))).status, "idle");
    assert.equal(bodies[1]!.previous_response_id, "resp_policy_resume_1");
    assert.equal((bodies[1]!.input as JsonObject[]).some((item) => item.type === "mcp_approval_response"), false);
  });

  it("preserves already consumed MCP approval history when stateless replay later disables that server", async () => {
    const state = session();
    const mcpClient: OpenAiCompatibleClientConfig = { ...client, responsesStateful: false,
      responsesTools: [{ type: "mcp", server_label: "docs", server_url: "https://mcp.example.com" }] };
    const pastAnswer: JsonObject = { type: "mcp_approval_response", approval_request_id: "approval-consumed", approve: true };
    state.messages.push({ id: "past-approved", role: "assistant", createdAt: 1, parts: [{ type: "model_response",
      providerScope: reasoningScopeForClient(mcpClient), responseId: "resp_consumed", status: "completed", stored: false,
      output: [{ type: "mcp_approval_request", id: "approval-consumed", server_label: "docs", name: "write", arguments: "{}" },
        pastAnswer, { type: "mcp_call", id: "mcp-consumed", server_label: "docs", name: "write",
          approval_request_id: "approval-consumed", status: "completed", output: "Already saved" }, text("Previous work finished")],
      hostedEffects: true,
    }] });
    const graph = createReactGraphConfig();
    const actions = graph.nodes.find((node) => node.id === "agent")!.actions!;
    actions.splice(actions.findIndex((action) => action.type === "NodeActionCallModel"), 0,
      { type: "NodeActionDisableTools", params: { toolNames: ["docs"], merge: true } });
    let sent: JsonObject | undefined;
    globalThis.fetch = async (_url, init) => { sent = JSON.parse(String(init?.body)); return response("resp_new_work", [text("Continued safely")]); };
    assert.equal((await runAgentTurn(input(state, { client: mcpClient, fsmGraphConfig: graph }))).status, "idle");
    assert.equal((sent!.tools as JsonObject[]).some((tool) => tool.type === "mcp"), false);
    assert.deepEqual((sent!.input as JsonObject[]).find((item) => item.type === "mcp_approval_response"), pastAnswer);
    assert.ok((sent!.input as JsonObject[]).some((item) => item.type === "mcp_call" && item.id === "mcp-consumed"));
  });

  it("handles native MCP approval without handing hosted execution to RunTools", async () => {
    const state = session();
    const bodies: JsonObject[] = [];
    const approvals: unknown[] = [];
    globalThis.fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return bodies.length === 1 ? response("resp_approval", [{ type: "mcp_approval_request", id: "approval-1",
        server_label: "docs", name: "search", arguments: '{"q":"test"}' }])
        : response("resp_approved", [{ type: "mcp_call", id: "mcp-1", name: "search", server_label: "docs", status: "completed", output: "Found" }, text("Approved result")]);
    };
    assert.equal((await runAgentTurn(input(state, { client: { ...client, responsesTools: [{ type: "mcp", server_label: "docs",
      server_url: "https://mcp.example.com" }] }, gate: { fullPermissionsEnabled: false,
      requestConfirmation: async (ask) => { approvals.push(ask); return true; } } as PermissionGateState }))).status, "idle");
    assert.equal(approvals.length, 1);
    assert.equal(bodies[1]!.previous_response_id, "resp_approval");
    assert.deepEqual(bodies[1]!.input, [{ type: "mcp_approval_response", approval_request_id: "approval-1", approve: true }]);
    assert.equal(state.messages.filter((message) => message.role === "tool").length, 0);
  });

  it("denies an undeclared MCP server without asking the user to approve it", async () => {
    const state = session();
    const bodies: JsonObject[] = [];
    let approvals = 0;
    const gate: PermissionGateState = { fullPermissionsEnabled: true,
      requestConfirmation: async () => { approvals += 1; return true; },
      enableFullPermissions: () => {}, requestUserAsk: async () => null };
    globalThis.fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return bodies.length === 1 ? response("resp_undeclared", [{ type: "mcp_approval_request", id: "approval-undeclared",
        server_label: "unknown", name: "write", arguments: "{}" }]) : response("resp_denied", [text("Tool unavailable")]);
    };
    assert.equal((await runAgentTurn(input(state, { gate }))).status, "idle");
    assert.equal(approvals, 0);
    assert.equal(bodies.length, 2);
    assert.deepEqual(bodies[1]!.input, [{ type: "mcp_approval_response", approval_request_id: "approval-undeclared", approve: false }]);
  });

  it("rejects a saved write approval when current MCP allowed_tools narrows to read-only tools", async () => {
    const state = session();
    const mcpClient: OpenAiCompatibleClientConfig = { ...client,
      responsesTools: [{ type: "mcp", server_label: "docs", server_url: "https://mcp.example.com", allowed_tools: { read_only: true } }] };
    state.messages.push({ id: "saved-write", role: "assistant", createdAt: 1, parts: [{ type: "model_response",
      providerScope: reasoningScopeForClient(mcpClient), responseId: "resp_saved_write", status: "completed", stored: true,
      output: [{ type: "mcp_list_tools", id: "list-write", server_label: "docs", tools: [{ name: "write", input_schema: { type: "object" },
        annotations: { readOnlyHint: false } }] }, { type: "mcp_approval_request", id: "approval-write", server_label: "docs", name: "write", arguments: "{}" }],
      continuationInput: [{ type: "mcp_approval_response", approval_request_id: "approval-write", approve: true }], hostedEffects: true,
    }] });
    let sent: JsonObject | undefined;
    globalThis.fetch = async (_url, init) => { sent = JSON.parse(String(init?.body)); return response("resp_no_write", [text("Denied")]); };
    assert.equal((await runAgentTurn(input(state, { client: mcpClient }))).status, "idle");
    assert.deepEqual((sent!.input as JsonObject[]).find((item) => item.type === "mcp_approval_response"),
      { type: "mcp_approval_response", approval_request_id: "approval-write", approve: false });
    assert.equal(nativeParts(state)[0]!.continuationInput?.[0]!.approve, false);
  });

  it("allows a read-only MCP approval only when its current native listing proves the read-only hint", async () => {
    const state = session();
    const mcpClient: OpenAiCompatibleClientConfig = { ...client,
      responsesTools: [{ type: "mcp", server_label: "docs", server_url: "https://mcp.example.com", allowed_tools: { read_only: true } }] };
    const bodies: JsonObject[] = [];
    let approvals = 0;
    const gate: PermissionGateState = { fullPermissionsEnabled: true,
      requestConfirmation: async () => { approvals += 1; return true; }, enableFullPermissions: () => {}, requestUserAsk: async () => null };
    globalThis.fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return bodies.length === 1 ? response("resp_readonly", [{ type: "mcp_list_tools", id: "list-read", server_label: "docs",
        tools: [{ name: "read", input_schema: { type: "object" }, annotations: { readOnlyHint: true } }] },
      { type: "mcp_approval_request", id: "approval-read", server_label: "docs", name: "read", arguments: "{}" }])
        : response("resp_readonly_done", [text("Read complete")]);
    };
    assert.equal((await runAgentTurn(input(state, { client: mcpClient, gate }))).status, "idle");
    assert.equal(approvals, 1);
    assert.deepEqual(bodies[1]!.input, [{ type: "mcp_approval_response", approval_request_id: "approval-read", approve: true }]);
  });

  for (const stateful of [true, false]) {
    it(`waits for local function results before mixed MCP approval continuation in ${stateful ? "stored" : "stateless"} mode`, async () => {
      const state = session();
      const bodies: JsonObject[] = [];
      let approvalCount = 0;
      const mcpClient = { ...client, responsesStateful: stateful,
        responsesTools: [{ type: "mcp", server_label: "docs", server_url: "https://mcp.example.com" }] };
      const gate: PermissionGateState = { fullPermissionsEnabled: true,
        requestConfirmation: async () => { approvalCount += 1; return true; },
        enableFullPermissions: () => {}, requestUserAsk: async () => null };
      globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as JsonObject;
        bodies.push(body);
        if (bodies.length === 1) return response("resp_mixed", [reasoning(), functionCall(), {
          type: "mcp_approval_request", id: "approval-mixed", server_label: "docs", name: "write", arguments: "{}",
        }]);
        assert.equal(approvalCount, 1);
        assert.equal(state.messages.filter((message) => message.role === "tool").length, 1);
        const items = body.input as JsonObject[];
        const approval = items.findIndex((item) => item.type === "mcp_approval_response");
        const local = items.findIndex((item) => item.type === "function_call_output");
        assert.ok(approval >= 0 && local > approval);
        assert.equal(items[approval]!.approve, true);
        assert.equal(items[local]!.call_id, "call_time");
        assert.equal(body.previous_response_id, stateful ? "resp_mixed" : undefined);
        if (!stateful) assert.ok(items.some((item) => item.type === "reasoning" && item.encrypted_content === "opaque-native-reasoning"));
        return response("resp_mixed_done", [{ type: "mcp_call", id: "mcp-mixed", server_label: "docs", name: "write",
          approval_request_id: "approval-mixed", status: "completed", output: "Saved" }, text("Mixed work finished")]);
      };
      assert.equal((await runAgentTurn(input(state, { client: mcpClient, gate }))).status, "idle");
      assert.equal(bodies.length, 2);
      assert.equal(approvalCount, 1);
      assert.equal(state.messages.filter((message) => message.role === "tool").length, 1);
      assert.equal(nativeParts(state)[0]!.continuationInput?.[0]!.approval_request_id, "approval-mixed");
    });
  }

  it("allows a new attempt after a definite HTTP rejection without retrieving an empty response ID", async () => {
    const state = session();
    let posts = 0;
    globalThis.fetch = async (_url, init) => {
      assert.equal(init?.method, "POST");
      posts += 1;
      return posts === 1 ? Response.json({ error: { message: "Invalid API key" } }, { status: 401 })
        : response("resp_after_rejection", [text("Accepted")]);
    };
    assert.equal((await runAgentTurn(input(state))).status, "error");
    assert.equal(nativeParts(state)[0]!.status, "rejected");
    assert.equal(nativeParts(state)[0]!.responseId, "");
    assert.equal((await runAgentTurn(input(state))).status, "idle");
    assert.equal(posts, 2);
  });

  it("retrieves a disconnected stored response before continuing, without resubmitting its hosted work", async () => {
    const state = session();
    let posts = 0; let gets = 0;
    globalThis.fetch = async (_url, init) => {
      if (init?.method === "GET") {
        gets += 1;
        return Response.json({ id: "resp_disconnected", status: "completed", output: [search(), text("Recovered result")] });
      }
      posts += 1;
      if (posts === 1) return new Response('data: {"type":"response.created","response":{"id":"resp_disconnected","status":"in_progress","store":true}}\n\n', { headers: { "Content-Type": "text/event-stream" } });
      return response("resp_next", [text("New work")]);
    };
    assert.equal((await runAgentTurn(input(state))).status, "error");
    assert.equal(nativeParts(state)[0]!.responseId, "resp_disconnected");
    assert.equal((await runAgentTurn(input(state, { userText: "New work" }))).status, "idle");
    assert.equal(gets, 1); assert.equal(posts, 2);
    assert.equal(nativeParts(state)[0]!.status, "completed");
    assert.equal(state.messages.some((message) => message.parts.some((part) => part.type === "text" && part.text === "Recovered result")), true);
  });

  it("refuses a fresh request while a recently disconnected hosted response is still running", async () => {
    const state = session();
    state.messages.push({ id: "pending", role: "assistant", createdAt: Date.now(), parts: [{ type: "model_response",
      providerScope: reasoningScopeForClient(client), responseId: "resp_running", status: "in_progress", stored: true, output: [] }] });
    let posts = 0;
    globalThis.fetch = async (_url, init) => {
      if (init?.method !== "GET") posts += 1;
      return Response.json({ id: "resp_running", status: "in_progress", output: [] });
    };
    assert.equal((await runAgentTurn(input(state))).status, "error");
    assert.equal(posts, 0);
    assert.match(state.progressText, /still running.*not submitted again/i);
  });

  it("settles a hosted response that has been running past the recovery window and continues", async () => {
    const state = session();
    state.messages.push({ id: "stale", role: "assistant", createdAt: Date.now() - RESPONSES_RECOVERY_GIVE_UP_MS - 1, parts: [{ type: "model_response",
      providerScope: reasoningScopeForClient(client), responseId: "resp_stuck", status: "in_progress", stored: true, output: [],
      requestSafety: "effects_possible" }] });
    let sent: JsonObject | undefined;
    globalThis.fetch = async (_url, init) => {
      if (init?.method === "GET") return Response.json({ id: "resp_stuck", status: "in_progress", output: [] });
      sent = JSON.parse(String(init?.body));
      return response("resp_after_stuck", [text("Continued")]);
    };
    assert.equal((await runAgentTurn(input(state))).status, "idle");
    assert.equal(nativeParts(state)[0]!.status, "outcome_unknown");
    assert.equal(sent!.previous_response_id, undefined);
    assert.match(JSON.stringify(sent!.input), /interrupted before it finished/);
  });

  it("repairs a completed checkpoint that was saved before local functions were materialized", async () => {
    const state = session();
    state.messages.push({ id: "owner", role: "assistant", createdAt: 1, parts: [{ type: "model_response",
      providerScope: reasoningScopeForClient(client), responseId: "resp_saved", status: "completed", stored: true,
      output: [reasoning(), functionCall()] }] });
    let sent: JsonObject = {};
    globalThis.fetch = async (_url, init) => {
      assert.equal(init?.method, "POST");
      sent = JSON.parse(String(init?.body));
      return response("resp_next", [text("Recovered safely")]);
    };
    assert.equal((await runAgentTurn(input(state))).status, "idle");
    assert.ok((sent.input as JsonObject[]).some((item) => item.type === "function_call_output" && item.call_id === "call_time"));
    const result = state.messages.find((message) => message.role === "tool")!;
    const part = result.parts[0]!;
    assert.ok(part.type === "tool_result" && JSON.stringify(part.content).includes("not executed"));
  });

  it("settles hosted work lost before response.created as unknown and continues without resubmitting it", async () => {
    const state = session();
    const bodies: JsonObject[] = [];
    globalThis.fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      if (bodies.length === 1) throw new Error("Connection lost after submission");
      return response("resp_after_lost", [text("Continued")]);
    };
    assert.equal((await runAgentTurn(input(state))).status, "error");
    assert.equal(bodies.length, 1, "an effects-possible request is never retried automatically");
    assert.equal(nativeParts(state)[0]!.status, "submitting");
    assert.equal((await runAgentTurn(input(state, { userText: "Next" }))).status, "idle");
    assert.equal(bodies.length, 2);
    assert.equal(nativeParts(state)[0]!.status, "outcome_unknown");
    assert.match(JSON.stringify(bodies[1]!.input), /interrupted before it finished/, "the model is told the outcome is unknown");
  });

  it("settles pending stateless hosted work when its known ID is definitely gone, but not on a transient lookup failure", async () => {
    const state = session();
    const stateless = { ...client, responsesStateful: false };
    let posts = 0;
    let gets = 0;
    let lookupOffline = true;
    globalThis.fetch = async (url, init) => {
      if (init?.method === "GET") {
        gets += 1;
        assert.match(String(url), /\/responses\/resp_not_stored$/);
        if (lookupOffline) throw new Error("offline");
        return Response.json({ error: { message: "Response is not retained", code: "not_found" } }, { status: 404 });
      }
      assert.equal(init?.method, "POST");
      posts += 1;
      if (posts === 1) {
        return new Response('data: {"type":"response.created","response":{"id":"resp_not_stored","status":"in_progress","store":false}}\n\n',
          { headers: { "Content-Type": "text/event-stream" } });
      }
      return response("resp_after_gone", [text("Continued")]);
    };
    assert.equal((await runAgentTurn(input(state, { client: stateless }))).status, "error");
    assert.equal(nativeParts(state)[0]!.stored, false);
    assert.equal((await runAgentTurn(input(state, { client: stateless }))).status, "error");
    assert.equal(posts, 1);
    assert.match(state.progressText, /Unable to reach the provider.*not submitted again/i);
    lookupOffline = false;
    assert.equal((await runAgentTurn(input(state, { client: stateless }))).status, "idle");
    assert.equal(posts, 2);
    assert.equal(gets, 2);
    assert.equal(nativeParts(state)[0]!.status, "outcome_unknown");
  });

  it("does not abandon pending hosted work when its provider credential changes", async () => {
    const state = session();
    let requests = 0;
    globalThis.fetch = async () => {
      requests += 1;
      return new Response('data: {"type":"response.created","response":{"id":"resp_old_binding","status":"in_progress","store":true}}\n\n',
        { headers: { "Content-Type": "text/event-stream" } });
    };
    assert.equal((await runAgentTurn(input(state))).status, "error");
    assert.equal((await runAgentTurn(input(state, { client: { ...client, apiKey: "new-mock-key" } }))).status, "error");
    assert.equal(requests, 1);
    assert.match(state.progressText, /unavailable provider binding/i);
  });

  it("restores the completed approval response when its continuation loses the response ID, and denies the approval", async () => {
    const state = session();
    const bodies: JsonObject[] = [];
    globalThis.fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      if (bodies.length === 1) return response("resp_approval", [{ type: "mcp_approval_request", id: "approval-1", server_label: "docs", name: "write", arguments: "{}" }]);
      if (bodies.length === 2) throw new Error("Continuation connection lost");
      return response("resp_after_restore", [text("Continued")]);
    };
    const gate: PermissionGateState = { fullPermissionsEnabled: true, requestConfirmation: async () => true,
      enableFullPermissions: () => {}, requestUserAsk: async () => null };
    const mcpClient = { ...client, responsesTools: [{ type: "mcp", server_label: "docs", server_url: "https://mcp.example.com" }] };
    assert.equal((await runAgentTurn(input(state, { client: mcpClient, gate }))).status, "error");
    assert.equal(nativeParts(state)[0]!.status, "submitting");
    assert.equal(nativeParts(state)[0]!.resumeFrom?.responseId, "resp_approval");
    assert.equal((await runAgentTurn(input(state, { client: mcpClient, gate, userText: "Next" }))).status, "idle");
    assert.equal(bodies.length, 3);
    assert.equal(bodies[2]!.previous_response_id, "resp_approval");
    const items = bodies[2]!.input as JsonObject[];
    assert.deepEqual(items.find((item) => item.type === "mcp_approval_response"),
      { type: "mcp_approval_response", approval_request_id: "approval-1", approve: false });
    assert.equal(items.some((item) => item.type === "mcp_approval_response" && item.approve === true), false);
  });

  it("records a denial when Stop interrupts an MCP approval prompt so the next turn is accepted", async () => {
    const state = session();
    const stop = new AbortController();
    const bodies: JsonObject[] = [];
    globalThis.fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      if (bodies.length === 1) return response("resp_prompted", [{ type: "mcp_approval_request", id: "approval-stop", server_label: "docs", name: "write", arguments: "{}" }]);
      return response("resp_after_stop", [text("Continued")]);
    };
    const gate: PermissionGateState = { fullPermissionsEnabled: true, enableFullPermissions: () => {}, requestUserAsk: async () => null,
      requestConfirmation: () => { stop.abort(); return new Promise<boolean>(() => {}); } };
    const mcpClient = { ...client, responsesTools: [{ type: "mcp", server_label: "docs", server_url: "https://mcp.example.com" }] };
    assert.equal((await runAgentTurn(input(state, { client: mcpClient, gate, signal: stop.signal }))).status, "cancelled");
    assert.deepEqual(nativeParts(state)[0]!.continuationInput,
      [{ type: "mcp_approval_response", approval_request_id: "approval-stop", approve: false }]);
    assert.equal((await runAgentTurn(input(state, { client: mcpClient, gate: { ...gate, requestConfirmation: async () => true }, userText: "Next" }))).status, "idle");
    assert.equal(bodies.length, 2);
    assert.equal(bodies[1]!.previous_response_id, "resp_prompted");
    assert.deepEqual((bodies[1]!.input as JsonObject[])[0],
      { type: "mcp_approval_response", approval_request_id: "approval-stop", approve: false });
  });

  it("answers an approval request left unanswered by a crash before the next continuation", async () => {
    const state = session();
    const mcpClient = { ...client, responsesTools: [{ type: "mcp", server_label: "docs", server_url: "https://mcp.example.com" }] };
    state.messages.push({ id: "crashed", role: "assistant", createdAt: 1, parts: [{ type: "model_response",
      providerScope: reasoningScopeForClient(mcpClient), responseId: "resp_crashed", status: "completed", stored: true,
      output: [{ type: "mcp_approval_request", id: "approval-crash", server_label: "docs", name: "write", arguments: "{}" }] }] });
    let sent: JsonObject | undefined;
    globalThis.fetch = async (_url, init) => { sent = JSON.parse(String(init?.body)); return response("resp_after_crash", [text("Ok")]); };
    assert.equal((await runAgentTurn(input(state, { client: mcpClient }))).status, "idle");
    assert.deepEqual((sent!.input as JsonObject[]).find((item) => item.type === "mcp_approval_response"),
      { type: "mcp_approval_response", approval_request_id: "approval-crash", approve: false });
  });
});
