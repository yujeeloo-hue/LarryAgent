import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { StreamEvent } from "../../llm/streamEvents.js";
import type { OpenAiToolDefinition } from "../../llm/types.js";
import { configureUserMemoryRoot } from "../../memory/store.js";
import { openSessionDb } from "../../session/db/openDb.js";
import { loadSessionRows, upsertSession } from "../../session/db/sessionRepository.js";
import { messagesForPresentation } from "../../session/presentation.js";
import type { Session } from "../../session/types.js";
import { WIRE_OVERLAY_HEADER } from "../../session/wireOverlay.js";
import { configurePromptDefaults } from "../../settings/promptDefaults.js";
import { registerBuiltins } from "../../tools/index.js";
import type { PermissionGateState } from "../../tools/types.js";
import { createTurnHost } from "./createTurnHost.js";

const SNAPSHOT = "[Workspace snapshot — test]\nRoot: /repo (git, branch main)\nGit status: clean";
const CATALOG = "[Installed skills — test]\n- demo-skill: Does demo things";

let userDataDir = "";

before(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), "turn-context-"));
  configureUserMemoryRoot(userDataDir);
  configurePromptDefaults(join(process.cwd(), "resources", "prompts"));
  registerBuiltins();
});

after(async () => {
  if (userDataDir) await rm(userDataDir, { recursive: true, force: true });
});

function makeSession(): Session {
  const now = Date.now();
  return {
    id: "turn-context-sess",
    type: "agent",
    title: "Turn context",
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

function makeHost(session: Session, onEvent?: (event: StreamEvent) => void) {
  let id = 0;
  return createTurnHost({
    session,
    client: { baseUrl: "http://127.0.0.1:9", apiKey: "test-key", model: "mock-model" },
    gate: { fullPermissionsEnabled: true } as PermissionGateState,
    createId: () => `id-${++id}`,
    unlimitedTurnBudgets: true,
    skillCatalogPrompt: CATALOG,
    turnContext: SNAPSHOT,
    ...(onEvent ? { onEvent } : {}),
    runChildTurn: async () => ({ status: "idle" as const, modelIterations: 0 }),
  });
}

describe("turn context placement", () => {
  it("persists the snapshot on the user message and puts it before the user's text on the wire", async () => {
    const session = makeSession();
    const host = makeHost(session);
    try {
      assert.equal(await host.startTurn({ userText: "Fix the panel" }), "ok");
      const user = session.messages.find((m) => m.role === "user");
      assert.ok(user);
      assert.deepEqual(user.parts.at(-1), {
        type: "turn_context",
        source: "repository_snapshot",
        text: SNAPSHOT,
      });

      const result = await host.prepareModelWindow({ tools: [] });
      assert.equal(result.ok, true);
      if (!result.ok) return;
      const last = result.messages.at(-1)!;
      assert.equal(last.role, "user");
      const body = String(last.content);
      assert.match(body, /^<turn_context source="repository_snapshot">/);
      assert.ok(body.includes(SNAPSHOT));
      assert.ok(body.endsWith("</turn_context>\n\nFix the panel"));
      assert.equal(
        result.messages.some((m) => typeof m.content === "string" && m.content.startsWith(WIRE_OVERLAY_HEADER)),
        false,
      );
    } finally {
      host.dispose();
    }
  });

  it("places the skill catalog in the system prefix right after AGENT", async () => {
    const session = makeSession();
    const host = makeHost(session);
    try {
      await host.startTurn({ userText: "Fix the panel" });
      const result = await host.prepareModelWindow({ tools: [] });
      assert.equal(result.ok, true);
      if (!result.ok) return;
      const agent = result.messages.findIndex((m) => m.role === "system" && String(m.content).startsWith("[AGENT]"));
      assert.ok(agent >= 0);
      assert.deepEqual(result.messages[agent + 1], { role: "system", content: CATALOG });
      assert.equal(
        result.messages.filter((m) => String(m.content).startsWith("[Installed skills")).length,
        1,
      );
    } finally {
      host.dispose();
    }
  });

  it("never exposes the snapshot to presentation surfaces", async () => {
    const session = makeSession();
    const host = makeHost(session);
    try {
      await host.startTurn({ userText: "Fix the panel" });
      const shown = messagesForPresentation(session.messages);
      assert.doesNotMatch(JSON.stringify(shown), /turn_context|Workspace snapshot/);
      assert.deepEqual(shown[0]!.parts, [{ type: "text", text: "Fix the panel" }]);
    } finally {
      host.dispose();
    }
  });

  it("publishes and persists the classified request alongside the provider measurement", async () => {
    const session = makeSession();
    const events: StreamEvent[] = [];
    const createdAt = Date.now();
    session.messages.push(
      { id: "old", role: "user", createdAt, parts: [{ type: "text", text: "Earlier conversation" }] },
      {
        id: "summary", role: "system", createdAt,
        parts: [{
          type: "context_compaction", id: "compaction", summary: "The user selected a stacked bar.",
          fromMessageId: "old", toMessageId: "old", coveredThroughMessageId: "old",
          usedTokensBefore: 1_000, usedTokensAfter: 50,
        }],
      },
      {
        id: "read", role: "assistant", createdAt,
        parts: [{
          type: "tool_call", id: "call", name: "read_skill", status: "done",
          arguments: { name: "design" }, argumentsRaw: '{"name":"design"}',
        }],
      },
      {
        id: "skill", role: "tool", toolCallId: "call", createdAt,
        parts: [{
          type: "tool_result", toolCallId: "call", returnCode: 0,
          content: [{ type: "text", text: "Design skill contents and reading notes." }],
        }],
      },
    );
    const host = makeHost(session, (event) => events.push(event));
    try {
      await host.startTurn({ userText: "Fix the panel" });
      const tools: OpenAiToolDefinition[] = [{ type: "function", function: { name: "read_skill" } }];
      const window = await host.prepareModelWindow({ tools, trailingOverlay: "Current plan: verify the panel." });
      assert.ok(window.ok);

      const result = await host.streamModelRound({
        llm: {
          client: { baseUrl: "http://127.0.0.1:9", apiKey: "test-key", model: "mock-model" },
          async *stream() {
            yield { type: "text_delta", text: "Verified." };
            yield { type: "usage", totalTokens: 1_200, completionTokens: 200, cachedTokens: 500 };
            yield { type: "done", reason: "completed" };
          },
        },
        messages: window.messages,
        tools,
        progressText: "Checking context",
      });
      assert.equal(result.kind, "ok");
      const display = events.find((event) => event.type === "context_display" && event.source === "provider");
      assert.ok(display && display.type === "context_display");
      assert.equal(display.inputTokens, 1_000);
      assert.equal(display.cachedTokens, 500);
      assert.deepEqual(display.breakdown, session.contextUsage.breakdown);
      assert.ok(display.breakdown);
      assert.equal(Object.keys(display.breakdown).length, 7);
      assert.equal(Object.values(display.breakdown).reduce((total, count) => total + count, 0), session.contextUsage.requestEstimateTokens);
      assert.ok(events.some((event) => event.type === "usage" && event.contextDisplayHandled));

      const db = openSessionDb(userDataDir);
      try {
        upsertSession(db, session);
        assert.deepEqual(loadSessionRows(db).find((item) => item.id === session.id)?.contextUsage, session.contextUsage);
      } finally {
        db.close();
      }
    } finally {
      host.dispose();
    }
  });
});
