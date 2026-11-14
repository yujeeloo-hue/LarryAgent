import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { openSessionDb, type SessionDatabase } from "./openDb.js";
import {
  loadAllSessions,
  loadSessionMessages,
  loadSessionRows,
  upsertSession,
  upsertSessionRow,
} from "./sessionRepository.js";
import type { Message, Session } from "../types.js";

function makeDb(): SessionDatabase {
  const dir = mkdtempSync(join(tmpdir(), "jellybot-lazy-"));
  return openSessionDb(dir);
}

let seq = 0;
function msg(role: Message["role"], text: string): Message {
  seq += 1;
  const parts: Message["parts"] =
    role === "system" ? [] : [{ type: "text", text }];
  return { id: `m${seq}`, role, parts, createdAt: seq } as Message;
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

describe("lazy session hydration (boot + row-only persist)", () => {
  it("loadSessionRows boots with empty message arrays; loadSessionMessages restores them", () => {
    const db = makeDb();
    const messages = [
      msg("user", "hello"),
      msg("assistant", "hi"),
      msg("user", "bye"),
      msg("assistant", "see you"),
    ];
    upsertSession(db, makeSession("lazy-1", messages));

    const rows = loadSessionRows(db);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0]!.messages, []);
    assert.equal(rows[0]!.title, "Session lazy-1");

    const restored = loadSessionMessages(db, "lazy-1");
    assert.deepEqual(restored, messages);
    // And the full loader still returns everything (legacy path).
    assert.deepEqual(loadAllSessions(db)[0]!.messages, messages);
  });

  it("row-only upsert never wipes messages from a lazily-loaded session", () => {
    const db = makeDb();
    const messages = [msg("user", "keep me"), msg("assistant", "kept")];
    upsertSession(db, makeSession("lazy-2", messages));

    // Simulate the lazy flow: boot row → user pins the session → persist
    // row-only from a session whose in-memory messages array is empty.
    const [row] = loadSessionRows(db);
    assert.ok(row);
    row.pinned = true;
    row.updatedAt = row.updatedAt + 1;
    upsertSessionRow(db, row);

    const restored = loadSessionMessages(db, "lazy-2");
    assert.deepEqual(restored, messages);
    const after = loadAllSessions(db)[0]!;
    assert.equal(after.pinned, true);
    assert.deepEqual(after.messages, messages);
  });

  it("boot convergence pattern: hydrate → seal → full persist keeps messages", () => {
    const db = makeDb();
    const messages = [msg("user", "turn in flight")];
    const session = makeSession("lazy-3", messages);
    session.status = "running";
    upsertSession(db, session);

    // Boot: rows → running ⇒ hydrate from DB ⇒ mutate ⇒ full persist.
    const [row] = loadSessionRows(db);
    assert.ok(row);
    row.messages = loadSessionMessages(db, row.id);
    row.status = "cancelled";
    row.progressText = "Interrupted by app restart";
    row.updatedAt = Date.now();
    upsertSession(db, row);

    const after = loadAllSessions(db)[0]!;
    assert.equal(after.status, "cancelled");
    assert.deepEqual(after.messages, messages);
  });
});
