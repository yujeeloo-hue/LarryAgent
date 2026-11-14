import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createArchiveWorker } from "./worker.js";
import {
  loadSummarizedHistory,
  markHistoryTaskRunning,
  moveSessionToHistory,
  upsertSession,
} from "../db/index.js";
import { openSessionDb } from "../db/openDb.js";
import type { Session } from "../types.js";

type Db = ReturnType<typeof openSessionDb>;

function freshDb(): Db {
  const root = mkdtempSync(join(tmpdir(), "jellybot-archive-worker-"));
  const db = openSessionDb(root);
  db.prepare(
    `INSERT INTO workspaces (id, name, path, created_at, updated_at)
     VALUES ('ws-1', 'Proj', '/tmp/ws', 1, 1)`,
  ).run();
  return db;
}

function seedSession(db: Db, id: string, msgs: unknown[][]): Session {
  const session: Session = {
    id,
    type: "agent",
    title: `T-${id}`,
    createdAt: 1,
    updatedAt: 2,
    status: "idle",
    progressText: "",
    model: "orig",
    providerId: "p",
    workspaceId: "ws-1",
    workspacePath: "/tmp/ws",
    pinned: false,
    archived: false,
    archivedAt: null,
    contextUsage: { usedTokens: 0 },
    plan: null,
    messages: msgs.map(([mid, text], i) => ({
      id: String(mid),
      role: i % 2 === 0 ? "user" : "assistant",
      parts: [{ type: "text", text: String(text) }],
      createdAt: i + 1,
    })) as Session["messages"],
  };
  upsertSession(db, session);
  return session;
}

