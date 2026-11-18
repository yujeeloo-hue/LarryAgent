import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  ContextCompactionPart,
  Message,
  Session,
} from "../../../../session/types.js";
import { maybeCompactBeforeIteration } from "./compactContext.js";

function user(id: string, text: string): Message {
  return { id, role: "user", parts: [{ type: "text", text }], createdAt: 1 };
}

function assistant(id: string, text: string): Message {
  return { id, role: "assistant", parts: [{ type: "text", text }], createdAt: 2 };
}

function boundary(id: string): Message {
  return {
    id,
    role: "system",
    createdAt: 3,
    parts: [
      {
        type: "context_new_task",
        id: `${id}-part`,
        reason: "unrelated_prompt",
        hiddenMessageCount: 2,
      },
    ],
  };
}

function compactionMarker(id: string, summary: string): Message {
  const part: ContextCompactionPart = {
    type: "context_compaction",
    id: `${id}-part`,
    summary,
    fromMessageId: "old-u",
    toMessageId: "old-a",
    usedTokensBefore: 1,
    usedTokensAfter: 1,
  };
  return { id, role: "system", parts: [part], createdAt: 4 };
}

function makeSession(messages: Message[]): Session {
  return {
    id: "compact-scope",
    type: "agent",
    title: "Scope",
    createdAt: 1,
    updatedAt: 1,
    status: "running",
    progressText: "",
    messages,
    model: "m",
    providerId: "p",
    workspaceId: "ws",
    workspacePath: "",
    pinned: false,
    archived: false,
    archivedAt: null,
    contextUsage: { usedTokens: 0, source: "estimate" },
    plan: null,
    planDoc: null,
  };
}

const BULK = "lorem ipsum dolor sit amet ".repeat(400);

describe("compaction across a New Task boundary", () => {
  it("never summarizes or re-summarizes text above the boundary", async () => {
    const session = makeSession([
      user("old-u", `OLD TASK ${BULK}`),
      assistant("old-a", `OLD ANSWER ${BULK}`),
      compactionMarker("old-marker", "Old rolling summary of the previous task."),
      boundary("boundary"),
      user("new-u", `NEW TASK ${BULK}`),
      assistant("new-a", `NEW ANSWER ${BULK}`),
      user("new-u2", `NEW FOLLOW-UP ${BULK}`),
      assistant("new-a2", "ok"),
    ]);
    const captured: string[] = [];
    const result = await maybeCompactBeforeIteration({
      session,
      client: { baseUrl: "http://127.0.0.1:9", apiKey: "k", model: "m" },
      createId: () => `id-${captured.length}-${Math.random().toString(16).slice(2, 8)}`,
      contextLimitTokens: 8_000,
      compactTriggerRatio: 0.4,
      iterationProtectRawIterationCount: 1,
      iterationProtectTokenRatio: 0.1,
      tools: [],
      force: true,
      summarize: (async (_client: unknown, options: { messages: Array<{ content?: unknown }> }) => {
        captured.push(String(options.messages.map((m) => m.content).join("\n")));
        return { content: "New summary of the new task only." };
      }) as never,
    });
    assert.equal(result.compacted, true);
    assert.equal(captured.length, 1);
    assert.match(captured[0]!, /NEW TASK/);
    assert.doesNotMatch(captured[0]!, /OLD TASK|OLD ANSWER|Old rolling summary/);

    const markers = session.messages.filter((m) =>
      m.parts.some((p) => p.type === "context_compaction"),
    );
    assert.equal(markers.length, 2);
    assert.match(
      String(markers[0]!.parts[0] && (markers[0]!.parts[0] as ContextCompactionPart).summary),
      /Old rolling summary/,
    );
    const boundaryIndex = session.messages.findIndex((m) =>
      m.parts.some((p) => p.type === "context_new_task"),
    );
    const newMarkerIndex = session.messages.findIndex(
      (m, index) =>
        index > boundaryIndex &&
        m.parts.some((p) => p.type === "context_compaction"),
    );
    assert.ok(newMarkerIndex > boundaryIndex);
  });

  it("starts from the boundary with no prior summary to merge", async () => {
    const session = makeSession([
      user("old-u", `OLD TASK ${BULK}`),
      assistant("old-a", "done"),
      boundary("boundary"),
      user("new-u", `NEW TASK ${BULK}`),
      assistant("new-a", `NEW ANSWER ${BULK}`),
      user("new-u2", `NEW FOLLOW-UP ${BULK}`),
    ]);
    const captured: string[] = [];
    await maybeCompactBeforeIteration({
      session,
      client: { baseUrl: "http://127.0.0.1:9", apiKey: "k", model: "m" },
      createId: () => `id-${Math.random().toString(16).slice(2, 10)}`,
      contextLimitTokens: 8_000,
      compactTriggerRatio: 0.4,
      iterationProtectRawIterationCount: 1,
      iterationProtectTokenRatio: 0.1,
      tools: [],
      force: true,
      summarize: (async (_client: unknown, options: { messages: Array<{ content?: unknown }> }) => {
        captured.push(String(options.messages.map((m) => m.content).join("\n")));
        return { content: "Summary." };
      }) as never,
    });
    assert.equal(captured.length, 1);
    assert.doesNotMatch(captured[0]!, /PREVIOUS SUMMARY/);
    const marker = session.messages
      .filter((m) => m.parts.some((p) => p.type === "context_compaction"))
      .at(-1)!;
    const part = marker.parts[0] as ContextCompactionPart;
    const boundaryIndex = session.messages.findIndex((m) =>
      m.parts.some((p) => p.type === "context_new_task"),
    );
    const coveredIndex = session.messages.findIndex((m) => m.id === part.coveredThroughMessageId);
    assert.ok(coveredIndex > boundaryIndex, "coverage cursor stays inside the live window");
  });
});
