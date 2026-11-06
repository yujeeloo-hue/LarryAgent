import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { openSessionDb, type SessionDatabase } from "./openDb.js";
import { upsertSession } from "./sessionRepository.js";
import {
  loadMessagesBeforeFromDb,
  loadSessionTailWindowFromDb,
} from "./messageWindowDb.js";
import {
  sliceSessionTailWindow,
  sliceSessionWindowBefore,
} from "../messageWindow.js";
import type { Message, Session } from "../types.js";

function makeDb(): SessionDatabase {
  const dir = mkdtempSync(join(tmpdir(), "jellybot-window-"));
  return openSessionDb(dir);
}

function makeSession(id: string, messages: Message[]): Session {
  const now = Date.now();
  return {
    id,
    type: "agent",
    title: `Session ${id}`,
    createdAt: now,
    updatedAt: now,
    status: "idle",
    progressText: "",
    messages,
    model: "test-model",
    providerId: "default",
    workspaceId: "ws-1",
    workspacePath: "/tmp/ws",
    pinned: false,
    archived: false,
    archivedAt: null,
    contextUsage: { usedTokens: 0 },
    plan: null,
  };
}

let seq = 0;
function msg(
  role: Message["role"],
  opts?: { id?: string; steer?: boolean; clear?: boolean; toolCallId?: string },
): Message {
  seq += 1;
  const id = opts?.id ?? `m${seq}`;
  const parts: Message["parts"] = [];
  if (opts?.clear) {
    parts.push({
      type: "context_clear",
      id: `${id}-clear`,
      clearedMessageCount: 0,
    });
  } else if (role === "user" && opts?.steer) {
    parts.push({
      type: "text",
      text: "steer",
      id: "turn-continuation:steer",
    });
  } else if (role !== "system") {
    parts.push({ type: "text", text: `body ${id}` });
  }
  if (role === "tool") {
    return {
      id,
      role,
      parts,
      createdAt: seq,
      toolCallId: opts?.toolCallId ?? `${id}-call`,
    };
  }
  return { id, role, parts, createdAt: seq };
}

function userTurn(n: number): Message[] {
  const callId = `call-${n}`;
  return [
    msg("user", { id: `u${n}` }),
    msg("assistant", { id: `a${n}`, toolCallId: callId }),
    msg("tool", { id: `t${n}`, toolCallId: callId }),
  ];
}

describe("messageWindowDb parity with in-memory slicing", () => {
  function scenarios(): Array<{ name: string; messages: Message[] }> {
    return [
      { name: "empty", messages: [] },
      {
        name: "one turn",
        messages: [...userTurn(1)],
      },
      {
        name: "six turns with steer",
        messages: [
          ...userTurn(1),
          ...userTurn(2),
          ...userTurn(3),
          msg("user", { id: "s1", steer: true }),
          msg("assistant", { id: "sa1" }),
          ...userTurn(4),
          ...userTurn(5),
          ...userTurn(6),
        ],
      },
      {
        name: "clear marker mid-history",
        messages: [
          ...userTurn(1),
          ...userTurn(2),
          msg("system", { id: "clear", clear: true }),
          ...userTurn(3),
          ...userTurn(4),
        ],
      },
      {
        name: "clear marker only",
        messages: [...userTurn(1), msg("system", { id: "clear", clear: true })],
      },
    ];
  }

  for (const scenario of scenarios()) {
    it(`tail windows match: ${scenario.name}`, () => {
      const db = makeDb();
      const session = makeSession("parity-tail", scenario.messages);
      upsertSession(db, session);
      for (const turns of [1, 2, 3, 5, 50]) {
        const fromDb = loadSessionTailWindowFromDb(db, session.id, turns);
        const fromMemory = sliceSessionTailWindow(scenario.messages, turns);
        assert.ok(fromDb);
        assert.deepEqual(fromDb.messages, fromMemory.messages);
        assert.equal(fromDb.hasMore, fromMemory.hasMore);
        assert.equal(fromDb.firstMessageId, fromMemory.firstMessageId);
        assert.equal(fromDb.remainingTurns, fromMemory.remainingTurns);
      }
    });

    it(`paging walk matches: ${scenario.name}`, () => {
      const db = makeDb();
      const session = makeSession("parity-page", scenario.messages);
      upsertSession(db, session);
      for (const pageSize of [1, 2, 5]) {
        const tail = sliceSessionTailWindow(scenario.messages, pageSize);
        let memoryCursor = tail.firstMessageId;
        let dbCursor = loadSessionTailWindowFromDb(
          db,
          session.id,
          pageSize,
        )!.firstMessageId;
        let guard = 0;
        while (memoryCursor && dbCursor) {
          const fromMemory = sliceSessionWindowBefore(
            scenario.messages,
            memoryCursor,
            pageSize,
          );
          const fromDb = loadMessagesBeforeFromDb(
            db,
            session.id,
            dbCursor,
            pageSize,
          );
          assert.ok(fromMemory);
          assert.ok(fromDb);
          assert.deepEqual(fromDb.messages, fromMemory.messages);
          assert.equal(fromDb.hasMore, fromMemory.hasMore);
          assert.equal(fromDb.firstMessageId, fromMemory.firstMessageId);
          assert.equal(fromDb.remainingTurns, fromMemory.remainingTurns);
          memoryCursor = fromMemory.hasMore ? fromMemory.firstMessageId : null;
          dbCursor = fromDb.hasMore ? fromDb.firstMessageId : null;
          guard += 1;
          assert.ok(guard < 30, "paging must terminate");
        }
        assert.equal(memoryCursor, null);
        assert.equal(dbCursor, null);
      }
    });
  }

  it("unknown cursor returns null", () => {
    const db = makeDb();
    const session = makeSession("parity-null", [...userTurn(1), ...userTurn(2)]);
    upsertSession(db, session);
    assert.equal(loadMessagesBeforeFromDb(db, session.id, "nope", 2), null);
  });

  it("unknown session yields empty tail (not null) — parity with live path", () => {
    const db = makeDb();
    const win = loadSessionTailWindowFromDb(db, "missing", 5);
    assert.ok(win);
    assert.deepEqual(win.messages, []);
    assert.equal(win.hasMore, false);
  });
});
