import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { JsonObject } from "../../../session/types.js";
import { reasoningScopeForClient } from "../../contextScope.js";
import { isLlmEndpointRecentlyActive, resetLlmHealthActivityForTests } from "../../healthActivity.js";
import { clearLlmTimeline, listLlmTimeline } from "../../llmTimeline/recorder.js";
import { chatCompletionOnce, llmEndpointKey, streamChatCompletion } from "../../openaiCompatibleClient.js";
import {
  buildResponsesBody,
  cancelResponse,
  ResponseResourceError,
  responsesOnce,
  retrieveResponse,
} from "./http.js";
import { responsesInputFromMessages } from "./wire.js";
import type { StreamEvent } from "../../streamEvents.js";
import type { OpenAiChatMessage, OpenAiCompatibleClientConfig, StreamChatOptions } from "../../types.js";

const originalFetch = globalThis.fetch;
const CONFIG: OpenAiCompatibleClientConfig = {
  baseUrl: "https://responses.example.com/v1", apiKey: "mock-key", model: "mock-model", apiProtocol: "responses", responsesStateful: true,
};
const messages: OpenAiChatMessage[] = [{ role: "user", content: "Hello" }];
const functionItem: JsonObject = { type: "function_call", id: "fc_native", call_id: "call_local", name: "read_file", arguments: '{"path":"a"}', status: "completed" };
const messageItem: JsonObject = { type: "message", id: "msg_native", role: "assistant", status: "completed",
  content: [{ type: "output_text", text: "Visible answer", annotations: [{ type: "url_citation", url: "https://example.com", title: "Example", start_index: 0, end_index: 3 }] }] };
