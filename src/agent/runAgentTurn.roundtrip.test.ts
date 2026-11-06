/**
 * Full turn via runAgentTurn facade (createWorkflow → FsmGraphWorkflow → Host).
 * Covers text-only and one model→tool→model round after prepareTools split.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { QueuedPrompt } from "./ipcTypes.js";
import type { StreamEvent } from "../llm/streamEvents.js";
import { reasoningScopeForClient } from "../llm/contextScope.js";
import { projectTranscriptMessages } from "../renderer/src/screens/conversation/turnDisplay.js";
import type {
  OpenAiCompatibleClientConfig,
  StreamChatOptions,
} from "../llm/types.js";
import { configureUserMemoryRoot } from "../memory/store.js";
import type { Session } from "../session/types.js";
import { RETRY_CONTINUATION_PART_ID } from "../session/types.js";
import { RETRY_CONTINUATION_PROMPT } from "./turnContinuations.js";
import { loadAllSessions, openSessionDb, upsertSession } from "../session/db/index.js";
import { configurePromptDefaults } from "../settings/promptDefaults.js";
import type { PermissionGateState } from "../tools/types.js";
import { runAgentTurn } from "./runAgentTurn.js";
import type { RunAgentTurnInput, StreamChatFn } from "./types.js";
import { createRoleLlmBinding, createUniformRoleLlmBundle } from "./roles/llmBinding.js";
import { createReactGraphConfig } from "./fsm/configs/sampleGraphs.js";

let userDataDir = "";
let messageIdSequence = 0;

before(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), "fsm-roundtrip-"));
  configureUserMemoryRoot(userDataDir);
  configurePromptDefaults(join(process.cwd(), "resources", "prompts"));
});

after(async () => {
  if (userDataDir) {
    await rm(userDataDir, { recursive: true, force: true });
  }
});

function makeSession(id = "roundtrip-sess"): Session {
  const now = Date.now();
  return {
    id,
    type: "agent",
    title: "Full turn roundtrip",
    createdAt: now,
    updatedAt: now,
    status: "idle",
    progressText: "",
    messages: [],
    model: "mock-model",
    providerId: "mock",
    workspaceId: "ws1",
    workspacePath: "",
    pinned: false,
    archived: false,
    archivedAt: null,
    contextUsage: { usedTokens: 0 },
    plan: null,
    planDoc: null,
  };
}

function makeInput(
  session: Session,
  streamChat: StreamChatFn,
  overrides?: Partial<RunAgentTurnInput>,
): RunAgentTurnInput {
  return {
    session,
    userText: "Say hi",
    client: {
      baseUrl: "http://127.0.0.1:9",
      apiKey: "test-key",
      model: "mock-model",
    },
    gate: { fullPermissionsEnabled: true } as PermissionGateState,
    createId: () => `id-${++messageIdSequence}`,
    streamChat,
    unlimitedTurnBudgets: true,
    ...overrides,
  };
}

function textOnlyStream(text: string): StreamChatFn {
  return async function* (
    _config: OpenAiCompatibleClientConfig,
    _options: StreamChatOptions,
  ): AsyncGenerator<StreamEvent, void, undefined> {
    yield { type: "text_delta", text };
    yield {
      type: "usage",
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    };
    yield { type: "done", reason: "completed" };
  };
}

/** First call: tool_call get_current_time; second: final text. */
function toolThenTextStream(): StreamChatFn {
  let calls = 0;
  return async function* (
    _config: OpenAiCompatibleClientConfig,
    _options: StreamChatOptions,
  ): AsyncGenerator<StreamEvent, void, undefined> {
    calls += 1;
    if (calls === 1) {
      yield {
        type: "tool_call",
        id: "call-time-1",
        name: "get_current_time",
        arguments: {},
        argumentsRaw: "{}",
      };
      yield {
        type: "usage",
        promptTokens: 20,
        completionTokens: 8,
        totalTokens: 28,
      };
      yield { type: "done", reason: "completed" };
      return;
    }
    yield { type: "text_delta", text: "It is mock-o'clock." };
    yield {
      type: "usage",
      promptTokens: 30,
      completionTokens: 6,
      totalTokens: 36,
    };
    yield { type: "done", reason: "completed" };
  };
}

/** Block until the (combined) stream signal aborts; safety timeout. */
function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (!signal || signal.aborted) return resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
    setTimeout(resolve, 5_000);
  });
}

/** Queue item shaped like the main-process prompt queue. */
function queued(id: string, userText: string, sessionId: string): QueuedPrompt {
  return {
    id,
    sessionId,
    userText,
    attachments: [],
    mode: "interrupt",
    createdAt: Date.now(),
  };
}

