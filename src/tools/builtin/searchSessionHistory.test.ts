import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { searchSessionHistoryHandler } from "./searchSessionHistory.js";
import type { Message, Session } from "../../session/types.js";
import type { ToolExecuteContext } from "../types.js";

function msg(
  id: string,
  role: "user" | "assistant",
  text: string,
  createdAt: number,
): Message {
  return { id, role, parts: [{ type: "text", text }], createdAt };
}

function session(partial: {
  id: string;
  title: string;
  workspaceId: string;
  messages: Message[];
  updatedAt?: number;
}): Session {
  return {
    id: partial.id,
    type: "agent",
    title: partial.title,
    createdAt: 1,
    updatedAt: partial.updatedAt ?? 100,
    status: "idle",
    progressText: "",
    messages: partial.messages,
    model: "m",
    providerId: "p",
    workspaceId: partial.workspaceId,
    workspacePath: "/tmp/ws",
    pinned: false,
    archived: false,
    archivedAt: null,
    contextUsage: { usedTokens: 0 },
    plan: null,
  };
}

const jellyA = session({
  id: "ja",
  title: "Confetti overlay bug",
  workspaceId: "ws-jb",
  messages: [msg("m1", "user", "confetti physics drift", 100)],
});
const jnoteA = session({
  id: "na",
  title: "Cloud sync colors",
  workspaceId: "ws-jn",
  updatedAt: 200,
  messages: [msg("m2", "user", "cloud sync status green", 150)],
});

function makeContext(
  overrides: Partial<ToolExecuteContext> = {},
): ToolExecuteContext {
  return {
    workspacePath: "/Users/x/JellyBot",
    sessionId: "ja",
    workspaceId: "ws-jb",
    fullPermissionsEnabled: false,
    listAgentSessions: () => [jellyA, jnoteA],
    listWorkspaces: () => [
      { id: "ws-jb", name: "JellyBot" },
      { id: "ws-jn", name: "JNote" },
    ],
    ...overrides,
  };
}

describe("searchSessionHistoryHandler workspace scope", () => {
  it("defaults to all workspaces with labels", async () => {
    const result = await searchSessionHistoryHandler(
      { query: "sync" },
      makeContext(),
    );
    assert.equal(result.returnCode, 0);
    const text = result.content[0]!;
    assert.ok(text.type === "text");
    assert.match(text.text, /workspace="JNote"/);
    assert.match(text.text, /Cloud sync colors/);
  });

  it('narrows with workspace="current"', async () => {
    const result = await searchSessionHistoryHandler(
      { query: "sync", workspace: "current" },
      makeContext(),
    );
    assert.equal(result.returnCode, 0);
    const text = result.content[0]!;
    assert.ok(text.type === "text");
    assert.match(text.text, /No matching session history/);
  });

  it("narrows by workspace name (case-insensitive)", async () => {
    const result = await searchSessionHistoryHandler(
      { query: "confetti", workspace: "jellybot" },
      makeContext(),
    );
    assert.equal(result.returnCode, 0);
    const text = result.content[0]!;
    assert.ok(text.type === "text");
    assert.match(text.text, /confetti physics drift/);
  });

  it("rejects unknown workspace names with the available list", async () => {
    const result = await searchSessionHistoryHandler(
      { query: "x", workspace: "Apollo" },
      makeContext(),
    );
    assert.equal(result.returnCode, 5);
    const text = result.content[0]!;
    assert.ok(text.type === "text");
    assert.match(text.text, /Unknown workspace "Apollo".*"JellyBot", "JNote"/);
  });

  it('fails fast on workspace="current" without a bound workspace', async () => {
    const ctx = makeContext();
    delete ctx.workspaceId;
    const result = await searchSessionHistoryHandler(
      { query: "x", workspace: "current" },
      ctx,
    );
    assert.equal(result.returnCode, 5);
    const text = result.content[0]!;
    assert.ok(text.type === "text");
    assert.match(text.text, /no workspace bound/);
  });

  it("reads a session from another workspace under all scope", async () => {
    const result = await searchSessionHistoryHandler(
      { mode: "read", session_id: "na" },
      makeContext(),
    );
    assert.equal(result.returnCode, 0);
    const text = result.content[0]!;
    assert.ok(text.type === "text");
    assert.match(text.text, /workspace "JNote"/);
    assert.match(text.text, /cloud sync status green/);
  });

  it("fails when the session store is missing", async () => {
    const ctx = makeContext();
    delete ctx.listAgentSessions;
    const result = await searchSessionHistoryHandler({ query: "x" }, ctx);
    assert.equal(result.returnCode, 3);
  });
});
