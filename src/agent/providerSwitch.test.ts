/**
 * An existing Chat Completions transcript must continue on a Responses provider.
 * Private reasoning and any Chat-scoped server cursor stay out of the request.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { reasoningScopeForClient } from "../llm/contextScope.js";
import type { JsonObject } from "../session/types.js";
import type { OpenAiCompatibleClientConfig } from "../llm/types.js";
import { configureUserMemoryRoot } from "../memory/store.js";
import type { Message, Session } from "../session/types.js";
import { configurePromptDefaults } from "../settings/promptDefaults.js";
import type { PermissionGateState } from "../tools/types.js";
import { runAgentTurn } from "./runAgentTurn.js";
import type { RunAgentTurnInput } from "./types.js";
import type { StreamEvent } from "../llm/streamEvents.js";

const originalFetch = globalThis.fetch;
let root = "";
let sequence = 0;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "jellybot-provider-switch-"));
  configureUserMemoryRoot(root);
  configurePromptDefaults(join(process.cwd(), "resources", "prompts"));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

const chatClient: OpenAiCompatibleClientConfig = {
  baseUrl: "https://chat.example/v1",
  apiKey: "chat-key",
  model: "chat-model",
  apiProtocol: "chat_completions",
};

const responsesClient: OpenAiCompatibleClientConfig = {
  baseUrl: "https://api.openai.com/v1",
  apiKey: "responses-key",
  model: "gpt-5",
  apiProtocol: "responses",
};

function session(messages: Message[]): Session {
  return {
    id: "provider-switch",
    type: "agent",
    title: "Old chat",
    createdAt: 1,
    updatedAt: 1,
    status: "idle",
    progressText: "",
    messages,
    providerId: "chat",
    model: chatClient.model,
    workspaceId: "w",
    workspacePath: "",
    pinned: false,
    archived: false,
    archivedAt: null,
    contextUsage: { usedTokens: 0 },
    plan: null,
  };
}

describe("Chat Completions history continued on Responses", () => {
  it("sends visible tool history without the previous provider's reasoning or cursor", async () => {
    const chatScope = reasoningScopeForClient(chatClient);
    assert.notEqual(chatScope, reasoningScopeForClient(responsesClient));
    const history: Message[] = [
      {
        id: "user-1",
        role: "user",
        createdAt: 1,
        parts: [{ type: "text", text: "Read the notes." }],
      },
      {
        id: "assistant-tool",
        role: "assistant",
        createdAt: 2,
        parts: [
          { type: "reasoning", text: "private-chat-thought", providerScope: chatScope },
          { type: "reasoning", text: "legacy-unscoped-thought" },
          {
            type: "tool_call",
            id: "call_read",
            name: "read_file",
            status: "done",
            arguments: { path: "notes.txt" },
            argumentsRaw: "{\"path\":\"notes.txt\"}",
          },
        ],
      },
      {
        id: "tool-read",
        role: "tool",
        createdAt: 3,
        toolCallId: "call_read",
        parts: [{
          type: "tool_result",
          toolCallId: "call_read",
          returnCode: 0,
          content: [{ type: "text", text: "notes: hello" }],
        }],
      },
      {
        id: "assistant-final",
        role: "assistant",
        createdAt: 4,
        parts: [
          { type: "reasoning", text: "private-final-thought", providerScope: chatScope },
          { type: "text", text: "The notes say hello." },
        ],
      },
      {
        id: "assistant-reasoning-only",
        role: "assistant",
        createdAt: 5,
        parts: [{ type: "reasoning", text: "reasoning-only-secret", providerScope: chatScope }],
      },
    ];
    const state = session(history);
    const errors: string[] = [];
    let url = "";
    let body: JsonObject | undefined;
    globalThis.fetch = async (input, init) => {
      url = String(input);
      body = JSON.parse(String(init?.body)) as JsonObject;
      const frame = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`;
      const output = [{
        type: "message",
        id: "msg_switch",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "Still the notes." }],
      }];
      return new Response(
        frame({ type: "response.created", response: { id: "resp_switch", status: "in_progress", store: true } })
        + frame({
          type: "response.completed",
          response: {
            id: "resp_switch",
            status: "completed",
            store: true,
            output,
            usage: { input_tokens: 20, output_tokens: 4, total_tokens: 24 },
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    };

    const input: RunAgentTurnInput = {
      session: state,
      userText: "Summarize that.",
      client: responsesClient,
      gate: { fullPermissionsEnabled: true } as PermissionGateState,
      createId: () => `message-${++sequence}`,
      unlimitedTurnBudgets: true,
      onEvent: (event: StreamEvent) => {
        if (event.type === "error") errors.push(event.message);
      },
    };
    const result = await runAgentTurn(input);

    assert.equal(result.status, "idle", errors.join(" | ") || state.progressText);
    assert.equal(url, "https://api.openai.com/v1/responses");
    assert.ok(body);
    assert.equal(body.previous_response_id, undefined);
    assert.equal("messages" in body, false);
    const items = body.input as JsonObject[];
    assert.ok(Array.isArray(items));
    const serialized = JSON.stringify(items);
    assert.match(serialized, /Read the notes\./);
    assert.match(serialized, /notes: hello/);
    assert.match(serialized, /The notes say hello\./);
    assert.match(serialized, /Summarize that\./);
    for (const secret of [
      "private-chat-thought",
      "legacy-unscoped-thought",
      "private-final-thought",
      "reasoning-only-secret",
    ]) {
      assert.equal(serialized.includes(secret), false, secret);
    }
    assert.equal(items.some((item) => item.role === "tool"), false);
    assert.equal(items.some((item) => item.reasoning_content !== undefined), false);
    const call = items.find((item) => item.type === "function_call" && item.call_id === "call_read");
    assert.ok(call);
    assert.equal(call.name, "read_file");
    assert.equal(call.arguments, "{\"path\":\"notes.txt\"}");
    assert.ok(items.some((item) => item.type === "function_call_output" && item.call_id === "call_read" && item.output === "notes: hello"));
    assert.equal(
      state.messages.some((message) => message.parts.some((part) =>
        part.type === "reasoning" && part.text === "private-chat-thought")),
      true,
    );
    const tools = body.tools as JsonObject[];
    assert.equal(tools[0]?.type, "function");
    assert.equal(typeof tools[0]?.name, "string");
    assert.equal("function" in (tools[0] ?? {}), false);
  });
});