describe("runAgentTurn full round (fsm)", () => {
  it("preserves the active provider endpoint and request settings through the graph", async () => {
    const session = makeSession("roundtrip-client-settings");
    const client: OpenAiCompatibleClientConfig = {
      baseUrl: "https://gateway.example.com/custom/chat?route=test",
      apiKey: "test-key",
      model: "mock-model",
      rawEndpoint: true,
      requestTimeoutMs: 75_000,
      reasoningEffort: "high",
    };
    let captured: OpenAiCompatibleClientConfig | undefined;
    const stream: StreamChatFn = async function* (config) {
      captured = config;
      yield { type: "text_delta", text: "Hello" };
      yield { type: "done", reason: "completed" };
    };
    const result = await runAgentTurn(makeInput(session, stream, { client }));
    assert.equal(result.status, "idle");
    assert.deepEqual(captured, client);
  });

  it("text-only turn reaches idle with user + assistant", async () => {
    const session = makeSession("roundtrip-text");
    const result = await runAgentTurn(
      makeInput(session, textOnlyStream("Hello from full facade.")),
    );

    assert.equal(result.status, "idle");
    assert.equal(result.modelIterations, 1);
    assert.equal(session.status, "idle");
    assert.ok(session.messages.some((m) => m.role === "user"));
    const assistant = session.messages.find((m) => m.role === "assistant");
    assert.ok(assistant);
    const text = assistant?.parts.find((p) => p.type === "text");
    assert.ok(
      text && text.type === "text" && text.text.includes("Hello from full facade"),
    );
  });

  it("model→tool→model round via prepareTools + runToolsPhase", async () => {
    const session = makeSession("roundtrip-tools");
    const result = await runAgentTurn(
      makeInput(session, toolThenTextStream(), {
        userText: "What time is it?",
      }),
    );

    assert.equal(result.status, "idle", `unexpected status; progress=${session.progressText}`);
    assert.equal(result.modelIterations, 2);
    assert.equal(session.status, "idle");

    const roles = session.messages.map((m) => m.role);
    assert.ok(roles.includes("user"));
    assert.ok(roles.includes("assistant"));
    assert.ok(roles.includes("tool"), `expected tool result; roles=${roles.join(",")}`);

    const toolMsg = session.messages.find((m) => m.role === "tool");
    assert.equal(toolMsg?.toolCallId, "call-time-1");

    const assistants = session.messages.filter((m) => m.role === "assistant");
    assert.ok(assistants.length >= 2);
    const finalText = [...assistants]
      .reverse()
      .flatMap((m) => m.parts)
      .find((p) => p.type === "text" && p.text.includes("mock-o'clock"));
    assert.ok(finalText, "expected final assistant text after tool round");
  });
});