function completed(output: JsonObject[] = [messageItem]): JsonObject {
  return { id: "resp_mock", status: "completed", store: true, output,
    usage: { input_tokens: 12, output_tokens: 5, total_tokens: 17, input_tokens_details: { cached_tokens: 7 } } };
}
const frame = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`;
function installSse(events: JsonObject[]): void {
  globalThis.fetch = async () => new Response(events.map(frame).join(""), { headers: { "Content-Type": "text/event-stream" } });
}
async function collect(options: Partial<StreamChatOptions> = {}, config = CONFIG): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of streamChatCompletion(config, { messages, ...options })) events.push(event);
  return events;
}
afterEach(() => { globalThis.fetch = originalFetch; clearLlmTimeline(); resetLlmHealthActivityForTests(); });

describe("Responses request mapping", () => {
  it("converts text/images, flattened functions and function outputs without Chat reasoning", () => {
    const wire = responsesInputFromMessages([
      { role: "system", content: "System" },
      { role: "user", content: [{ type: "text", text: "See" }, { type: "image_url", image_url: { url: "data:image/png;base64,AA", detail: "low" } }] },
      { role: "assistant", content: "Answer", reasoning_content: "private", tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "file content" },
    ]);
    assert.deepEqual(wire, [
      { role: "system", content: "System" },
      { role: "user", content: [{ type: "input_text", text: "See" }, { type: "input_image", image_url: "data:image/png;base64,AA", detail: "low" }] },
      { role: "assistant", content: "Answer" },
      { type: "function_call", call_id: "call_1", name: "read", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "file content" },
    ]);
  });

  it("replays complete native output only for an explicitly matching binding", () => {
    const output: JsonObject[] = [{ type: "reasoning", id: "rs_1", encrypted_content: "opaque", summary: [] }, functionItem, messageItem];
    const history: OpenAiChatMessage[] = [{ role: "assistant", content: "Visible answer", responsesOutput: {
      providerScope: "scope-a", responseId: "resp_a", status: "completed", stored: true, output,
    } }];
    assert.deepEqual(responsesInputFromMessages(history, "scope-a"), output);
    assert.deepEqual(responsesInputFromMessages(history, "scope-b"), [{ role: "assistant", content: "Visible answer" }]);
    assert.deepEqual(responsesInputFromMessages(history), [{ role: "assistant", content: "Visible answer" }]);
  });

  it("appends pending MCP approval inputs after native output only in the owning scope", () => {
    const approval: JsonObject = { type: "mcp_approval_response", approval_request_id: "approval_1", approve: true };
    const history: OpenAiChatMessage[] = [{ role: "assistant", content: "Visible answer", responsesOutput: {
      providerScope: "scope-a", responseId: "resp_a", status: "completed", stored: true,
      output: [messageItem], continuationInput: [approval],
    } }];
    assert.deepEqual(responsesInputFromMessages(history, "scope-a"), [messageItem, approval]);
    assert.deepEqual(responsesInputFromMessages(history, "scope-b"), [{ role: "assistant", content: "Visible answer" }]);
    assert.deepEqual(history[0]!.responsesOutput!.output, [messageItem]);
  });

  it("protects policy-owned fields, maps legacy options and never auto-adds configured native tools", () => {
    const body = buildResponsesBody({ ...CONFIG, responsesTools: [{ type: "web_search" }], responsesStateful: false }, {
      messages, tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }],
      extraBody: { reasoning_effort: "high", thinking: { type: "disabled" }, enableReasoning: false,
        max_tokens: 300, response_format: { type: "json_schema", json_schema: { name: "test", strict: false, schema: { type: "object" } } } },
    }, true);
    assert.equal(body.store, false);
    assert.equal(body.background, false);
    assert.deepEqual(body.reasoning, { effort: "high", summary: "auto" });
    assert.deepEqual(body.text, { format: { type: "json_schema", name: "test", strict: false, schema: { type: "object" } } });
    assert.equal(body.max_output_tokens, 300);
    assert.deepEqual(body.tools, [{ type: "function", name: "read", parameters: { type: "object" }, strict: false }]);
    assert.deepEqual(body.include, ["reasoning.encrypted_content"]);
    for (const field of ["thinking", "enableReasoning", "reasoning_effort", "response_format", "max_tokens"]) assert.equal(field in body, false);
    for (const field of ["input", "model", "tools", "store", "stream", "conversation", "previous_response_id"]) {
      assert.throws(() => buildResponsesBody(CONFIG, { messages, extraBody: { [field]: "override" } }, true), /cannot override/);
    }
  });

  it("defaults omitted state to store:false while preserving explicit stateful overrides", async () => {
    const kimi: OpenAiCompatibleClientConfig = { ...CONFIG, baseUrl: "https://api.kimi.com/coding/v1", apiProtocol: "auto", model: "kimi-for-coding" };
    delete kimi.responsesStateful;
    let sent: JsonObject | undefined;
    let endpoint = "";
    globalThis.fetch = async (url, init) => {
      endpoint = String(url);
      sent = JSON.parse(String(init?.body)) as JsonObject;
      return Response.json({ ...completed(), store: false });
    };
    const events = await collect({}, kimi);
    assert.equal(endpoint, "https://api.kimi.com/coding/v1/responses");
    assert.equal(sent!.store, false);
    assert.equal(sent!.previous_response_id, undefined);
    assert.ok(events.some((event) => event.type === "response_state" && event.status === "completed" && event.stored === false));
    assert.equal(buildResponsesBody({ ...kimi, responsesStateful: true }, { messages }, true).store, true);
    assert.equal(buildResponsesBody({ ...kimi, responsesStateful: false }, { messages }, true).store, false);
    const defaultConfig = { ...CONFIG };
    delete defaultConfig.responsesStateful;
    assert.equal(buildResponsesBody(defaultConfig, { messages }, true).store, false);
  });

  it("uses exact supplied native inputs and previous ID, with explicit native tools and cache key", () => {
    const input: JsonObject[] = [{ type: "function_call_output", call_id: "call", output: "cached result" }];
    const body = buildResponsesBody(CONFIG, { messages, responses: { input, previousResponseId: "resp_prior" },
      nativeTools: [{ type: "web_search" }], promptCacheKey: "cache", extraBody: { max_completion_tokens: 512 } }, true);
    assert.equal(body.input, input);
    assert.equal(body.previous_response_id, "resp_prior");
    assert.equal(body.prompt_cache_key, "cache");
    assert.equal(body.max_output_tokens, 512);
    assert.deepEqual(body.tools, [{ type: "web_search" }]);
  });

  it("explicitly clears tools on a continuation when the current request offers none", async () => {
    let sent: JsonObject | undefined;
    globalThis.fetch = async (_url, init) => {
      sent = JSON.parse(String(init?.body)) as JsonObject;
      return Response.json(completed());
    };
    await collect({ tools: [], nativeTools: [], responses: { input: [], previousResponseId: "resp_old_tools" } },
      { ...CONFIG, responsesTools: [{ type: "mcp", server_label: "old", server_url: "https://example.com" }] });
    assert.deepEqual(sent!.tools, []);
    assert.equal(sent!.previous_response_id, "resp_old_tools");
  });

  it("omits encrypted reasoning from timeline copies while preserving request and response replay data", async () => {
    const input: JsonObject[] = [{ type: "reasoning", id: "rs_prior", encrypted_content: "PRIVATE_INPUT_CIPHERTEXT", summary: [] }];
    const output: JsonObject[] = [{ type: "reasoning", id: "rs_new", encrypted_content: "PRIVATE_OUTPUT_CIPHERTEXT",
      summary: [{ type: "summary_text", text: "Visible summary" }] }, messageItem];
    let sent: JsonObject | undefined;
    globalThis.fetch = async (_url, init) => {
      sent = JSON.parse(String(init?.body)) as JsonObject;
      return Response.json(completed(output));
    };
    const events = await collect({ responses: { input }, meta: { sessionId: "redacted-native" } });
    assert.deepEqual(sent!.input, input);
    assert.equal(input[0]!.encrypted_content, "PRIVATE_INPUT_CIPHERTEXT");
    const state = events.find((event) => event.type === "response_state" && event.output);
    assert.ok(state?.type === "response_state");
    assert.deepEqual(state.output, output);
    const snapshot = listLlmTimeline("redacted-native");
    const timeline = snapshot.records[0];
    assert.ok(timeline?.kind === "llm");
    assert.match(timeline.reqRaw!, /\[opaque reasoning omitted\]/);
    assert.match(timeline.reasoningRaw!, /Visible summary/);
    assert.equal(JSON.stringify(snapshot).includes("PRIVATE_INPUT_CIPHERTEXT"), false);
    assert.equal(JSON.stringify(snapshot).includes("PRIVATE_OUTPUT_CIPHERTEXT"), false);
  });

  it("redacts MCP authorization case-insensitively from timeline without changing HTTP credentials", async () => {
    let sent: JsonObject | undefined;
    globalThis.fetch = async (_url, init) => {
      sent = JSON.parse(String(init?.body)) as JsonObject;
      return Response.json(completed());
    };
    const nativeTools: JsonObject[] = [{ type: "mcp", server_label: "private", server_url: "https://mcp.example.com",
      authorization: "PRIVATE_MCP_BEARER_SECRET", headers: { aUtHoRiZaTiOn: "Bearer PRIVATE_MCP_HEADER_SECRET" } }];
    await collect({ nativeTools, meta: { sessionId: "redacted-mcp-auth" } });
    assert.deepEqual(sent!.tools, nativeTools);
    assert.equal(nativeTools[0]!.authorization, "PRIVATE_MCP_BEARER_SECRET");
    const timeline = listLlmTimeline("redacted-mcp-auth").records[0];
    assert.ok(timeline?.kind === "llm");
    assert.equal(timeline.reqRaw!.includes("PRIVATE_MCP_BEARER_SECRET"), false);
    assert.equal(timeline.reqRaw!.includes("PRIVATE_MCP_HEADER_SECRET"), false);
    assert.match(timeline.reqRaw!, /\[authorization omitted\]/);
    assert.match(timeline.reqRaw!, /mcp\.example\.com/);
  });

  it("allows supported hosted types and rejects client-executed or unknown native types before fetch", () => {
    for (const type of ["web_search", "web_search_preview", "file_search", "code_interpreter", "image_generation", "mcp"]) {
      assert.deepEqual(buildResponsesBody(CONFIG, { messages, nativeTools: [{ type }] }, true).tools, [{ type }]);
    }
    for (const type of ["shell", "local_shell", "computer", "computer_use_preview", "apply_patch", "custom", "function", "agent", "multi_agent", "programmatic", "future_tool"]) {
      assert.throws(() => buildResponsesBody(CONFIG, { messages, nativeTools: [{ type }] }, true), /Unsupported native Responses tool/);
    }
  });

  it("honors disableReasoning over legacy effort and drops Chat-only nested reasoning switches", () => {
    const body = buildResponsesBody({ ...CONFIG, disableReasoning: true, reasoningEffort: "high" }, {
      messages, extraBody: { reasoning_effort: "low", reasoning: { enabled: false, exclude: true, summary: "concise" } },
    }, true);
    assert.deepEqual(body.reasoning, { effort: "none", summary: "concise" });
    assert.equal("reasoning" in buildResponsesBody(CONFIG, { messages, extraBody: { reasoning: { enabled: false } } }, true), false);
  });

  it("strips native history metadata from serialized Chat requests", async () => {
    let body: Record<string, unknown> | undefined;
    globalThis.fetch = async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return Response.json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
    };
    await chatCompletionOnce({ ...CONFIG, apiProtocol: "chat_completions" }, { messages: [{ role: "assistant", content: "prior", responsesOutput: {
      providerScope: "other", responseId: "resp", status: "completed", stored: true, output: [messageItem],
    } }] });
    assert.equal("responsesOutput" in (body!.messages as Record<string, unknown>[])[0]!, false);
  });
});

describe("Responses stream lifecycle", () => {
  it("never upgrades a stateless request when created and terminal payloads incorrectly claim store:true", async () => {
    installSse([{ type: "response.created", response: { id: "resp_mock", status: "in_progress", store: true } },
      { type: "response.completed", response: completed() }]);
    const events = await collect({}, { ...CONFIG, responsesStateful: false });
    const states = events.filter((event) => event.type === "response_state");
    assert.deepEqual(states.map((event) => event.status), ["submitting", "in_progress", "completed"]);
    assert.ok(states.every((event) => event.stored === false));
    assert.deepEqual(events.at(-1), { type: "done", reason: "completed" });
  });

  it("requires requested storage and also honors a server's explicit store:false", async () => {
    installSse([{ type: "response.created", response: { id: "resp_mock", status: "in_progress", store: false } },
      { type: "response.completed", response: { ...completed(), store: false } }]);
    const events = await collect();
    assert.equal(events.find((event) => event.type === "response_state" && event.status === "submitting")?.type, "response_state");
    assert.ok(events.filter((event) => event.type === "response_state").filter((event) => event.responseId).every((event) => event.stored === false));
  });

  it("emits early state, hosted status, summary and raw complete output; flushes functions by call_id last", async () => {
    const reasoning: JsonObject = { type: "reasoning", id: "rs_opaque", summary: [{ type: "summary_text", text: "Summary" }], encrypted_content: "opaque-data" };
    const web: JsonObject = { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", query: "test" } };
    const final = completed([reasoning, web, functionItem, messageItem]);
    installSse([
      { type: "response.created", response: { id: "resp_mock", status: "in_progress", store: true } },
      { type: "response.output_item.added", item: { ...functionItem, status: "in_progress", arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: "fc_native", delta: '{"path":"a"}' },
      { type: "response.output_item.done", item: functionItem },
      { type: "response.output_item.added", item: { ...web, status: "in_progress" } },
      { type: "response.reasoning_summary_text.delta", delta: "Summary" },
      { type: "response.output_text.delta", delta: "Visible " },
      { type: "response.completed", response: final },
    ]);
    const events = await collect({ nativeTools: [{ type: "web_search" }], meta: { sessionId: "responses-timeline" } });
    const states = events.filter((event) => event.type === "response_state");
    assert.equal(states[0]?.status, "submitting");
    assert.equal(states.find((event) => event.status === "in_progress")?.responseId, "resp_mock");
    assert.deepEqual(states.at(-1)?.output, final.output);
    assert.deepEqual(events.filter((event) => event.type === "tool_call").map((event) => event.id), ["call_local"]);
    assert.ok(events.some((event) => event.type === "hosted_tool" && event.id === "ws_1" && event.status === "completed"));
    assert.equal(events.filter((event) => event.type === "text_delta").map((event) => event.text).join(""), "Visible answer");
    assert.equal(events.filter((event) => event.type === "reasoning_delta").map((event) => event.text).join(""), "Summary");
    assert.ok(events.findIndex((event) => event.type === "response_state" && event.output) < events.findIndex((event) => event.type === "tool_call"));
    assert.deepEqual(events.at(-1), { type: "done", reason: "completed" });
    assert.ok(isLlmEndpointRecentlyActive(llmEndpointKey(CONFIG), 60_000));
    assert.equal(listLlmTimeline("responses-timeline").records[0]?.kind, "llm");
    const timeline = listLlmTimeline("responses-timeline").records[0];
    assert.ok(timeline?.kind === "llm");
    assert.equal(timeline.cachedTokens, 7);
  });

  it("streams GLM-style reasoning_text deltas and does not duplicate the final content payload", async () => {
    // GLM /v1/responses has no reasoning_summary_* events: the raw chain lives
    // in the reasoning item's content (reasoning_text) and streams via
    // response.reasoning_text.delta.
    const glmReasoning: JsonObject = { type: "reasoning", id: "rs_glm",
      content: [{ type: "reasoning_text", text: "Let me check the request mapping." }] };
    installSse([
      { type: "response.created", response: { id: "resp_mock", status: "in_progress", store: true } },
      { type: "response.reasoning_text.delta", delta: "Let me check the " },
      { type: "response.reasoning_text.delta", delta: "request mapping." },
      { type: "response.output_text.delta", delta: "Visible " },
      { type: "response.completed", response: completed([glmReasoning, messageItem]) },
    ]);
    const events = await collect();
    assert.equal(events.filter((event) => event.type === "reasoning_delta").map((event) => event.text).join(""),
      "Let me check the request mapping.");
    assert.equal(events.filter((event) => event.type === "text_delta").map((event) => event.text).join(""), "Visible answer");
    assert.deepEqual(events.at(-1), { type: "done", reason: "completed" });
  });

  it("recovers GLM-style reasoning from the final output when no reasoning delta streamed", async () => {
    const glmReasoning: JsonObject = { type: "reasoning", id: "rs_glm",
      content: [{ type: "reasoning_text", text: "Silent full chain." }] };
    installSse([
      { type: "response.created", response: { id: "resp_mock", status: "in_progress", store: true } },
      { type: "response.output_text.delta", delta: "Visible " },
      { type: "response.completed", response: completed([glmReasoning, messageItem]) },
    ]);
    const events = await collect();
    assert.equal(events.filter((event) => event.type === "reasoning_delta").map((event) => event.text).join(""),
      "Silent full chain.");
  });

  it("extracts summary and content reasoning together without duplicating streamed prefixes", async () => {
    const mixed: JsonObject = { type: "reasoning", id: "rs_mix",
      summary: [{ type: "summary_text", text: "Summary part." }],
      content: [{ type: "reasoning_text", text: "Raw part." }] };
    installSse([
      { type: "response.created", response: { id: "resp_mock", status: "in_progress", store: true } },
      { type: "response.reasoning_summary_text.delta", delta: "Summary part." },
      { type: "response.completed", response: completed([mixed, messageItem]) },
    ]);
    const events = await collect();
    assert.equal(events.filter((event) => event.type === "reasoning_delta").map((event) => event.text).join(""),
      "Summary part.Raw part.");
  });

  for (const status of ["failed", "incomplete", "cancelled"]) {
    it(`does not flush executable functions for a ${status} response`, async () => {
      installSse([{ type: "response.created", response: { id: "resp_mock", status: "in_progress" } },
        { type: "response.output_item.done", item: functionItem },
        { type: `response.${status}`, response: { ...completed([functionItem]), status } }]);
      const events = await collect();
      assert.equal(events.some((event) => event.type === "tool_call"), false);
      assert.ok(events.some((event) => event.type === "response_state" && event.status === status));
      assert.deepEqual(events.at(-1), { type: "done", reason: "error" });
    });
  }

  it("rejects EOF after a function item is done without response.completed", async () => {
    installSse([{ type: "response.output_item.done", item: functionItem }]);
    const events = await collect();
    assert.equal(events.some((event) => event.type === "tool_call"), false);
    assert.deepEqual(events.at(-1), { type: "done", reason: "error" });
  });

  it("rejects all functions if any final function item is incomplete", async () => {
    installSse([{ type: "response.completed", response: completed([functionItem, { ...functionItem, call_id: "second", status: "in_progress" }]) }]);
    const events = await collect();
    assert.equal(events.some((event) => event.type === "tool_call"), false);
    assert.deepEqual(events.at(-1), { type: "done", reason: "error" });
  });

  it("preserves MCP approvals and list results as native output without executable local calls", async () => {
    const approval: JsonObject = { type: "mcp_approval_request", id: "approval_1", server_label: "remote", name: "write_note", arguments: "{}" };
    const list: JsonObject = { type: "mcp_list_tools", id: "list_1", server_label: "remote", tools: [{ name: "write_note", input_schema: { type: "object" } }] };
    installSse([{ type: "response.created", response: { id: "resp_mock", status: "in_progress" } },
      { type: "response.completed", response: completed([list, approval]) }]);
    const events = await collect({ nativeTools: [{ type: "mcp", server_label: "remote", server_url: "https://example.com" }] });
    const finalState = events.find((event) => event.type === "response_state" && event.output);
    assert.ok(finalState?.type === "response_state");
    assert.deepEqual(finalState.output, [list, approval]);
    assert.equal(events.some((event) => event.type === "tool_call"), false);
    assert.equal(events.filter((event) => event.type === "hosted_tool").length, 2);
    assert.deepEqual(events.at(-1), { type: "done", reason: "completed" });
  });

  it("rejects unsupported client-owned outputs without mislabeling them or delivering earlier functions", async () => {
    for (const type of ["shell_call", "computer_call", "apply_patch_call", "custom_tool_call", "future_call"]) {
      const unknown: JsonObject = { type, id: "unsupported_1", status: "completed" };
      installSse([{ type: "response.output_item.added", item: unknown },
        { type: "response.completed", response: completed([functionItem, unknown]) }]);
      const events = await collect();
      assert.equal(events.some((event) => event.type === "tool_call"), false);
      assert.equal(events.some((event) => event.type === "hosted_tool"), false);
      assert.ok(events.some((event) => event.type === "error" && /Unsupported Responses output item/.test(event.message)));
      assert.deepEqual(events.at(-1), { type: "done", reason: "error" });
    }
  });

  it("emits native creation before terminal state and retries only read-only native HTTP failures", async () => {
    let requests = 0;
    globalThis.fetch = async () => { requests++; return new Response("gateway unavailable", { status: 503 }); };
    const failed = await collect({ nativeTools: [{ type: "code_interpreter", container: { type: "auto" } }] });
    assert.equal(requests, 1);
    assert.ok(failed.some((event) => event.type === "error" && /gateway unavailable/.test(event.message)));
    requests = 0;
    await collect({ nativeTools: [{ type: "web_search" }] });
    assert.equal(requests, 3, "a search-only request has no remote effects and keeps transport retries");
    requests = 0;
    const final = completed([{ type: "web_search_call", id: "web_1", status: "completed" }, messageItem]);
    globalThis.fetch = async () => {
      requests++;
      return new Response([
        frame({ type: "response.created", response: { id: "resp_mock", status: "in_progress" } }),
        frame({ type: "response.completed", response: final }),
      ].join(""), { headers: { "Content-Type": "text/event-stream" } });
    };
    const events = await collect({ nativeTools: [{ type: "web_search" }] });
    assert.equal(requests, 1);
    assert.deepEqual(events.filter((event) => event.type === "response_state").map((event) => event.status), ["submitting", "in_progress", "completed"]);
    assert.deepEqual(events.at(-1), { type: "done", reason: "completed" });
  });

  it("preserves the created ID on a truncated native request without resubmission", async () => {
    let requests = 0;
    globalThis.fetch = async () => {
      requests++;
      return new Response(frame({ type: "response.created", response: { id: "resp_remote", status: "in_progress" } }),
        { headers: { "Content-Type": "text/event-stream" } });
    };
    const events = await collect({ nativeTools: [{ type: "mcp", server_label: "remote", server_url: "https://example.com" }] });
    assert.equal(requests, 1);
    assert.ok(events.some((event) => event.type === "response_state" && event.responseId === "resp_remote"));
    assert.deepEqual(events.at(-1), { type: "done", reason: "error" });
  });

  it("does not blindly retry a native request on ambiguous transport failure", async () => {
    let requests = 0;
    globalThis.fetch = async () => { requests++; throw new Error("connection lost after upload"); };
    const events = await collect({ nativeTools: [{ type: "code_interpreter", container: { type: "auto" } }] });
    assert.equal(requests, 1);
    assert.ok(events.some((event) => event.type === "error" && /connection lost/.test(event.message)));
    assert.deepEqual(events.filter((event) => event.type === "response_state").map((event) => event.status), ["submitting"]);
  });

  it("delivers a submission marker to the consumer before starting native or approval HTTP requests", async () => {
    for (const options of [
      { nativeTools: [{ type: "web_search" }] },
      { responses: { input: [{ type: "mcp_approval_response", approval_request_id: "approval_1", approve: true }] } },
    ] satisfies Partial<StreamChatOptions>[]) {
      const received: StreamEvent[] = [];
      globalThis.fetch = async () => {
        assert.deepEqual(received.at(-1), { type: "response_state", responseId: "", status: "submitting", stored: true,
          requestSafety: "responses" in options ? "effects_possible" : "read_only" });
        return Response.json(completed());
      };
      for await (const event of streamChatCompletion(CONFIG, { messages, ...options })) received.push(event);
      assert.deepEqual(received.at(-1), { type: "done", reason: "completed" });
    }
  });

  it("snapshots the actual native capabilities on each submission without sending internal safety fields", async () => {
    for (const { nativeTools, safety } of [
      { nativeTools: [{ type: "web_search" }, { type: "file_search", vector_store_ids: ["vs"] }], safety: "read_only" },
      { nativeTools: [{ type: "mcp", server_label: "remote", server_url: "https://mcp.example.com" }], safety: "effects_possible" },
      { nativeTools: [{ type: "code_interpreter", container: { type: "auto" } }], safety: "effects_possible" },
      { nativeTools: [{ type: "image_generation" }], safety: "effects_possible" },
    ] satisfies Array<{ nativeTools: JsonObject[]; safety: string }>) {
      globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        assert.deepEqual(body.tools, nativeTools);
        assert.equal("requestSafety" in body, false);
        return Response.json(completed());
      };
      const events = await collect({ nativeTools });
      const submitting = events.find((event) => event.type === "response_state" && event.status === "submitting");
      assert.ok(submitting?.type === "response_state");
      assert.equal(submitting.requestSafety, safety);
    }
  });

  it("marks cancellation before any fetch call as not_submitted", async () => {
    const controller = new AbortController();
    let requests = 0;
    globalThis.fetch = async () => { requests++; return Response.json(completed()); };
    const events: StreamEvent[] = [];
    for await (const event of streamChatCompletion(CONFIG, { messages, signal: controller.signal,
      nativeTools: [{ type: "mcp", server_label: "remote", server_url: "https://mcp.example.com" }] })) {
      events.push(event);
      if (event.type === "response_state" && event.status === "submitting") controller.abort();
    }
    assert.equal(requests, 0);
    assert.deepEqual(events.filter((event) => event.type === "response_state"), [
      { type: "response_state", responseId: "", status: "submitting", stored: true, requestSafety: "effects_possible" },
      { type: "response_state", responseId: "", status: "not_submitted", stored: false, requestSafety: "effects_possible" },
    ]);
    assert.deepEqual(events.at(-1), { type: "done", reason: "cancelled" });
  });

  it("does not claim not_submitted once fetch has been called, even when cancellation wins", async () => {
    const controller = new AbortController();
    let requests = 0;
    globalThis.fetch = async () => { requests++; controller.abort(); throw new DOMException("Aborted", "AbortError"); };
    const events = await collect({ signal: controller.signal,
      nativeTools: [{ type: "mcp", server_label: "remote", server_url: "https://mcp.example.com" }] });
    assert.equal(requests, 1);
    assert.equal(events.some((event) => event.type === "response_state" && event.status === "not_submitted"), false);
    assert.deepEqual(events.at(-1), { type: "done", reason: "cancelled" });
  });

  it("marks definite HTTP rejection without mistaking network or server ambiguity for rejection", async () => {
    for (const status of [400, 401, 403, 404, 405, 422, 429, 500, 502, 503, 504]) {
      let requests = 0;
      globalThis.fetch = async () => { requests++; return Response.json({ error: { message: `HTTP ${status}` } }, { status }); };
      const events = await collect({ nativeTools: [{ type: "code_interpreter", container: { type: "auto" } }] });
      assert.equal(requests, 1);
      const states = events.filter((event) => event.type === "response_state");
      assert.deepEqual(states.map((event) => event.status), status < 500 ? ["submitting", "rejected"] : ["submitting"]);
      assert.ok(states.every((event) => event.responseId === ""));
    }
  });

  it("marks only an explicit missing or expired submitted cursor in HTTP 400/404 rejections", async () => {
    const previousResponseId = "resp_rejected";
    for (const detail of [
      { status: 400, message: "previous_response_id 'resp_rejected' not found" },
      { status: 404, message: "Previous response was not found", param: "previous_response_id" },
      { status: 400, message: "The previous response has expired", param: "previous_response_id" },
      { status: 404, message: "Missing resource", param: "previous_response_id", code: "not_found" },
      { status: 400, message: "Response 'resp_rejected' cannot be loaded", code: "previous_response_not_found" },
      { status: 404, message: "previous_response_id 'resp_rejected' 已过期" },
    ]) {
      let requests = 0;
      const { status, ...error } = detail;
      globalThis.fetch = async () => { requests++; return Response.json({ error }, { status }); };
      const events = await collect({ responses: { previousResponseId, noRetry: true } });
      assert.equal(requests, 1);
      const markers = events.filter((event) => event.type === "response_state" && event.rejectedPreviousResponseId);
      assert.equal(markers.length, 1);
      assert.ok(markers[0]?.type === "response_state");
      assert.equal(markers[0].status, "rejected");
      assert.equal(markers[0].rejectedPreviousResponseId, previousResponseId);
      assert.deepEqual(events.at(-1), { type: "done", reason: "error" });
    }
  });

  it("marks explicit store:true policy rejection without confusing generic validation errors", async () => {
    for (const detail of [
      { status: 400, message: "store=true is not supported: this service does not retain responses, set store to false" },
      { status: 400, message: "Unknown parameter: 'store'." },
      { status: 422, message: "store 不支持", param: "store" },
      { status: 400, message: "Not supported", param: "store", code: "not_supported" },
    ]) {
      const { status, ...error } = detail;
      globalThis.fetch = async () => Response.json({ error }, { status });
      const events = await collect();
      const marker = events.find((event) => event.type === "response_state" && event.rejectedStore);
      assert.ok(marker?.type === "response_state");
      assert.equal(marker.status, "rejected");
      assert.equal(marker.stored, true);
      assert.deepEqual(events.at(-1), { type: "done", reason: "error" });
    }
    for (const detail of [
      { status: 401, message: "store=true is not supported" },
      { status: 400, message: "store=true is not supported", param: "input" },
      { status: 400, message: "store must be a boolean", param: "store" },
      { status: 500, message: "store=true is not supported" },
      { status: 400, message: "web_search is not supported", code: "not_supported" },
    ]) {
      const { status, ...error } = detail;
      globalThis.fetch = async () => Response.json({ error }, { status });
      const events = await collect();
      assert.equal(events.some((event) => event.type === "response_state" && event.rejectedStore), false);
    }
    globalThis.fetch = async () => Response.json({ error: { message: "store=true is not supported" } }, { status: 400 });
    const stateless = await collect({}, { ...CONFIG, responsesStateful: false });
    assert.equal(stateless.some((event) => event.type === "response_state" && event.rejectedStore), false);
  });

  it("does not invalidate cursors for unrelated HTTP errors, other IDs or unsupported parameters", async () => {
    for (const detail of [
      { status: 401, message: "previous_response_id 'resp_rejected' not found", param: "previous_response_id" },
      { status: 422, message: "previous_response_id 'resp_rejected' not found", param: "previous_response_id" },
      { status: 500, message: "previous_response_id 'resp_rejected' not found", param: "previous_response_id" },
      { status: 502, message: "previous_response_id 'resp_rejected' not found", param: "previous_response_id" },
      { status: 404, message: "API route not found" },
      { status: 404, message: "Resource missing", code: "not_found" },
      { status: 404, message: "previous_response_id 'resp_other' not found", param: "previous_response_id" },
      { status: 404, message: "previous_response_id 'resp_rejected_extra' not found" },
      { status: 400, message: "previous_response_id 'resp_rejected' is not supported", param: "previous_response_id" },
      { status: 400, message: "Invalid previous_response_id 'resp_rejected'", param: "previous_response_id" },
      { status: 400, message: "previous_response_id 'resp_rejected' not found", param: "input" },
    ]) {
      const { status, ...error } = detail;
      globalThis.fetch = async () => Response.json({ error }, { status });
      const events = await collect({ responses: { previousResponseId: "resp_rejected", noRetry: true } });
      assert.equal(events.some((event) => event.type === "response_state" && event.rejectedPreviousResponseId), false);
      assert.deepEqual(events.at(-1), { type: "done", reason: "error" });
    }
    globalThis.fetch = async () => Response.json({ error: { message: "previous_response_id 'resp_rejected' not found", param: "previous_response_id" } }, { status: 400 });
    assert.equal((await collect()).some((event) => event.type === "response_state" && event.rejectedPreviousResponseId), false);
  });

  it("does not treat a network failure or accepted SSE error as cursor rejection", async () => {
    globalThis.fetch = async () => { throw new Error("previous_response_id 'resp_rejected' not found"); };
    const network = await collect({ responses: { previousResponseId: "resp_rejected", noRetry: true } });
    assert.equal(network.some((event) => event.type === "response_state" && event.rejectedPreviousResponseId), false);
    installSse([{ type: "response.created", response: { id: "resp_mock", status: "in_progress" } },
      { type: "error", message: "previous_response_id 'resp_rejected' not found", param: "previous_response_id", code: "previous_response_not_found" }]);
    const stream = await collect({ responses: { previousResponseId: "resp_rejected", noRetry: true } });
    assert.equal(stream.some((event) => event.type === "response_state" && event.rejectedPreviousResponseId), false);
    assert.deepEqual(stream.at(-1), { type: "done", reason: "error" });
  });

  it("treats an SSE cursor error before response.created as a definite cursor rejection", async () => {
    installSse([{ type: "error", error: { message: "Previous response 'resp_rejected' not found", param: "previous_response_id", code: "previous_response_not_found" } }]);
    const events = await collect({ responses: { previousResponseId: "resp_rejected", noRetry: true } });
    const marker = events.find((event) => event.type === "response_state" && event.rejectedPreviousResponseId);
    assert.ok(marker?.type === "response_state");
    assert.equal(marker.rejectedPreviousResponseId, "resp_rejected");
    assert.deepEqual(events.at(-1), { type: "done", reason: "error" });
  });

  it("parses SSE frames served under a non-SSE content type", async () => {
    globalThis.fetch = async () => new Response(frame({ type: "response.created", response: { id: "resp_mock", status: "in_progress" } })
      + frame({ type: "response.completed", response: completed() }), { headers: { "Content-Type": "application/json" } });
    const events = await collect();
    assert.ok(events.some((event) => event.type === "response_state" && event.responseId === "resp_mock" && event.status === "in_progress"));
    assert.deepEqual(events.at(-1), { type: "done", reason: "completed" });
  });

  it("records the response ID from response.queued", async () => {
    installSse([{ type: "response.queued", response: { id: "resp_queued", status: "queued" } },
      { type: "response.completed", response: { ...completed(), id: "resp_queued" } }]);
    const events = await collect();
    assert.ok(events.some((event) => event.type === "response_state" && event.responseId === "resp_queued" && event.status === "queued"));
  });

  it("normalizes decoded function arguments to the JSON-string wire form before persisting output", async () => {
    installSse([{ type: "response.completed", response: completed([{ ...functionItem, arguments: { path: "a" } }]) }]);
    const events = await collect();
    const state = events.find((event) => event.type === "response_state" && event.output);
    assert.ok(state?.type === "response_state");
    assert.equal(state.output![0]!.arguments, '{"path":"a"}');
    const call = events.find((event) => event.type === "tool_call");
    assert.ok(call?.type === "tool_call");
    assert.deepEqual(call.arguments, { path: "a" });
  });

  it("tolerates unknown non-executable output items", async () => {
    installSse([{ type: "response.completed", response: completed([{ type: "future_annotation", id: "x" }, messageItem]) }]);
    const events = await collect();
    assert.ok(events.some((event) => event.type === "text_delta" && event.text === "Visible answer"));
    assert.deepEqual(events.at(-1), { type: "done", reason: "completed" });
  });

  it("reports the HTTP status of a failed retrieval, including non-JSON bodies", async () => {
    globalThis.fetch = async () => new Response("<html>gone</html>", { status: 404 });
    await assert.rejects(retrieveResponse(CONFIG, "resp_gone"), (error: unknown) =>
      error instanceof ResponseResourceError && error.status === 404);
    globalThis.fetch = async () => { throw new Error("offline"); };
    await assert.rejects(retrieveResponse(CONFIG, "resp_gone"), (error: unknown) =>
      !(error instanceof ResponseResourceError) || error.status === undefined);
  });

  it("cancels a pending retrieval with the caller signal", async () => {
    const controller = new AbortController();
    globalThis.fetch = async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    });
    const pending = retrieveResponse({ ...CONFIG, requestTimeoutMs: 0 }, "resp_slow", controller.signal);
    controller.abort();
    await assert.rejects(pending, /cancelled|Abort/i);
  });

  it("limits an internal noRetry request to one POST while ordinary transport retry remains available", async () => {
    for (const noRetry of [true, false]) {
      let requests = 0;
      globalThis.fetch = async (_url, init) => {
        requests++;
        assert.equal("noRetry" in JSON.parse(String(init?.body)), false);
        if (requests === 1) throw new Error("temporary connection failure");
        return Response.json(completed());
      };
      const events = await collect({ responses: { noRetry } });
      assert.equal(requests, noRetry ? 1 : 2);
      assert.deepEqual(events.at(-1), { type: "done", reason: noRetry ? "error" : "completed" });
    }
    let requests = 0;
    globalThis.fetch = async () => { requests++; return Response.json({ error: { message: "Unavailable" } }, { status: 503 }); };
    await collect({ responses: { noRetry: true } });
    assert.equal(requests, 1);
  });

  it("does not record submission or send HTTP for invalid native request configuration", async () => {
    let requests = 0;
    const events: StreamEvent[] = [];
    globalThis.fetch = async () => { requests++; return Response.json(completed()); };
    await assert.rejects(async () => {
      for await (const event of streamChatCompletion(CONFIG, { messages, nativeTools: [{ type: "shell" }] })) events.push(event);
    }, /Unsupported native Responses tool/);
    assert.equal(requests, 0);
    assert.deepEqual(events, []);
  });

  it("does not retry pending MCP approval execution even when no new native tools are supplied", async () => {
    let requests = 0;
    globalThis.fetch = async () => { requests++; throw new Error("connection lost after approval upload"); };
    const events = await collect({ responses: { input: [{ type: "mcp_approval_response", approval_request_id: "approval_1", approve: true }] } });
    assert.equal(requests, 1);
    assert.deepEqual(events.at(-1), { type: "done", reason: "error" });
  });

  it("discards late native response headers after timeout and cancels the body without retrying", async () => {
    let requests = 0;
    let bodyCancelled = false;
    globalThis.fetch = async () => {
      requests++;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return new Response(new ReadableStream<Uint8Array>({ cancel() { bodyCancelled = true; } }), {
        headers: { "Content-Type": "text/event-stream" },
      });
    };
    const events = await collect({ timeoutMs: 2, nativeTools: [{ type: "code_interpreter", container: { type: "auto" } }] });
    assert.equal(requests, 1);
    assert.equal(bodyCancelled, true);
    assert.ok(events.some((event) => event.type === "error" && /timed out after 2ms/.test(event.message)));
    assert.equal(events.some((event) => event.type === "tool_call"), false);
  });

  it("parses split UTF-8, CRLF, multiline data and a terminal event without a trailing separator", async () => {
    const finalMessage: JsonObject = { ...messageItem, content: [{ type: "output_text", text: "你好" }] };
    const payload = `: keepalive\r\nevent: response.output_text.delta\r\ndata: {"type":"response.output_text.delta",\r\ndata: "delta":"你"}\r\n\r\ndata: ${JSON.stringify({ type: "response.completed", response: completed([finalMessage]) })}`;
    const bytes = new TextEncoder().encode(payload);
    globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
      start(stream) { for (const byte of bytes) stream.enqueue(new Uint8Array([byte])); stream.close(); },
    }), { headers: { "Content-Type": "text/event-stream" } });
    const events = await collect();
    assert.equal(events.filter((event) => event.type === "text_delta").map((event) => event.text).join(""), "你好");
    assert.deepEqual(events.at(-1), { type: "done", reason: "completed" });
  });

  it("does not flush functions after malformed SSE data", async () => {
    globalThis.fetch = async () => new Response(frame({ type: "response.output_item.done", item: functionItem }) + "data: {broken}\n\n", {
      headers: { "Content-Type": "text/event-stream" },
    });
    const events = await collect();
    assert.equal(events.some((event) => event.type === "tool_call"), false);
    assert.deepEqual(events.at(-1), { type: "done", reason: "error" });
  });

  it("cancels pending body reads after created state without delivering late tools", async () => {
    const controller = new AbortController();
    let closed = false;
    globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
      start(stream) { stream.enqueue(new TextEncoder().encode(frame({ type: "response.created", response: { id: "resp_remote", status: "in_progress" } }))); },
      cancel() { closed = true; },
    }), { headers: { "Content-Type": "text/event-stream" } });
    const events: StreamEvent[] = [];
    for await (const event of streamChatCompletion(CONFIG, { messages, signal: controller.signal })) {
      events.push(event);
      if (event.type === "response_state" && event.responseId === "resp_remote") controller.abort();
    }
    assert.equal(closed, true);
    assert.equal(events.some((event) => event.type === "tool_call"), false);
    assert.deepEqual(events.at(-1), { type: "done", reason: "cancelled" });
  });
});

describe("Responses non-streaming and resources", () => {
  it("maps auxiliary structured output and records native usage", async () => {
    let body: JsonObject | undefined;
    globalThis.fetch = async (_url, init) => { body = JSON.parse(String(init?.body)) as JsonObject; return Response.json(completed()); };
    const result = await chatCompletionOnce(CONFIG, { messages, responseFormat: { type: "json_object" }, meta: { sessionId: "once" } });
    assert.equal(result.content, "Visible answer");
    assert.equal(body!.stream, false);
    assert.deepEqual(body!.text, { format: { type: "json_object" } });
    const timeline = listLlmTimeline("once").records[0];
    assert.ok(timeline?.kind === "llm");
    assert.equal(timeline.totalTokens, 17);
  });

  it("falls back to streaming when non-stream is explicitly rejected without losing text.format", async () => {
    const bodies: JsonObject[] = [];
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as JsonObject; bodies.push(body);
      return body.stream ? new Response(frame({ type: "response.completed", response: completed() }), { headers: { "Content-Type": "text/event-stream" } })
        : Response.json({ error: { message: "Non-stream request is not supported" } }, { status: 400 });
    };
    const result = await chatCompletionOnce(CONFIG, { messages, responseFormat: { type: "json_object" } });
    assert.equal(result.content, "Visible answer");
    assert.deepEqual(bodies.map((body) => body.text), [{ format: { type: "json_object" } }, { format: { type: "json_object" } }]);
  });

  it("disables state and retries an auxiliary non-stream request after store rejection", async () => {
    const bodies: JsonObject[] = [];
    const reasons: string[] = [];
    const config: OpenAiCompatibleClientConfig = {
      ...CONFIG,
      onResponsesStatefulDisabled: (reason) => { reasons.push(reason); },
    };
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as JsonObject;
      bodies.push(body);
      if (bodies.length === 1) {
        return Response.json({ error: { message: "store=true is not supported", param: "store" } }, { status: 400 });
      }
      return Response.json(completed());
    };
    const result = await responsesOnce(config, { messages, responses: { previousResponseId: "resp_old" } });
    assert.equal(result.content, "Visible answer");
    assert.equal(config.responsesStateful, false);
    assert.deepEqual(reasons, ["store_rejected"]);
    assert.deepEqual(bodies.map((body) => body.store), [true, false]);
    assert.equal(bodies[1]!.previous_response_id, undefined);
  });

  it("accepts an SSE response when a provider ignores the non-stream preference", async () => {
    installSse([{ type: "response.completed", response: completed() }]);
    assert.equal((await chatCompletionOnce(CONFIG, { messages })).content, "Visible answer");
  });

  it("does not resubmit native execution for a non-stream negotiation error", async () => {
    let requests = 0;
    globalThis.fetch = async () => { requests++; return Response.json({ error: { message: "streaming is required" } }, { status: 400 }); };
    await assert.rejects(responsesOnce(CONFIG, { messages, nativeTools: [{ type: "code_interpreter", container: { type: "auto" } }] }), /streaming is required/);
    assert.equal(requests, 1);
    requests = 0;
    await assert.rejects(responsesOnce(CONFIG, { messages, nativeTools: [{ type: "web_search" }] }), /streaming is required/);
    assert.equal(requests, 2, "a search-only request may renegotiate streaming once");
  });

  it("does not add a stream-negotiation POST to an internal noRetry recovery", async () => {
    let requests = 0;
    globalThis.fetch = async () => { requests++; return Response.json({ error: { message: "streaming is required" } }, { status: 400 }); };
    await assert.rejects(responsesOnce(CONFIG, { messages, responses: { noRetry: true } }), /streaming is required/);
    assert.equal(requests, 1);
  });

  it("discards a JSON body that resolves after caller cancellation", async () => {
    const controller = new AbortController();
    globalThis.fetch = async () => {
      const response = Response.json(completed());
      Object.defineProperty(response, "text", { value: async () => { controller.abort(); return JSON.stringify(completed()); } });
      return response;
    };
    await assert.rejects(chatCompletionOnce(CONFIG, { messages, signal: controller.signal }), /Request cancelled/);
  });

  it("retrieves resources with a preserved query and only remotely cancels background responses", async () => {
    const config = { ...CONFIG, baseUrl: "https://responses.example.com/custom?route=1", rawEndpoint: true };
    const urls: string[] = [];
    let background = false;
    globalThis.fetch = async (url, init) => {
      urls.push(`${init?.method} ${url}`);
      return Response.json({ id: "resp_1", status: init?.method === "POST" ? "cancelled" : "in_progress", background });
    };
    await retrieveResponse(config, "resp_1");
    await assert.rejects(cancelResponse(config, "resp_1"), /Only background/);
    assert.equal(urls.some((url) => url.startsWith("POST")), false);
    background = true;
    assert.equal((await cancelResponse(config, "resp_1")).status, "cancelled");
    assert.equal(urls.at(-1), "POST https://responses.example.com/custom/resp_1/cancel?route=1");
  });

  it("auto-detects the official v1 endpoint and keeps scope bound to the chosen protocol", async () => {
    let url = "";
    globalThis.fetch = async (input) => { url = String(input); return Response.json(completed()); };
    const autoConfig = { ...CONFIG, baseUrl: "https://api.openai.com/v1", apiProtocol: "auto" as const };
    await chatCompletionOnce(autoConfig, { messages });
    assert.equal(url, "https://api.openai.com/v1/responses");
    assert.notEqual(reasoningScopeForClient(autoConfig), reasoningScopeForClient({ ...autoConfig, apiProtocol: "chat_completions" }));
  });
});
