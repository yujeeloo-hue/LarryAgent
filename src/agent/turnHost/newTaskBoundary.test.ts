import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { configureUserMemoryRoot } from "../../memory/store.js";
import type { Message, Session } from "../../session/types.js";
import { configurePromptDefaults } from "../../settings/promptDefaults.js";
import { registerBuiltins } from "../../tools/index.js";
import type { PermissionGateState } from "../../tools/types.js";
import { createTurnHost } from "./createTurnHost.js";

let userDataDir = "";

before(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), "host-new-task-"));
  configureUserMemoryRoot(userDataDir);
  configurePromptDefaults(join(process.cwd(), "resources", "prompts"));
  registerBuiltins();
});

after(async () => {
  if (userDataDir) await rm(userDataDir, { recursive: true, force: true });
});

function user(id: string, text: string): Message {
  return { id, role: "user", parts: [{ type: "text", text }], createdAt: 1 };
}

function assistant(id: string, text: string): Message {
  return { id, role: "assistant", parts: [{ type: "text", text }], createdAt: 2 };
}

function makeSession(messages: Message[]): Session {
  const now = Date.now();
  return {
    id: "new-task-sess",
    type: "agent",
    title: "New task boundary",
    createdAt: now,
    updatedAt: now,
    status: "idle",
    progressText: "",
    messages,
    model: "mock-model",
    providerId: "mock",
    workspaceId: "ws1",
    workspacePath: "",
    pinned: false,
    archived: false,
    archivedAt: null,
    contextUsage: { usedTokens: 120_000, source: "provider" },
    plan: null,
    planDoc: null,
  };
}

function makeHost(session: Session, reply: string) {
  let id = 0;
  return createTurnHost({
    session,
    client: {
      baseUrl: "http://127.0.0.1:9",
      apiKey: "test-key",
      model: "mock-model",
    },
    gate: { fullPermissionsEnabled: true } as PermissionGateState,
    createId: () => `id-${++id}`,
    contextLimitTokens: 128_000,
    unlimitedTurnBudgets: true,
    topicBoundaryComplete: (async () => ({ content: reply })) as never,
    runChildTurn: async () => ({ status: "idle" as const, modelIterations: 0 }),
  });
}

describe("startTurn relevance boundary", () => {
  it("writes the marker before the prompt and drops the old task from the window", async () => {
    const session = makeSession([user("u1", "Fix the login bug"), assistant("a1", "Fixed.")]);
    const host = makeHost(session, '{"related":false}');
    try {
      assert.equal(
        await host.startTurn({ userText: "Write a haiku about autumn" }),
        "ok",
      );
      const messages = session.messages;
      const markerIndex = messages.findIndex((m) =>
        m.parts.some((p) => p.type === "context_new_task"),
      );
      const promptIndex = messages.findIndex(
        (m) => m.role === "user" && m.parts.some(
          (p) => p.type === "text" && p.text === "Write a haiku about autumn",
        ),
      );
      assert.ok(markerIndex >= 0, "a boundary marker must be written");
      assert.equal(markerIndex, promptIndex - 1);
      assert.equal(session.contextUsage.usedTokens, 0);

      const window = await host.prepareModelWindow({ tools: [] });
      assert.equal(window.ok, true);
      if (!window.ok) return;
      assert.equal(window.compacted, false);
      const text = window.messages
        .map((m) => (typeof m.content === "string" ? m.content : ""))
        .join("\n");
      assert.doesNotMatch(text, /Fix the login bug|Fixed\./);
      assert.match(text, /Write a haiku about autumn/);
    } finally {
      host.dispose();
    }
  });

  it("keeps the context when the prompt continues the task", async () => {
    const session = makeSession([user("u1", "Fix the login bug"), assistant("a1", "Fixed.")]);
    const host = makeHost(session, '{"related":true}');
    try {
      assert.equal(await host.startTurn({ userText: "Add a test for it" }), "ok");
      assert.equal(
        session.messages.some((m) =>
          m.parts.some((p) => p.type === "context_new_task"),
        ),
        false,
      );
      const window = await host.prepareModelWindow({ tools: [] });
      assert.equal(window.ok, true);
      if (!window.ok) return;
      const text = window.messages
        .map((m) => (typeof m.content === "string" ? m.content : ""))
        .join("\n");
      assert.match(text, /Fix the login bug/);
      assert.match(text, /Add a test for it/);
    } finally {
      host.dispose();
    }
  });

  it("never judges plan Approve control turns", async () => {
    const session = makeSession([user("u1", "Plan it"), assistant("a1", "Plan ready")]);
    let calls = 0;
    let id = 0;
    const host = createTurnHost({
      session,
      client: {
        baseUrl: "http://127.0.0.1:9",
        apiKey: "test-key",
        model: "mock-model",
      },
      gate: { fullPermissionsEnabled: true } as PermissionGateState,
      createId: () => `id-${++id}`,
      contextLimitTokens: 128_000,
      unlimitedTurnBudgets: true,
      topicBoundaryComplete: (async () => {
        calls += 1;
        return { content: '{"related":false}' };
      }) as never,
      runChildTurn: async () => ({ status: "idle" as const, modelIterations: 0 }),
    });
    try {
      assert.equal(
        await host.startTurn({ userText: "Approve", skipTopicBoundary: true }),
        "ok",
      );
      assert.equal(calls, 0);
      assert.equal(
        session.messages.some((m) =>
          m.parts.some((p) => p.type === "context_new_task"),
        ),
        false,
      );
    } finally {
      host.dispose();
    }
  });
});