describe("runAgentTurn reasoning binding scope", () => {
  const originalClient: OpenAiCompatibleClientConfig = {
    baseUrl: "https://reasoning.example.com/v1",
    apiKey: "original-credential",
    model: "reasoning-model",
  };
  const cases: Array<{
    name: string;
    nextClient: OpenAiCompatibleClientConfig;
    replay: boolean;
    sqlite?: boolean;
  }> = [
    { name: "same binding", nextClient: { ...originalClient }, replay: true },
    { name: "same binding after SQLite reload", nextClient: { ...originalClient }, replay: true, sqlite: true },
    { name: "different model", nextClient: { ...originalClient, model: "other-model" }, replay: false },
    { name: "different credential", nextClient: { ...originalClient, apiKey: "rotated-credential" }, replay: false },
    { name: "different endpoint", nextClient: { ...originalClient, baseUrl: "https://other.example.com/v1" }, replay: false },
  ];

  for (const scenario of cases) {
    it(`${scenario.replay ? "replays" : "omits"} provider reasoning for ${scenario.name}`, async () => {
      let session = makeSession(`reasoning-scope-${scenario.name}`);
      const answer = "The visible answer remains available.";
      const reasoning = "Provider-specific reasoning from the first turn.";
      const firstStream: StreamChatFn = async function* (config) {
        assert.deepEqual(config, originalClient);
        yield { type: "reasoning_delta", text: reasoning };
        yield { type: "text_delta", text: answer };
        yield { type: "done", reason: "completed" };
      };
      const first = await runAgentTurn(makeInput(session, firstStream, { client: originalClient }));
      assert.equal(first.status, "idle");
      const firstAssistant = session.messages.find((message) => message.role === "assistant");
      assert.ok(firstAssistant);
      const savedReasoning = firstAssistant.parts.find((part) => part.type === "reasoning");
      assert.equal(savedReasoning?.text, reasoning);
      assert.equal(savedReasoning?.providerScope, reasoningScopeForClient(originalClient));

      if (scenario.sqlite) {
        const dbDir = await mkdtemp(join(userDataDir, "reasoning-db-"));
        const db = openSessionDb(dbDir);
        try {
          upsertSession(db, session);
          const reloaded = loadAllSessions(db).find((item) => item.id === session.id);
          assert.ok(reloaded, "the first turn is restored from real SQLite");
          session = reloaded;
          const restoredReasoning = session.messages
            .find((message) => message.role === "assistant")?.parts
            .find((part) => part.type === "reasoning");
          assert.equal(restoredReasoning?.providerScope, reasoningScopeForClient(originalClient));
        } finally {
          db.close();
        }
      }

      let captured: StreamChatOptions | undefined;
      const secondStream: StreamChatFn = async function* (config, options) {
        assert.deepEqual(config, scenario.nextClient);
        captured = options;
        yield { type: "text_delta", text: "Second answer." };
        yield { type: "done", reason: "completed" };
      };
      const second = await runAgentTurn(makeInput(session, secondStream, {
        client: scenario.nextClient,
        userText: "Continue with the previous visible answer.",
      }));
      assert.equal(second.status, "idle");
      assert.ok(captured);
      const replayed = captured.messages.find((message) =>
        message.role === "assistant" && message.content === answer);
      assert.ok(replayed, "changing a binding must preserve the visible answer in history");
      assert.equal(replayed.reasoning_content, scenario.replay ? reasoning : undefined);
      assert.equal(new Set(session.messages.map((message) => message.id)).size, session.messages.length,
        "turns share an id sequence so earlier assistant messages cannot be shadowed");
    });
  }

  for (const keepOverride of [true, false]) {
    it(`uses the actual role override scope when the next turn ${keepOverride ? "keeps it" : "returns to the session binding"}`, async () => {
      const session = makeSession(`reasoning-role-override-${keepOverride}`);
      const overrideClient = { ...originalClient, model: "review-model", apiKey: "review-credential" };
      const answer = "Answer from the review provider.";
      const reasoning = "Reasoning belonging only to the review provider.";
      const overrideGraph = createReactGraphConfig();
      const prepareRole = overrideGraph.nodes.find((node) => node.id === "agent")?.actions
        ?.find((action) => action.type === "NodeActionPrepareRole");
      assert.ok(prepareRole);
      prepareRole.params = { ...prepareRole.params, modelProviderId: "review" };

      function bundle(stream: StreamChatFn) {
        const bindings = createUniformRoleLlmBundle({ providerId: "mock", client: originalClient, stream });
        bindings.byProviderId.review = createRoleLlmBinding({ providerId: "review", client: overrideClient, stream });
        return bindings;
      }
      const firstStream: StreamChatFn = async function* (config) {
        assert.deepEqual(config, overrideClient, "the real model call uses the role override");
        yield { type: "reasoning_delta", text: reasoning };
        yield { type: "text_delta", text: answer };
        yield { type: "done", reason: "completed" };
      };
      const first = await runAgentTurn(makeInput(session, firstStream, {
        client: originalClient, llmBundle: bundle(firstStream), fsmGraphConfig: overrideGraph,
      }));
      assert.equal(first.status, "idle");
      const saved = session.messages.find((message) => message.role === "assistant")?.parts
        .find((part) => part.type === "reasoning");
      assert.equal(saved?.providerScope, reasoningScopeForClient(overrideClient));
      assert.notEqual(saved?.providerScope, reasoningScopeForClient(originalClient));

      let captured: StreamChatOptions | undefined;
      const secondStream: StreamChatFn = async function* (config, options) {
        assert.deepEqual(config, keepOverride ? overrideClient : originalClient);
        captured = options;
        yield { type: "text_delta", text: "Follow-up answer." };
        yield { type: "done", reason: "completed" };
      };
      const second = await runAgentTurn(makeInput(session, secondStream, {
        client: originalClient, llmBundle: bundle(secondStream),
        ...(keepOverride ? { fsmGraphConfig: overrideGraph } : {}),
      }));
      assert.equal(second.status, "idle");
      const replayed = captured?.messages.find((message) =>
        message.role === "assistant" && message.content === answer);
      assert.ok(replayed, "the role's visible answer survives both binding choices");
      assert.equal(replayed.reasoning_content, keepOverride ? reasoning : undefined);
    });
  }
});

