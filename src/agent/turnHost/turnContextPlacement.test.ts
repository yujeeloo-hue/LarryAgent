import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { configureUserMemoryRoot } from "../../memory/store.js";
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

function makeHost(session: Session) {
  let id = 0;
  return createTurnHost({
    session,
    client: { baseUrl: "http://127.0.0.1:9", apiKey: "test-key", model: "mock-model" },
    gate: { fullPermissionsEnabled: true } as PermissionGateState,
    createId: () => `id-${++id}`,
    unlimitedTurnBudgets: true,
    skillCatalogPrompt: CATALOG,
    turnContext: SNAPSHOT,
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
});
