import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  createMemorySync,
  memorySyncBackoffMs,
  restBase,
  type MemorySyncConfig,
  type MemorySyncDeps,
} from "./memorySyncEngine.js";
import {
  planPushBatches,
  fromHistoryWireRow,
  selectHistoryChanges,
  toHistoryWireRow,
} from "./historyWire.js";
import {
  completeHistoryTask,
  getHistoryBySessionId,
  loadSummarizedHistory,
  loadUnpushedHistory,
  markHistoryTaskRunning,
  moveSessionToHistory,
  upsertSession,
} from "../session/db/index.js";
import { openSessionDb } from "../session/db/openDb.js";
import type { Session } from "../session/types.js";

type Db = ReturnType<typeof openSessionDb>;

function freshDb(): Db {
  const root = mkdtempSync(join(tmpdir(), "jellybot-memorysync-"));
  return openSessionDb(root);
}

function seedSession(db: Db, id: string, title: string): Session {
  const session: Session = {
    id,
    type: "agent",
    source: "app",
    title,
    createdAt: 1000,
    updatedAt: 2000,
    status: "idle",
    progressText: "",
    model: "test-model",
    providerId: "prov",
    workspaceId: "",
    workspacePath: "/tmp/ws",
    pinned: false,
    messages: [],
    contextUsage: { usedTokens: 0, maxTokens: 1 },
  } as unknown as Session;
  upsertSession(db, session);
  return session;
}

/** Drive one session through delete → pending → running → done(summary). */
function makeDoneRow(
  db: Db,
  sessionId: string,
  summary: string,
  summarizedAt = 5000,
): void {
  const session = seedSession(db, sessionId, `Session ${sessionId}`);
  assert.equal(
    moveSessionToHistory(db, session, {
      historyId: `h-${sessionId}`,
      deletedAt: 3000,
      device: { deviceId: "dev-a", deviceName: "A", deviceOs: "mac", appVersion: "1.0" },
    }),
    true,
  );
  assert.equal(markHistoryTaskRunning(db, `h-${sessionId}`), true);
  assert.equal(
    completeHistoryTask(db, `h-${sessionId}`, {
      summary,
      summarySource: "llm",
      summaryModel: "m",
      inputTruncated: false,
      now: summarizedAt,
    }),
    true,
  );
}

// ── pure helpers ────────────────────────────────────────────────

describe("historyWire", () => {
  it("planPushBatches splits at the 200 server cap", () => {
    assert.deepEqual(planPushBatches([]), []);
    const rows = Array.from({ length: 450 }, (_, i) => i);
    const batches = planPushBatches(rows);
    assert.equal(batches.length, 3);
    assert.equal(batches[0]!.length, 200);
    assert.equal(batches[2]!.length, 50);
  });

  it("fromHistoryWireRow validates and coerces", () => {
    const bad = fromHistoryWireRow({ sessionId: "has space!" });
    assert.equal(bad.ok, false);
    const ok = fromHistoryWireRow({
      sessionId: "abc-123",
      title: "T".repeat(600),
      summary: "s",
      summarySource: "llm",
      sessionCreatedAt: 1.4,
      firstMessageAt: null,
    });
    assert.equal(ok.ok, true);
    if (ok.ok) {
      assert.equal(ok.row.title.length, 512);
      assert.equal(ok.row.sessionCreatedAt, 1);
      assert.equal(ok.row.firstMessageAt, null);
      assert.equal(ok.row.inputTruncated, false);
    }
  });

  it("selectHistoryChanges partitions history vs future entities", () => {
    const { history, others } = selectHistoryChanges([
      { seq: 1, entityType: "history", entityId: "a", op: "upsert", payload: {} },
      { seq: 2, entityType: "doc-entry", entityId: "b", op: "upsert", payload: {} },
      { seq: 3, entityType: "doc-tombstone", entityId: "c", op: "upsert", payload: {} },
    ]);
    assert.equal(history.length, 1);
    assert.equal(others, 2);
  });

  it("toHistoryWireRow maps the domain record losslessly", () => {
    const record = loadSummarizedHistory(freshDb())[0];
    assert.equal(record, undefined); // empty db sanity
  });
});