describe("runAgentTurn interrupt (immediate insertion)", () => {
  it("mid-stream interrupt seals partial text, continues the SAME turn, and merges queued items", async () => {
    const session = makeSession("interrupt-stream");
    let round = 0;
    let armed = false;
    const events: StreamEvent[] = [];
    const port: { fire: (() => boolean) | null } = { fire: null };

    const streamChat: StreamChatFn = async function* (
      _config: OpenAiCompatibleClientConfig,
      options: StreamChatOptions,
    ): AsyncGenerator<StreamEvent, void, undefined> {
      round += 1;
      if (round === 1) {
        yield { type: "text_delta", text: "Partial plan. " };
        await waitForAbort(options.signal);
        yield { type: "error", message: "Request cancelled" };
        yield { type: "done", reason: "cancelled" };
        return;
      }
      yield { type: "text_delta", text: "Pivoted after interrupt." };
      yield {
        type: "usage",
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
      };
      yield { type: "done", reason: "completed" };
    };

    const turn = runAgentTurn(
      makeInput(session, streamChat, {
        userText: "go",
        interruptPort: port,
        takePendingSteer: () => {
          if (!armed) return [];
          armed = false;
          return [
            queued("q1", "First pivot", session.id),
            queued("q2", "Second pivot", session.id),
          ];
        },
        onEvent: (event) => events.push(event),
      }),
    );
    assert.ok(port.fire, "host filled the interrupt port");
    // Let round 1 reach its in-stream wait, then arm + fire.
    await new Promise((resolve) => setTimeout(resolve, 10));
    armed = true;
    assert.equal(port.fire(), true, "interrupt fired");

    const result = await turn;

    assert.equal(result.status, "idle", "turn must not end cancelled");
    assert.equal(result.modelIterations, 2, "next round runs (not re-aborted)");
    assert.equal(events.some((event) => event.type === "error"), false,
      "a prompt interrupt must not put the renderer into terminal error state");

    const assistants = session.messages.filter((m) => m.role === "assistant");
    const partialText = assistants[0]?.parts.find((p) => p.type === "text");
    assert.ok(
      partialText &&
        partialText.type === "text" &&
        partialText.text.includes("(interrupted)"),
      "partial assistant text sealed with the interrupted suffix",
    );

    const steerMessages = session.messages.filter(
      (m) => m.role === "user" && JSON.stringify(m).includes("pivot"),
    );
    assert.equal(
      steerMessages.length,
      1,
      "both queued items merge into ONE inserted message",
    );
    const merged = JSON.stringify(steerMessages[0]);
    assert.ok(merged.includes("First pivot") && merged.includes("Second pivot"));

    const consumed = events.filter(
      (e): e is Extract<StreamEvent, { type: "steer_consumed" }> =>
        e.type === "steer_consumed",
    );
    assert.deepEqual(
      consumed.map((e) => [e.id, e.applied]),
      [
        ["q1", true],
        ["q2", true],
      ],
    );
  });

  it("mid-reasoning interrupt emits round_interrupted and keeps the partial CoT", async () => {
    const session = makeSession("interrupt-reasoning");
    let round = 0;
    let armed = false;
    const events: StreamEvent[] = [];
    const port: { fire: (() => boolean) | null } = { fire: null };

    const streamChat: StreamChatFn = async function* (
      _config: OpenAiCompatibleClientConfig,
      options: StreamChatOptions,
    ): AsyncGenerator<StreamEvent, void, undefined> {
      round += 1;
      if (round === 1) {
        yield { type: "reasoning_delta", text: "Thinking hard about the plan. " };
        await waitForAbort(options.signal);
        yield { type: "error", message: "Request cancelled" };
        yield { type: "done", reason: "cancelled" };
        return;
      }
      const interruptedAssistant = options.messages.find(
        (message) =>
          message.role === "assistant" &&
          message.reasoning_content?.includes("Thinking hard"),
      );
      assert.ok(
        typeof interruptedAssistant?.content === "string" &&
          interruptedAssistant.content.trim().length > 0,
        "the resumed request must not replay an empty assistant content field",
      );
      yield { type: "text_delta", text: "Pivoted after interrupt." };
      yield {
        type: "usage",
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
      };
      yield { type: "done", reason: "completed" };
    };

    const turn = runAgentTurn(
      makeInput(session, streamChat, {
        userText: "go",
        interruptPort: port,
        takePendingSteer: () => {
          if (!armed) return [];
          armed = false;
          return [queued("q1", "new direction", session.id)];
        },
        onEvent: (event) => events.push(event),
      }),
    );
    assert.ok(port.fire, "host filled the interrupt port");
    await new Promise((resolve) => setTimeout(resolve, 10));
    armed = true;
    port.fire();

    const result = await turn;

    assert.equal(result.status, "idle", "turn stays alive after interrupt");
    assert.equal(result.modelIterations, 2, "next round runs (not re-aborted)");

    const interruptedRounds = events.filter(
      (e): e is Extract<StreamEvent, { type: "round_interrupted" }> =>
        e.type === "round_interrupted",
    );
    assert.equal(
      interruptedRounds.length,
      1,
      "exactly one round_interrupted event for the sealed round",
    );
    const firstAssistant = session.messages.find((m) => m.role === "assistant");
    assert.ok(firstAssistant, "interrupted assistant kept (partial CoT)");
    assert.equal(
      interruptedRounds[0]?.messageId,
      firstAssistant?.id,
      "event names the interrupted round's assistant message",
    );
    assert.ok(
      firstAssistant?.parts.some(
        (p) => p.type === "reasoning" && p.text.includes("Thinking hard"),
      ),
      "partial CoT stays on the sealed assistant message",
    );
    // The UI cue must arrive before the follow-up round's first delta so the
    // old Thinking card is sealed promptly.
    const firstRound2Delta = events.findIndex(
      (e) =>
        (e.type === "reasoning_delta" || e.type === "text_delta") &&
        e.messageId !== firstAssistant?.id,
    );
    const interruptIdx = events.findIndex((e) => e.type === "round_interrupted");
    assert.ok(
      interruptIdx >= 0 && (firstRound2Delta === -1 || interruptIdx < firstRound2Delta),
      "round_interrupted ships before round 2's first delta",
    );
  });

  it("seals half-emitted tool calls as explicit not-executed results", async () => {
    const session = makeSession("interrupt-toolcall");
    session.workspacePath = userDataDir;
    const target = join(userDataDir, "interrupt-sealed.txt");
    let round = 0;
    let armed = false;
    const port: { fire: (() => boolean) | null } = { fire: null };

    const streamChat: StreamChatFn = async function* (
      _config: OpenAiCompatibleClientConfig,
      options: StreamChatOptions,
    ): AsyncGenerator<StreamEvent, void, undefined> {
      round += 1;
      if (round === 1) {
        yield { type: "text_delta", text: "Writing now. " };
        yield {
          type: "tool_call",
          id: "call-w-1",
          name: "write_file",
          arguments: {
            path: join(userDataDir, "interrupt-sealed.txt"),
            content: "nope",
          },
          argumentsRaw: "{}",
        };
        await waitForAbort(options.signal);
        yield { type: "error", message: "Request cancelled" };
        yield { type: "done", reason: "cancelled" };
        return;
      }
      yield { type: "text_delta", text: "Recovered." };
      yield {
        type: "usage",
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
      };
      yield { type: "done", reason: "completed" };
    };

    const turn = runAgentTurn(
      makeInput(session, streamChat, {
        userText: "write it",
        interruptPort: port,
        takePendingSteer: () => {
          if (!armed) return [];
          armed = false;
          return [queued("q1", "stop that", session.id)];
        },
      }),
    );
    assert.ok(port.fire);
    await new Promise((resolve) => setTimeout(resolve, 10));
    armed = true;
    port.fire();
    const result = await turn;

    assert.equal(result.status, "idle");
    assert.equal(result.modelIterations, 2);

    const toolMsg = session.messages.find((m) => m.role === "tool");
    assert.ok(toolMsg, "sealed tool result present");
    assert.equal(toolMsg?.toolCallId, "call-w-1");
    assert.ok(
      JSON.stringify(toolMsg).includes("Interrupted by user message"),
      "explicit not-executed note",
    );
    const callPart = session.messages
      .filter((m) => m.role === "assistant")[0]
      ?.parts.find((p) => p.type === "tool_call");
    assert.ok(
      callPart && callPart.type === "tool_call" && callPart.status === "cancelled",
      "tool_call part marked cancelled",
    );
    assert.equal(existsSync(target), false, "sealed call never executed");
  });

  it("does not start a stale write when interrupt races stream completion", async () => {
    const session = makeSession("interrupt-writeclass");
    session.workspacePath = userDataDir;
    const target = join(userDataDir, "interrupt-writeclass.txt");
    let round = 0;
    let armed = false;
    const port: { fire: (() => boolean) | null } = { fire: null };

    const streamChat: StreamChatFn = async function* (
      _config: OpenAiCompatibleClientConfig,
      _options: StreamChatOptions,
    ): AsyncGenerator<StreamEvent, void, undefined> {
      round += 1;
      if (round === 1) {
        yield {
          type: "tool_call",
          id: "call-w-2",
          name: "write_file",
          arguments: {
            path: join(userDataDir, "interrupt-writeclass.txt"),
            content: "written",
          },
          argumentsRaw: JSON.stringify({
            path: join(userDataDir, "interrupt-writeclass.txt"),
            content: "written",
          }),
        };
        armed = true;
        port.fire?.();
        yield {
          type: "usage",
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
        };
        yield { type: "done", reason: "completed" };
        return;
      }
      yield { type: "text_delta", text: "Done after write." };
      yield {
        type: "usage",
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
      };
      yield { type: "done", reason: "completed" };
    };

    const turn = runAgentTurn(
      makeInput(session, streamChat, {
        userText: "write it now",
        interruptPort: port,
        takePendingSteer: () => {
          if (!armed) return [];
          armed = false;
          return [queued("q1", "and check twice", session.id)];
        },
      }),
    );
    assert.ok(port.fire);
    // The provider can report completed even after the signal fires. No
    // tool has started yet, so the stale write must never execute.
    const result = await turn;

    assert.equal(result.status, "idle");
    assert.equal(result.modelIterations, 2);
    assert.equal(
      existsSync(target),
      false,
      "an unstarted write is cancelled before applying the new intent",
    );
    const toolMsg = session.messages.find((m) => m.role === "tool");
    assert.equal(toolMsg?.toolCallId, "call-w-2");
    assert.ok(
      session.messages.some(
        (m) => m.role === "user" && JSON.stringify(m).includes("check twice"),
      ),
      "armed prompt still drained mid-turn",
    );
  });

  it("consumes an interrupt even after its queued prompt is removed or deferred", async () => {
    const session = makeSession("interrupt-withdrawn");
    const port: { fire: (() => boolean) | null } = { fire: null };
    let rounds = 0;
    const streamChat: StreamChatFn = async function* (_config, options) {
      rounds += 1;
      if (rounds === 1) {
        yield { type: "text_delta", text: "Partial." };
        port.fire?.();
        yield { type: "done", reason: "cancelled" };
        return;
      }
      assert.equal(options.signal?.aborted, false, "next request has a fresh signal");
      yield { type: "text_delta", text: "Resumed original task." };
      yield { type: "done", reason: "completed" };
    };
    const result = await runAgentTurn(makeInput(session, streamChat, {
      interruptPort: port,
      // The user removed/disarmed the last queued message before the gate.
      takePendingSteer: () => [],
    }));
    assert.equal(result.status, "idle");
    assert.equal(rounds, 2);
  });

  it("handles a provider AbortError without a done event as a prompt interrupt", async () => {
    const session = makeSession("interrupt-throw");
    const port: { fire: (() => boolean) | null } = { fire: null };
    let rounds = 0;
    let armed = false;
    const streamChat: StreamChatFn = async function* () {
      rounds += 1;
      if (rounds === 1) {
        yield { type: "text_delta", text: "Partial." };
        armed = true;
        port.fire?.();
        throw new DOMException("Aborted", "AbortError");
      }
      yield { type: "text_delta", text: "New direction." };
      yield { type: "done", reason: "completed" };
    };
    const result = await runAgentTurn(makeInput(session, streamChat, {
      interruptPort: port,
      takePendingSteer: () => {
        if (!armed) return [];
        armed = false;
        return [queued("q1", "Change direction", session.id)];
      },
    }));
    assert.equal(result.status, "idle");
    assert.equal(rounds, 2);
    assert.ok(session.messages.some((message) => message.role === "user" &&
      JSON.stringify(message).includes("Change direction")));
  });

  it("repeated interrupts each insert once and recreate a usable stream signal", async () => {
    const session = makeSession("interrupt-repeat");
    const port: { fire: (() => boolean) | null } = { fire: null };
    let rounds = 0;
    let pending: QueuedPrompt[] = [];
    const streamChat: StreamChatFn = async function* (_config, options) {
      rounds++;
      assert.equal(options.signal?.aborted, false);
      yield { type: "text_delta", text: `Round ${rounds}.` };
      if (rounds < 3) {
        pending = [queued(`q${rounds}`, `Correction ${rounds}`, session.id)];
        assert.equal(port.fire?.(), true);
        assert.equal(port.fire?.(), false, "one shot per boundary");
        yield { type: "error", message: "Request cancelled" };
        yield { type: "done", reason: "cancelled" };
        return;
      }
      yield { type: "done", reason: "completed" };
    };
    const events: StreamEvent[] = [];
    const result = await runAgentTurn(makeInput(session, streamChat, {
      interruptPort: port,
      takePendingSteer: () => { const taken = pending; pending = []; return taken; },
      onEvent: (event) => events.push(event),
    }));
    assert.equal(result.status, "idle");
    assert.equal(rounds, 3);
    assert.equal(events.filter((event) => event.type === "steer_consumed").length, 2);
    assert.equal(events.some((event) => event.type === "error"), false);
    assert.equal(port.fire, null, "disposed host cannot receive late interrupts");
  });

  it("Stop takes precedence over a simultaneous prompt interrupt", async () => {
    const session = makeSession("interrupt-stop");
    const stop = new AbortController();
    const port: { fire: (() => boolean) | null } = { fire: null };
    let pending: QueuedPrompt[] = [];
    const streamChat: StreamChatFn = async function* () {
      yield { type: "text_delta", text: "Partial." };
      pending = [queued("q1", "Retained correction", session.id)];
      port.fire?.();
      stop.abort();
      yield { type: "done", reason: "cancelled" };
    };
    const result = await runAgentTurn(makeInput(session, streamChat, {
      signal: stop.signal, interruptPort: port,
      takePendingSteer: () => { const taken = pending; pending = []; return taken; },
    }));
    assert.equal(result.status, "cancelled");
    assert.equal(pending.length, 1, "an undrained correction stays in the queue");
    assert.equal(session.messages.some((message) =>
      message.role === "user" && JSON.stringify(message).includes("Retained correction")), false);
  });

  it(
    "aborts a hanging interruptible shell call and continues the turn",
    // POSIX sleep semantics; cmd.exe path differs — covered manually on win.
    { skip: process.platform === "win32" },
    async () => {
      const session = makeSession("interrupt-shell");
      session.workspacePath = userDataDir;
      let round = 0;
      let armed = false;
      const port: { fire: (() => boolean) | null } = { fire: null };

      const streamChat: StreamChatFn = async function* (
        _config: OpenAiCompatibleClientConfig,
        _options: StreamChatOptions,
      ): AsyncGenerator<StreamEvent, void, undefined> {
        round += 1;
        if (round === 1) {
          yield {
            type: "tool_call",
            id: "call-s-1",
            name: "run_shell",
            arguments: { command: "sleep 20" },
            argumentsRaw: JSON.stringify({ command: "sleep 20" }),
          };
          yield {
            type: "usage",
            promptTokens: 10,
            completionTokens: 5,
            totalTokens: 15,
          };
          yield { type: "done", reason: "completed" };
          return;
        }
        yield { type: "text_delta", text: "Shell was interrupted; continuing." };
        yield {
          type: "usage",
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
        };
        yield { type: "done", reason: "completed" };
      };

      const startedAt = Date.now();
      const turn = runAgentTurn(
        makeInput(session, streamChat, {
          userText: "run it",
          interruptPort: port,
          takePendingSteer: () => {
            if (!armed) return [];
            armed = false;
            return [queued("q1", "actually stop that", session.id)];
          },
        }),
      );
      assert.ok(port.fire);
      // Wait for the tool phase to start, then fire: the hanging run_shell
      // must abort while the turn itself survives.
      setTimeout(() => {
        armed = true;
        port.fire?.();
      }, 300);

      const result = await turn;
      assert.equal(result.status, "idle", "turn survives the tool interrupt");
      assert.equal(result.modelIterations, 2);
      assert.ok(Date.now() - startedAt < 10_000, "aborted shell settles promptly");
      const toolMsg = session.messages.find((m) => m.role === "tool");
      assert.ok(toolMsg, "shell settled a cancelled result instead of hanging");
      assert.equal(toolMsg?.toolCallId, "call-s-1");
      assert.ok(
        session.messages.some(
          (m) => m.role === "user" && JSON.stringify(m).includes("actually stop"),
        ),
        "armed prompt drained after the aborted shell",
      );
    },
  );
});

