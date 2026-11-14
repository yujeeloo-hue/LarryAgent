/**
 * /pause host semantics: enforceBudget consumes takePauseRequested at the
 * round boundary and finishes the turn as `paused` (no budget evaluation,
 * no LLM round). Missing hook keeps the loop deterministic.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { StreamEvent } from "../../llm/streamEvents.js";
import { configureUserMemoryRoot } from "../../memory/store.js";
import type { Session } from "../../session/types.js";
import { configurePromptDefaults } from "../../settings/promptDefaults.js";
import { registerBuiltins } from "../../tools/index.js";
import type { PermissionGateState } from "../../tools/types.js";
import { createTurnHost } from "./createTurnHost.js";

let userDataDir = "";

before(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), "turn-pause-"));
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
    id: "turn-pause-sess",
    type: "agent",
    title: "Pause test",
    createdAt: now,
    updatedAt: now,
    status: "running",
    progressText: "Working…",
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

function makeBaseInput() {
  let id = 0;
  return {
    session: makeSession(),
    userText: "Say hi",
    client: {
      baseUrl: "http://127.0.0.1:9",
      apiKey: "test-key",
      model: "mock-model",
    },
    gate: { fullPermissionsEnabled: true } as PermissionGateState,
    createId: () => `id-${++id}`,
    unlimitedTurnBudgets: true,
    runChildTurn: async () =>
      ({ status: "idle" as const, modelIterations: 0 }),
  };
}

describe("/pause round boundary (host.enforceBudget)", () => {
  it("finishes the turn as paused when a pause is requested", async () => {
    const events: StreamEvent[] = [];
    const input = {
      ...makeBaseInput(),
      takePauseRequested: () => true,
      onEvent: (event: StreamEvent) => {
        events.push(event);
      },
    };
    const host = createTurnHost(input);
    try {
      const result = await host.enforceBudget();
      if (result === "resume") {
        assert.fail("expected a paused TurnRunResult, got resume");
      }
      assert.equal(result.status, "paused");
      assert.equal(input.session.status, "paused");
      assert.equal(input.session.progressText, "Paused");
      const done = events.find(
        (event): event is Extract<StreamEvent, { type: "done" }> =>
          event.type === "done",
      );
      assert.ok(done, "expected a done stream event");
      assert.equal(done.reason, "paused");
    } finally {
      host.dispose();
    }
  });

  it("resumes the round when no pause is requested", async () => {
    const input = {
      ...makeBaseInput(),
      takePauseRequested: () => false,
    };
    const host = createTurnHost(input);
    try {
      assert.equal(await host.enforceBudget(), "resume");
      assert.equal(input.session.status, "running");
    } finally {
      host.dispose();
    }
  });

  it("omitting takePauseRequested keeps the loop deterministic", async () => {
    const input = makeBaseInput();
    const host = createTurnHost(input);
    try {
      assert.equal(await host.enforceBudget(), "resume");
    } finally {
      host.dispose();
    }
  });
});
