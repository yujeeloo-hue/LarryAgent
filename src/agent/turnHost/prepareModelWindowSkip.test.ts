/**
 * Host wiring for BuildModelWindow skip flags (A3).
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { configureUserMemoryRoot } from "../../memory/store.js";
import type { Session, UserMessage } from "../../session/types.js";
import { configurePromptDefaults } from "../../settings/promptDefaults.js";
import { registerBuiltins } from "../../tools/index.js";
import type { PermissionGateState } from "../../tools/types.js";
import { createTurnHost } from "./createTurnHost.js";

let userDataDir = "";

before(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), "host-skip-"));
  configureUserMemoryRoot(userDataDir);
  configurePromptDefaults(join(process.cwd(), "resources", "prompts"));
  registerBuiltins();
});

after(async () => {
  if (userDataDir) {
    await rm(userDataDir, { recursive: true, force: true });
  }
});

function makeBulkySession(): Session {
  const now = Date.now();
  const messages: UserMessage[] = [];
  const chunk = "x".repeat(4000);
  for (let i = 0; i < 40; i += 1) {
    messages.push({
      id: `u-${i}`,
      role: "user",
      parts: [{ type: "text", text: `${chunk} turn-${i}` }],
      createdAt: now + i,
    });
  }
  return {
    id: "skip-flag-sess",
    type: "agent",
    title: "Skip flags",
    createdAt: now,
    updatedAt: now,
    status: "running",
    progressText: "",
    messages,
    model: "mock-model",
    providerId: "mock",
    workspaceId: "ws1",
    workspacePath: "",
    pinned: false,
    archived: false,
    archivedAt: null,
    contextUsage: { usedTokens: 80_000, source: "provider" },
    plan: null,
    planDoc: null,
  };
}

function makeHostInput(session: Session) {
  let id = 0;
  return {
    session,
    userText: "go",
    client: {
      baseUrl: "http://127.0.0.1:9",
      apiKey: "test-key",
      model: "mock-model",
    },
    gate: { fullPermissionsEnabled: true } as PermissionGateState,
    createId: () => `id-${++id}`,
    contextLimitTokens: 8_000,
    compactTriggerRatio: 0.55,
    unlimitedTurnBudgets: true,
    runChildTurn: async () =>
      ({ status: "idle" as const, modelIterations: 0 }),
  };
}

function makeWordySession(turns: number): Session {
  const session = makeBulkySession();
  session.messages = Array.from({ length: turns }, (_, i): UserMessage => ({
    id: `u-${i}`,
    role: "user",
    parts: [{ type: "text", text: Array.from({ length: 800 }, (_, j) => `w${i}_${j}`).join(" ") }],
    createdAt: session.createdAt + i,
  }));
  return session;
}

describe("prepareModelWindow conversationTurnLimit", () => {
  const limited = (session: Session, conversationTurnLimit: number) => {
    let summarizeCalls = 0;
    const host = createTurnHost({
      ...makeHostInput(session),
      contextLimitTokens: 100_000,
      conversationTurnLimit,
      summarize: (async () => {
        summarizeCalls += 1;
        return { content: "## Active Task\nNone." };
      }) as unknown as import("../types.js").SummarizeFn,
    });
    return { host, calls: () => summarizeCalls };
  };

  it("skips compaction while the newest Turns stay under the trigger", async () => {
    const session = makeWordySession(40);
    const { host, calls } = limited(session, 3);
    try {
      const result = await host.prepareModelWindow({ tools: [] });
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.compacted, false);
      assert.equal(calls(), 0);
      const users = result.messages.filter((m) => m.role === "user" && String(m.content).startsWith("w"));
      assert.equal(users.length, 3);
    } finally {
      host.dispose();
    }
  });

  it("compacts once the newest Turns alone cross the trigger", async () => {
    const session = makeWordySession(40);
    const { host, calls } = limited(session, 30);
    try {
      const result = await host.prepareModelWindow({ tools: [] });
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.compacted, true);
      assert.equal(calls(), 1);
    } finally {
      host.dispose();
    }
  });
});

describe("prepareModelWindow skip flags", () => {
  it("skipCompact: true skips Cold/Warm compaction", async () => {
    const session = makeBulkySession();
    const host = createTurnHost(makeHostInput(session));
    try {
      const beforeMarkers = session.messages.filter((m) =>
        m.parts.some((p) => p.type === "context_compaction"),
      ).length;
      const result = await host.prepareModelWindow({
        tools: [],
        skipCompact: true,
      });
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.compacted, false);
      const afterMarkers = session.messages.filter((m) =>
        m.parts.some((p) => p.type === "context_compaction"),
      ).length;
      assert.equal(afterMarkers, beforeMarkers);
    } finally {
      host.dispose();
    }
  });

  it("skipHardTruncate: true keeps a longer conversation suffix over trigger", async () => {
    const session = makeBulkySession();
    const host = createTurnHost(makeHostInput(session));
    try {
      const truncated = await host.prepareModelWindow({
        tools: [],
        skipCompact: true,
        skipHardTruncate: false,
      });
      assert.equal(truncated.ok, true);
      if (!truncated.ok) return;

      const session2 = makeBulkySession();
      const host2 = createTurnHost(makeHostInput(session2));
      try {
        const kept = await host2.prepareModelWindow({
          tools: [],
          skipCompact: true,
          skipHardTruncate: true,
        });
        assert.equal(kept.ok, true);
        if (!kept.ok) return;
        assert.ok(
          kept.messages.length >= truncated.messages.length,
          "skipHardTruncate should retain at least as many wire messages",
        );
      } finally {
        host2.dispose();
      }
    } finally {
      host.dispose();
    }
  });
});