describe("runAgentTurn reasoning part placement", () => {
  /**
   * The merged reasoning part must sit where the round's reasoning actually
   * streamed — above the reply text when thinking led, below it when the
   * reply led. The conversation projection renders parts in stored order:
   * a trailing placement used to flip the text above its Thought and split
   * one visual Thinking block into two rows on snapshot rebuilds (relay web
   * console, desktop remount).
   */
  const projectedRows = (session: Session): string[] =>
    projectTranscriptMessages(session.messages as never).map((message) =>
      message.parts.map((part) => part.type).join("+"),
    );

  it("reasoning before reply text keeps the Thought above the text", async () => {
    const session = makeSession("reasoning-placement-led");
    const stream: StreamChatFn = async function* () {
      yield { type: "reasoning_delta", text: "Thinking it through." };
      yield { type: "text_delta", text: "The visible answer." };
      yield { type: "usage", promptTokens: 10, completionTokens: 5, totalTokens: 15 };
      yield { type: "done", reason: "completed" };
    };
    const result = await runAgentTurn(makeInput(session, stream));
    assert.equal(result.status, "idle");

    const assistant = session.messages.find((message) => message.role === "assistant");
    assert.ok(assistant);
    const partTypes = assistant.parts.map((part) => part.type);
    const reasoningIdx = partTypes.indexOf("reasoning");
    const textIdx = partTypes.indexOf("text");
    assert.ok(reasoningIdx >= 0 && textIdx >= 0, `parts: ${partTypes.join(",")}`);
    assert.ok(reasoningIdx < textIdx, `reasoning must precede text: ${partTypes.join(",")}`);

    // Row 0 is the user prompt — the turn's rows follow it.
    const rows = projectedRows(session).slice(1);
    assert.deepEqual(
      rows.map((row) => (row.includes("reasoning") ? "thought" : row === "text" ? "text" : row)),
      ["thought", "text"],
      `Thought row must precede the text row: ${rows.join(" ; ")}`,
    );
  });

  it("reply-led round keeps the Thought below the text", async () => {
    const session = makeSession("reasoning-placement-text-led");
    const stream: StreamChatFn = async function* () {
      yield { type: "text_delta", text: "Answer first." };
      yield { type: "reasoning_delta", text: "…and thinking afterwards." };
      yield { type: "usage", promptTokens: 10, completionTokens: 5, totalTokens: 15 };
      yield { type: "done", reason: "completed" };
    };
    const result = await runAgentTurn(makeInput(session, stream));
    assert.equal(result.status, "idle");

    const assistant = session.messages.find((message) => message.role === "assistant");
    assert.ok(assistant);
    const partTypes = assistant.parts.map((part) => part.type);
    const reasoningIdx = partTypes.indexOf("reasoning");
    const textIdx = partTypes.indexOf("text");
    assert.ok(reasoningIdx > textIdx, `text-led round keeps reasoning trailing: ${partTypes.join(",")}`);

    const rows = projectedRows(session).slice(1);
    assert.deepEqual(
      rows.map((row) => (row.includes("reasoning") ? "thought" : row === "text" ? "text" : row)),
      ["text", "thought"],
      `text row must precede the Thought row: ${rows.join(" ; ")}`,
    );
  });

  it("reasoning → text → tool round anchors the Thought above both", async () => {
    const session = makeSession("reasoning-placement-tool-round");
    const stream: StreamChatFn = (function makeStream(): StreamChatFn {
      let calls = 0;
      return async function* () {
        calls += 1;
        if (calls === 1) {
          yield { type: "reasoning_delta", text: "Need the time." };
          yield { type: "text_delta", text: "Checking the clock." };
          yield {
            type: "tool_call",
            id: "call-place-1",
            name: "get_current_time",
            arguments: {},
            argumentsRaw: "{}",
          };
          yield { type: "usage", promptTokens: 20, completionTokens: 8, totalTokens: 28 };
          yield { type: "done", reason: "completed" };
          return;
        }
        yield { type: "text_delta", text: "All set." };
        yield { type: "usage", promptTokens: 30, completionTokens: 4, totalTokens: 34 };
        yield { type: "done", reason: "completed" };
      };
    })();
    const result = await runAgentTurn(makeInput(session, stream));
    assert.equal(result.status, "idle");

    const first = session.messages.find(
      (message) => message.role === "assistant" && message.parts.some((part) => part.type === "tool_call"),
    );
    assert.ok(first);
    const partTypes = first.parts.map((part) => part.type);
    const reasoningIdx = partTypes.indexOf("reasoning");
    const textIdx = partTypes.indexOf("text");
    const toolIdx = partTypes.indexOf("tool_call");
    assert.ok(
      reasoningIdx >= 0 && textIdx >= 0 && toolIdx >= 0,
      `parts: ${partTypes.join(",")}`,
    );
    assert.ok(
      reasoningIdx < textIdx && textIdx < toolIdx,
      `stream order reasoning → text → tool must survive: ${partTypes.join(",")}`,
    );
  });
});