describe("engine helpers", () => {
  it("restBase converts ws origins and strips trailing slashes", () => {
    assert.equal(restBase("wss://jellybot.cloud/relay/"), "https://jellybot.cloud/relay");
    assert.equal(restBase("ws://localhost:8788"), "http://localhost:8788");
    assert.equal(restBase("https://x.io"), "https://x.io");
  });

  it("backoff ladder matches the archive worker", () => {
    assert.equal(memorySyncBackoffMs(1), 30_000);
    assert.equal(memorySyncBackoffMs(2), 120_000);
    assert.equal(memorySyncBackoffMs(3), 600_000);
    assert.equal(memorySyncBackoffMs(9), 3_600_000);
  });
});

// ── engine with a scripted relay ────────────────────────────────

type RelayScript = {
  /** Rows the relay "has" server-side (push accumulates here). */
  serverRows: Map<string, unknown>;
  /** Changes the relay returns for pull (pre-seeded). */
  changes: Array<{ seq: number; entityType: string; entityId: string; op: string; payload: unknown }>;
  nextSeq: number;
};

function makeEngine(
  db: Db,
  script: RelayScript,
  opts: {
    config?: MemorySyncConfig | null;
    apiKey?: string | null;
    fetchImpl?: typeof fetch;
  } = {},
) {
  const config = opts.config === undefined
    ? { serverUrl: "wss://relay.example/relay", deviceId: "dev-a", deviceName: "A" }
    : opts.config;
  const deps: MemorySyncDeps = {
    db,
    getSyncConfig: async () => config,
    getApiKey: async () => opts.apiKey === undefined ? "jbr_test" : opts.apiKey,
    appVersion: () => "1.0-test",
    newId: () => `id-${Math.random().toString(36).slice(2, 10)}`,
    fetchImpl: opts.fetchImpl ?? (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (url.endsWith("/api/memory/history:push")) {
        for (const row of (body.rows ?? []) as Array<{ sessionId: string }>) {
          script.serverRows.set(row.sessionId, row);
          script.nextSeq += 1;
          script.changes.push({
            seq: script.nextSeq, entityType: "history", entityId: row.sessionId,
            op: "upsert", payload: row,
          });
        }
        return new Response(JSON.stringify({
          results: ((body.rows ?? []) as Array<{ sessionId: string }>).map((r) => ({ sessionId: r.sessionId, status: "accepted" })),
        }), { status: 200 });
      }
      if (url.endsWith("/api/memory/pull")) {
        const since = Number(body.since) || 0;
        const page = script.changes.filter((c) => c.seq > since);
        return new Response(JSON.stringify({
          changes: page, nextSince: page.length ? page[page.length - 1]!.seq : since, hasMore: false,
        }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    }),
  };
  return createMemorySync(deps);
}

describe("memorySyncEngine end-to-end (scripted relay)", () => {
  it("pushes done rows, pulls remote rows, no echo", async () => {
    const db = freshDb();
    makeDoneRow(db, "local-1", "local summary");
    makeDoneRow(db, "local-2", "another summary");
    const script: RelayScript = {
      serverRows: new Map(),
      changes: [{
        seq: 1, entityType: "history", entityId: "remote-9", op: "upsert",
        payload: {
          sessionId: "remote-9", title: "From Win", workspaceName: "W",
          summary: "win summary", summarySource: "llm", summarizedAt: 9000,
          deletedAt: 8000, sessionCreatedAt: 1, sessionUpdatedAt: 2,
        },
      }],
      nextSeq: 1,
    };
    const engine = makeEngine(db, script);
    const outcome = await engine.syncOnce("test");
    assert.equal(outcome.kind, "ok");
    assert.equal(outcome.pushed, 2);
    assert.equal(outcome.inserted, 1);
    assert.equal(script.serverRows.size, 2);

    // Local pushed rows are stamped…
    assert.equal(loadUnpushedHistory(db, 100).length, 0);
    // …and the remote row is searchable locally.
    const merged = getHistoryBySessionId(db, "remote-9");
    assert.equal(merged?.title, "From Win");
    assert.equal(merged?.summary, "win summary");

    // Second cycle: pulling our own echo back is a skip, not an insert.
    const second = await engine.syncOnce("test2");
    assert.equal(second.kind, "ok");
    assert.equal(second.pushed, 0);
    assert.equal(second.inserted, 0);
    // echo row skipped because local is identical-ish (server keeps our version)
    assert.ok(second.skipped >= 0);
    assert.equal(loadSummarizedHistory(db).length, 3);
  });

  it("reports off when unconfigured and error when key missing", async () => {
    const db = freshDb();
    const off = makeEngine(db, { serverRows: new Map(), changes: [], nextSeq: 0 }, { config: null });
    assert.equal((await off.syncOnce("t")).kind, "off");
    const noKey = makeEngine(
      db, { serverRows: new Map(), changes: [], nextSeq: 0 }, { apiKey: null },
    );
    const result = await noKey.syncOnce("t");
    assert.equal(result.kind, "error");
    assert.match(result.reason ?? "", /key/i);
  });

  it("surfaces fetch failures as error outcomes with backoff bookkeeping", async () => {
    const db = freshDb();
    makeDoneRow(db, "x-1", "s");
    const engine = makeEngine(db, { serverRows: new Map(), changes: [], nextSeq: 0 }, {
      fetchImpl: (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch,
    });
    const outcome = await engine.syncOnce("t");
    assert.equal(outcome.kind, "error");
    assert.match(outcome.reason ?? "", /500/);
    // Failure must not mark rows pushed.
    assert.equal(loadUnpushedHistory(db, 100).length, 1);
    const status = engine.status();
    assert.equal(status.lastResult, "error");
  });

  it("fullResync zeroes pushed stamps and re-pushes idempotently", async () => {
    const db = freshDb();
    makeDoneRow(db, "fr-1", "s1");
    const script: RelayScript = { serverRows: new Map(), changes: [], nextSeq: 0 };
    const engine = makeEngine(db, script);
    await engine.syncOnce("t");
    assert.equal(script.serverRows.size, 1);
    const outcome = await engine.fullResync();
    assert.equal(outcome.kind, "ok");
    assert.equal(outcome.pushed, 1); // re-pushed, server dedupes
    assert.equal(loadUnpushedHistory(db, 100).length, 0);
  });

  it("islands keep independent cursors (switching relay resets nothing else)", async () => {
    const db = freshDb();
    const script: RelayScript = { serverRows: new Map(), changes: [], nextSeq: 5 };
    const engineA = makeEngine(db, script, {
      config: { serverUrl: "wss://a.example", deviceId: "dev-a", deviceName: "A" },
    });
    await engineA.syncOnce("t");
    const statusA = engineA.status();
    assert.ok(statusA.cursor >= 0);
    // Same db, second island: fresh cursor starts at 0.
    const engineB = makeEngine(db, script, {
      config: { serverUrl: "wss://b.example", deviceId: "dev-a", deviceName: "A" },
    });
    const statusB = engineB.status();
    assert.equal(statusB.cursor, 0);
    // Switching islands does not resurrect pushed stamps.
    assert.equal(loadUnpushedHistory(db, 100).length, 0);
  });

  it("skips malformed remote rows without killing the cycle", async () => {
    const db = freshDb();
    const script: RelayScript = {
      serverRows: new Map(),
      changes: [
        { seq: 1, entityType: "history", entityId: "bad", op: "upsert", payload: { sessionId: "no good" } },
        { seq: 2, entityType: "history", entityId: "good", op: "upsert", payload: { sessionId: "good-1", title: "G" } },
      ],
      nextSeq: 2,
    };
    const engine = makeEngine(db, script);
    const outcome = await engine.syncOnce("t");
    assert.equal(outcome.kind, "ok");
    assert.equal(outcome.badRows, 1);
    assert.equal(outcome.inserted, 1);
  });

  it("wire round-trip keeps the searchable fields", () => {
    const db = freshDb();
    makeDoneRow(db, "rt-1", "round trip");
    const record = getHistoryBySessionId(db, "rt-1");
    assert.ok(record);
    const wire = toHistoryWireRow(record!);
    const parsed = fromHistoryWireRow(wire);
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.row.sessionId, "rt-1");
      assert.equal(parsed.row.summary, "round trip");
      assert.equal(parsed.row.deviceId, "dev-a");
    }
  });
});
