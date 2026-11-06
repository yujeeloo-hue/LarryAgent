/**
 * FSMGraph + TurnHost (mock LLM) integration — sample graphs, not runAgentTurn.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { StreamEvent } from "../../llm/streamEvents.js";
import type {
  OpenAiCompatibleClientConfig,
  StreamChatOptions,
} from "../../llm/types.js";
import { configureUserMemoryRoot } from "../../memory/store.js";
import type { Session } from "../../session/types.js";
import { configurePromptDefaults } from "../../settings/promptDefaults.js";
import { registerBuiltins } from "../../tools/index.js";
import type { PermissionGateState } from "../../tools/types.js";
import { createTurnHost } from "../turnHost/createTurnHost.js";
import type { RunAgentTurnInput, StreamChatFn } from "../types.js";
import { createTurnScope } from "../workflow/turnScope.js";
import { createDefaultActionRegistry } from "./actions/createDefaultActionRegistry.js";
import {
  createReactGraphConfig,
  createSubagentGraphConfig,
} from "./configs/sampleGraphs.js";
import { FSMGraph } from "./FSMGraph.js";

let userDataDir = "";

before(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), "fsm-host-"));
  configureUserMemoryRoot(userDataDir);
  configurePromptDefaults(join(process.cwd(), "resources", "prompts"));
  registerBuiltins();
});

after(async () => {
  if (userDataDir) {
    await rm(userDataDir, { recursive: true, force: true });
  }
});

function makeSession(): Session {
  const now = Date.now();
  return {
    id: "fsm-host-sess",
    type: "agent",
    title: "FSM Host bridge",
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

function mockTextStream(text = "Hello from mock model."): StreamChatFn {
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

function makeTurnInput(
  session: Session,
  streamChat: StreamChatFn,
  overrides?: Partial<RunAgentTurnInput>,
): RunAgentTurnInput {
  let id = 0;
  return {
    session,
    userText: "Say hi",
    client: {
      baseUrl: "http://127.0.0.1:9",
      apiKey: "test-key",
      model: "mock-model",
    },
    gate: { fullPermissionsEnabled: true } as PermissionGateState,
    createId: () => `id-${++id}`,
    streamChat,
    unlimitedTurnBudgets: true,
    ...overrides,
  };
}

describe("fsm Step 4 Host bridge", () => {
  it("runs react sample with TurnHost + mock LLM to end_node", async () => {
    const session = makeSession();
    const turnInput = makeTurnInput(session, mockTextStream());
    const host = createTurnHost({
      ...turnInput,
      runChildTurn: async () => ({ status: "idle", modelIterations: 0 }),
    });

    try {
      const result = await FSMGraph.run(
        createReactGraphConfig(),
        { turnScope: createTurnScope(turnInput) },
        {
          registries: createDefaultActionRegistry(),
          host,
          turnInput,
        },
      );

      assert.equal(result.reason, "end_node");
      assert.deepEqual(result.nodesVisited, [
        "start",
        "agent",
        "skill_reflect_gate",
        "end",
      ]);
      assert.equal(result.turnContext.finishedIdle, true);
      assert.equal(session.status, "idle");
      assert.ok(session.messages.some((m) => m.role === "user"));
      assert.ok(session.messages.some((m) => m.role === "assistant"));
      const assistant = session.messages.find((m) => m.role === "assistant");
      const text = assistant?.parts.find((p) => p.type === "text");
      assert.ok(text && text.type === "text" && text.text.includes("Hello"));
    } finally {
      host.dispose();
    }
  });

  it("runs subagent sample with TurnHost + mock LLM", async () => {
    const session = makeSession();
    session.id = "fsm-subagent-sess";
    const turnInput = makeTurnInput(session, mockTextStream("Child done."), {
      isSubagentTurn: true,
      subagentRoleKind: "explore",
      parentSessionId: "parent",
      subagentId: "child-1",
    });
    const host = createTurnHost({
      ...turnInput,
      runChildTurn: async () => ({ status: "idle", modelIterations: 0 }),
    });

    try {
      const scope = createTurnScope(turnInput);
      const result = await FSMGraph.run(
        createSubagentGraphConfig({ subagentRole: "explore" }),
        { turnScope: scope },
        {
          registries: createDefaultActionRegistry(),
          host,
          turnInput,
        },
      );

      assert.equal(result.reason, "end_node");
      assert.deepEqual(result.nodesVisited, [
        "start",
        "subagent",
        "end",
      ]);
      // activeRole single ledger: scope.turnState, no turnContext mirror.
      assert.equal(scope.turnState.activeRole, "subagent");
      assert.equal(session.status, "idle");
    } finally {
      host.dispose();
    }
  });

  it("RoundGate aborts when signal already aborted", async () => {
    const session = makeSession();
    const ac = new AbortController();
    ac.abort();
    const turnInput = makeTurnInput(session, mockTextStream(), {
      signal: ac.signal,
    });
    const host = createTurnHost({
      ...turnInput,
      runChildTurn: async () => ({ status: "idle", modelIterations: 0 }),
    });

    try {
      const result = await FSMGraph.run(
        createReactGraphConfig(),
        { turnScope: createTurnScope(turnInput) },
        {
          registries: createDefaultActionRegistry(),
          host,
          turnInput,
        },
      );
      // startTurn runs first; abort is checked on the agent node's RoundGate.
      assert.equal(result.reason, "halt");
      assert.equal(session.status, "cancelled");
    } finally {
      host.dispose();
    }
  });
});