describe("runAgentTurn retry continuation", () => {
  /**
   * Retry on an error card submits a hidden "continue the task" prompt
   * instead of resending the failed turn's prompt. The turn pipeline must
   * keep all three guarantees at once: the prompt is persisted with the
   * RETRY_CONTINUATION_PART_ID marker, the model wire carries its text, and
   * the conversation projection (desktop + relay web) drops it.
   */
  it("persists the marked prompt, sends it to the model, hides it from the UI", async () => {
    const session = makeSession("retry-continuation-roundtrip");
    session.messages.push(
      {
        id: "u-orig",
        role: "user",
        createdAt: 1,
        parts: [{ type: "text", text: "fix the bug" }],
      },
      {
        id: "a-partial",
        role: "assistant",
        createdAt: 2,
        parts: [{ type: "text", text: "halfway through the fix" }],
      },
    );
    const wire: unknown[] = [];
    const stream: StreamChatFn = async function* (_config, options) {
      wire.push(options.messages);
      yield { type: "text_delta", text: "Picked up and finished." };
      yield { type: "usage", promptTokens: 10, completionTokens: 5, totalTokens: 15 };
      yield { type: "done", reason: "completed" };
    };
    const result = await runAgentTurn(
      makeInput(session, stream, {
        userText: RETRY_CONTINUATION_PROMPT,
        continuation: "retry",
      }),
    );
    assert.equal(result.status, "idle");

    const persisted = session.messages.find(
      (message) =>
        message.role === "user" &&
        message.parts.some(
          (part) => part.type === "text" && part.id === RETRY_CONTINUATION_PART_ID,
        ),
    );
    assert.ok(persisted, "continuation prompt persisted with the marker");

    const wireText = JSON.stringify(wire);
    assert.ok(
      wireText.includes("interrupted by an error"),
      "model wire carries the continuation text",
    );
    assert.ok(
      wireText.includes("fix the bug"),
      "original prompt still on the wire (nothing was resent)",
    );

    const projected = projectTranscriptMessages(session.messages as never);
    assert.equal(
      projected.some((message) =>
        message.parts.some(
          (part) => part.type === "text" && part.id === RETRY_CONTINUATION_PART_ID,
        ),
      ),
      false,
      "projection hides the continuation prompt",
    );
    assert.ok(
      projected.some(
        (message) =>
          message.role === "user" &&
          message.parts.some(
            (part) => part.type === "text" && part.text === "fix the bug",
          ),
      ),
      "original prompt bubble stays",
    );
    assert.ok(
      projected.some(
        (message) =>
          message.role === "assistant" &&
          message.parts.some(
            (part) => part.type === "text" && part.text === "Picked up and finished.",
          ),
      ),
      "continuation output renders",
    );
  });
});