async function waitFor(
  check: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

function row(db: Db, id: string): Record<string, unknown> {
  return db
    .prepare(`SELECT * FROM session_history WHERE id = ?`)
    .get(id) as Record<string, unknown>;
}

const fakeClient = { baseUrl: "https://x.test", apiKey: "k", model: "wk-model" };

describe("archive worker", () => {
  it("drains tasks serially in deleted_at order and frees payloads", async () => {
    const db = freshDb();
    const a = seedSession(db, "a", [["m1", "alpha relay work"], ["m2", "done"]]);
    const b = seedSession(db, "b", [["m3", "beta task"], ["m4", "done"]]);
    moveSessionToHistory(db, a, { historyId: "h-a", deletedAt: 100 });
    moveSessionToHistory(db, b, { historyId: "h-b", deletedAt: 200 });

    const order: string[] = [];
    const worker = createArchiveWorker({
      db,
      resolveClient: async () => fakeClient,
      getContextLimitTokens: async () => 100_000,
      summarize: async (_c: unknown, req: { meta?: { sessionId?: string } }) => {
        order.push(req.meta?.sessionId ?? "?");
        return { content: `SUMMARY ${req.meta?.sessionId}` };
      },
    });
    worker.start();
    await waitFor(() => String(row(db, "h-b").status) === "done");

    assert.deepEqual(order, ["a", "b"]); // FIFO by deleted_at
    assert.equal(row(db, "h-a").status, "done");
    assert.equal(row(db, "h-a").summary, "SUMMARY a");
    assert.equal(row(db, "h-a").summary_source, "llm");
    assert.equal(row(db, "h-a").summary_model, "wk-model");
    assert.equal(row(db, "h-a").payload, null);
    assert.equal(loadSummarizedHistory(db).length, 2);
    worker.stop();
    db.close();
  });

  it("records empty sessions without calling the LLM", async () => {
    const db = freshDb();
    const empty = seedSession(db, "e", []);
    moveSessionToHistory(db, empty, { historyId: "h-e", deletedAt: 1 });
    let llmCalls = 0;
    const worker = createArchiveWorker({
      db,
      resolveClient: async () => fakeClient,
      getContextLimitTokens: async () => 100_000,
      summarize: (async () => {
        llmCalls += 1;
        return { content: "x" };
      }) as never,
    });
    worker.start();
    await waitFor(() => String(row(db, "h-e").status) === "done");
    assert.equal(llmCalls, 0);
    assert.equal(row(db, "h-e").summary_source, "empty");
    assert.match(String(row(db, "h-e").summary), /T-e/);
    worker.stop();
    db.close();
  });

  it("backs off on failure, then retryNow digests after the provider is fixed", async () => {
    const db = freshDb();
    const s = seedSession(db, "f", [["m1", "will fail first"]]);
    moveSessionToHistory(db, s, { historyId: "h-f", deletedAt: 1 });
    let healthy = false;
    const worker = createArchiveWorker({
      db,
      resolveClient: async () => fakeClient,
      getContextLimitTokens: async () => 100_000,
      summarize: (async (_c: unknown, req: { messages: { content: unknown }[] }) => {
        if (!healthy) throw new Error("provider down");
        return { content: "FIXED SUMMARY" };
      }) as never,
    });
    worker.start();
    await waitFor(() => Number(row(db, "h-f").attempts) === 1);
    const failed = row(db, "h-f");
    assert.equal(failed.status, "pending");
    assert.equal(failed.error, "provider down");
    assert.ok(Number(failed.next_attempt_at) > Date.now() + 20_000);

    // Provider fixed + settings kick: force-retry ignores the backoff.
    db.prepare(
      `UPDATE session_history SET next_attempt_at = ? WHERE id='h-f'`,
    ).run(Date.now() + 3_600_000);
    healthy = true;
    worker.retryNow();
    await waitFor(() => String(row(db, "h-f").status) === "done");
    assert.equal(row(db, "h-f").summary, "FIXED SUMMARY");
    worker.stop();
    db.close();
  });

  it("recovers a task left running by a crash at boot", async () => {
    const db = freshDb();
    const s = seedSession(db, "c", [["m1", "crash recovered"]]);
    moveSessionToHistory(db, s, { historyId: "h-c", deletedAt: 1 });
    markHistoryTaskRunning(db, "h-c"); // simulate crash mid-summarize
    const worker = createArchiveWorker({
      db,
      resolveClient: async () => fakeClient,
      getContextLimitTokens: async () => 100_000,
      summarize: (async () => ({ content: "RESUMED" })) as never,
    });
    worker.start();
    await waitFor(() => String(row(db, "h-c").status) === "done");
    assert.equal(row(db, "h-c").summary, "RESUMED");
    worker.stop();
    db.close();
  });

  it("completes LLM-discarded sessions as search-hidden tombstones", async () => {
    const db = freshDb();
    const trivial = seedSession(db, "d", [["m1", "hi there"], ["m2", "hello!"]]);
    moveSessionToHistory(db, trivial, { historyId: "h-d", deletedAt: 1 });
    const worker = createArchiveWorker({
      db,
      resolveClient: async () => fakeClient,
      getContextLimitTokens: async () => 100_000,
      summarize: (async () => ({ content: "NO_ARCHIVE: small talk only" })) as never,
    });
    worker.start();
    await waitFor(() => String(row(db, "h-d").status) === "done");

    const done = row(db, "h-d");
    assert.equal(done.status, "done"); // terminal success
    assert.equal(done.summary, "small talk only"); // reason kept for audit
    assert.equal(done.summary_source, "discarded");
    assert.equal(done.payload, null); // transcript freed like any done row
    assert.equal(Number(done.attempts), 0); // no retry happened
    // loadSummarizedHistory still exposes it; search filters by source.
    const loaded = loadSummarizedHistory(db);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0]!.summarySource, "discarded");
    worker.stop();
    db.close();
  });

  it("stop() halts the queue", async () => {
    const db = freshDb();
    const s = seedSession(db, "x", [["m1", "never processed"]]);
    moveSessionToHistory(db, s, { historyId: "h-x", deletedAt: 1 });
    const worker = createArchiveWorker({
      db,
      resolveClient: async () => fakeClient,
      getContextLimitTokens: async () => 100_000,
      summarize: (async () => ({ content: "NOPE" })) as never,
    });
    worker.stop();
    worker.kick();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(row(db, "h-x").status, "pending");
    db.close();
  });
});
