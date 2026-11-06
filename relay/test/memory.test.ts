/**
 * Memory sync (M1) — cipher envelope, memory store semantics, HTTP
 * endpoints. Design: docs/plans/memory-sync-design.md §3–§6.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../src/memory.ts";
import { RELAY_VERSION } from "../src/hub.ts";
import { createSessionToken } from "../src/auth.ts";
import { startRelay } from "../src/index.ts";
import {
  decryptEntry,
  encryptEntry,
  entryHashOf,
  keyVersionOf,
} from "../src/memoryCipherNode.ts";
import {
  cipherAad,
  isValidCipherEnvelope,
  normalizeEntryText,
  type CipherEnvelope,
} from "../src/memoryCipherCore.ts";

const API_KEY = "jbr_test0000000000000000000000000000";
const PROJECT = "github.com/yujeeloo-hue/JellyBot";

function tempDataDir(): string {
  return mkdtempSync(join(tmpdir(), "relay-memory-test-"));
}

function historyRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: "sess-0001",
    title: "Fix relay deploy",
    workspaceName: "JellyBot",
    summary: "Fixed the relay deploy pipeline and verified health.",
    summarySource: "llm",
    summarizedAt: 1730000000000,
    deletedAt: 1730000000000,
    ...overrides,
  };
}

describe("memory cipher envelope", () => {
  it("round-trips one entry", () => {
    const env = encryptEntry(API_KEY, "worklog", PROJECT, "- [2026-10-08] did the thing");
    assert.ok(isValidCipherEnvelope(env));
    assert.equal(env.entryHash, entryHashOf("- [2026-10-08] did the thing"));
    const plain = decryptEntry(API_KEY, "worklog", PROJECT, env);
    assert.equal(plain, "- [2026-10-08] did the thing");
  });

  it("keyVersion is the sha256 fingerprint prefix", () => {
    const expected = keyVersionOf(API_KEY);
    assert.match(expected, /^[0-9a-f]{8}$/);
    assert.equal(expected, encryptEntry(API_KEY, "style", PROJECT, "x").keyVersion);
    assert.notEqual(expected, keyVersionOf("jbr_other"));
  });

  it("tamper: swapping ciphertexts across entries fails (AAD binds identity)", () => {
    const a = encryptEntry(API_KEY, "worklog", PROJECT, "entry A text");
    const b = encryptEntry(API_KEY, "worklog", PROJECT, "entry B text");
    // Ciphertext of B presented under A's identity:
    const forged: CipherEnvelope = { ...a, cipherText: b.cipherText, nonce: b.nonce };
    assert.throws(() => decryptEntry(API_KEY, "worklog", PROJECT, forged));
  });

  it("tamper: cross-project transplant fails", () => {
    const env = encryptEntry(API_KEY, "worklog", PROJECT, "secret line");
    assert.throws(() => decryptEntry(API_KEY, "worklog", "github.com/other/Repo", env));
  });

  it("wrong key cannot decrypt; doc info separates key streams", () => {
    const env = encryptEntry(API_KEY, "worklog", PROJECT, "line");
    assert.throws(() => decryptEntry("jbr_wrong", "worklog", PROJECT, env));
    assert.throws(() => decryptEntry(API_KEY, "style", PROJECT, env));
  });

  it("normalizeEntryText makes CRLF / trailing-space edits hash identical", () => {
    assert.equal(entryHashOf("a\r\nb  \nc"), entryHashOf("a\nb\nc"));
    assert.notEqual(entryHashOf("a b"), entryHashOf("a  b"));
  });

  it("aad layout is the documented triple", () => {
    assert.equal(cipherAad(PROJECT, "style", "ab".repeat(32)), `${PROJECT}\nstyle\n${"ab".repeat(32)}`);
  });

  it("envelope validation rejects malformed records", () => {
    assert.ok(!isValidCipherEnvelope(null));
    assert.ok(!isValidCipherEnvelope({ entryHash: "zz", nonce: "x", cipherText: "y", keyVersion: "z" }));
    assert.ok(!isValidCipherEnvelope({ entryHash: "a".repeat(64), nonce: "n".repeat(18), cipherText: "c".repeat(8), keyVersion: "nothex!" }));
  });
});

describe("MemoryStore", () => {
  it("pushHistory accepts, dedupes by content, arbitrates by completeness", () => {
    const dir = tempDataDir();
    const store = new MemoryStore(dir);
    try {
      const r1 = store.pushHistory([historyRow()], "devA");
      assert.equal(r1.results[0]!.status, "accepted");
      // Same content → noop.
      const r2 = store.pushHistory([historyRow()], "devA");
      assert.equal(r2.results[0]!.status, "noop");
      // More informative (newer summarizedAt) wins.
      const r3 = store.pushHistory([historyRow({ summarizedAt: 1730000009000, summary: "better summary" })], "devB");
      assert.equal(r3.results[0]!.status, "accepted");
      // Less informative (older) loses even with different content.
      const r4 = store.pushHistory([historyRow({ summarizedAt: 1730000001000, summary: "worse" })], "devC");
      assert.equal(r4.results[0]!.status, "noop");
      const listed = store.listHistory("", 10);
      assert.equal(listed.length, 1);
      assert.equal(listed[0]!.row.summary, "better summary");
      assert.equal(listed[0]!.originDevice, "devA");
      assert.equal(store.status().historyRows, 1);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("doc entries: union dedup, tombstone, revive, change stream", () => {
    const dir = tempDataDir();
    const store = new MemoryStore(dir);
    try {
      const e1 = { ...encryptEntry(API_KEY, "worklog", PROJECT, "- [2026-10-08] entry one"), ts: 1730000000000 };
      const e2 = { ...encryptEntry(API_KEY, "worklog", PROJECT, "- [2026-10-08] entry two"), ts: 1730000001000 };
      const r1 = store.pushDocEntries(PROJECT, "worklog", [e1, e2], [], "devA");
      assert.equal(r1.accepted, 2);
      // Replay → noop.
      const r2 = store.pushDocEntries(PROJECT, "worklog", [e1], [], "devB");
      assert.equal(r2.noop, 1);
      // Tombstone e2.
      const r3 = store.pushDocEntries(PROJECT, "worklog", [], [{ entryHash: e2.entryHash }], "devB");
      assert.equal(r3.tombstoned, 1);
      const rows = store.listDocEntries(PROJECT, "worklog");
      assert.equal(rows.length, 2);
      assert.equal(rows.find((r) => r.entryHash === e2.entryHash)!.deleted, true);
      // Re-adding the same line revives it.
      const r4 = store.pushDocEntries(PROJECT, "worklog", [e2], [], "devA");
      assert.equal(r4.revived, 1);
      assert.equal(store.listDocEntries(PROJECT, "worklog").find((r) => r.entryHash === e2.entryHash)!.deleted, false);
      // Pull stream: upsert + upsert + tombstone + revive, in seq order.
      const pulled = store.pull(0, 100);
      const ops = pulled.changes.map((c) => `${c.entityType}:${c.op}`).join(",");
      assert.match(ops, /doc-entry:upsert,doc-entry:upsert,doc-tombstone:tombstone,doc-entry:revive/);
      assert.equal(pulled.hasMore, false);
      const projects = store.listProjects();
      assert.equal(projects.length, 1);
      assert.equal(projects[0]!.counts.worklog, 2);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("caps squeeze oldest rows and log doc-capped changes", () => {
    const dir = tempDataDir();
    const store = new MemoryStore(dir);
    try {
      const batch = Array.from({ length: 205 }, (_, j) => ({
        ...encryptEntry(API_KEY, "pitfalls", PROJECT, `- pitfall ${j}`),
        ts: 1730000000000 + j,
      }));
      store.pushDocEntries(PROJECT, "pitfalls", batch, [], "devA");
      // 205 pushed over cap 200 → oldest 5 evicted.
      const rows = store.listDocEntries(PROJECT, "pitfalls");
      assert.equal(rows.length, 200);
      assert.ok(!rows.some((r) => (r as { ts: number }).ts === 1730000000000), "oldest evicted");
      const capped = store.pull(0, 1000).changes.filter((c) => c.entityType === "doc-capped");
      assert.equal(capped.length, 5);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pull paginates with since cursor", () => {
    const dir = tempDataDir();
    const store = new MemoryStore(dir);
    try {
      for (let i = 0; i < 6; i++) {
        store.pushHistory([historyRow({ sessionId: `sess-${i}` })], "devA");
      }
      const page1 = store.pull(0, 4);
      assert.equal(page1.changes.length, 4);
      assert.equal(page1.hasMore, true);
      const page2 = store.pull(page1.nextSince, 4);
      assert.equal(page2.changes.length, 2);
      assert.equal(page2.hasMore, false);
      assert.ok(page2.nextSince > page1.nextSince);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reEncryptAll re-keys every readable row, skips the unreadable", () => {
    const dir = tempDataDir();
    const store = new MemoryStore(dir);
    const NEW_KEY = "jbr_new00000000000000000000000000000";
    try {
      const good = encryptEntry(API_KEY, "style", PROJECT, "## Code\n- prefer pure cores");
      store.pushDocEntries(PROJECT, "style", [{ ...good, ts: 1 }], [], "devA");
      // Corrupt row: valid envelope shape, undecryptable payload.
      const bad = { ...encryptEntry(API_KEY, "style", PROJECT, "will be corrupted"), ts: 2 };
      bad.cipherText = Buffer.from("garbage-that-is-not-aes-gcm").toString("base64");
      store.pushDocEntries(PROJECT, "style", [bad], [], "devA");
      const stats = store.reEncryptAll(
        API_KEY,
        NEW_KEY,
        (docId, projectKey, env) => {
          try {
            return decryptEntry(API_KEY, docId, projectKey, env);
          } catch {
            return null;
          }
        },
        (docId, projectKey, plaintext) => encryptEntry(NEW_KEY, docId, projectKey, plaintext),
      );
      assert.equal(stats.reEncrypted, 1);
      assert.equal(stats.skipped, 1);
      const rows = store.listDocEntries(PROJECT, "style");
      const reKeyed = rows.find((r) => r.keyVersion === keyVersionOf(NEW_KEY));
      assert.ok(reKeyed, "good row re-keyed");
      assert.equal(decryptEntry(NEW_KEY, "style", PROJECT, reKeyed as unknown as CipherEnvelope), "## Code\n- prefer pure cores");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("memory HTTP endpoints", () => {
  it("auth, push, pull and console overview flow over HTTP", async () => {
    const dataDir = tempDataDir();
    const relay = await startRelay({ port: 0, dataDir });
    try {
      const base = `http://127.0.0.1:${relay.port}`;
      // Anonymous status probe: minimal payload only.
      const anon = await (await fetch(`${base}/api/memory/status`)).json() as Record<string, unknown>;
      assert.equal(anon.sqlite, true);
      assert.equal(anon.version, RELAY_VERSION);
      assert.equal("devices" in anon, false);
      // Wrong key → 401.
      const bad = await fetch(`${base}/api/memory/status`, { headers: { authorization: "Bearer jbr_wrong" } });
      assert.equal(bad.status, 401);
      // Right key: create one via store, full status.
      const keyRec = relay.store.createKey("test-key");
      const full = await (await fetch(`${base}/api/memory/status`, { headers: { authorization: `Bearer ${keyRec.key}` } })).json() as Record<string, unknown>;
      assert.ok(Array.isArray(full.devices));
      // history push without auth → 401; with key → accepted.
      const unauth = await fetch(`${base}/api/memory/history:push`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rows: [historyRow()] }),
      });
      assert.equal(unauth.status, 401);
      const push = await (await fetch(`${base}/api/memory/history:push`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${keyRec.key}` },
        body: JSON.stringify({ rows: [historyRow()], deviceId: "dev-mac" }),
      })).json() as { results: Array<{ status: string }> };
      assert.equal(push.results[0]!.status, "accepted");
      // docs push-entries (encrypted client-side).
      const env = encryptEntry(keyRec.key, "style", PROJECT, "- keep canvas dark");
      const docPush = await (await fetch(`${base}/api/memory/docs:push-entries`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${keyRec.key}` },
        body: JSON.stringify({ projectKey: PROJECT, docId: "style", entries: [{ ...env, ts: 1 }], tombstones: [], deviceId: "dev-mac" }),
      })).json() as { result: { accepted: number } };
      assert.equal(docPush.result.accepted, 1);
      // pull → change stream with payloads.
      const pull = await (await fetch(`${base}/api/memory/pull`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${keyRec.key}` },
        body: JSON.stringify({ since: 0, deviceId: "dev-mac" }),
      })).json() as { changes: Array<{ entityType: string; payload: Record<string, unknown> }> };
      assert.ok(pull.changes.some((c) => c.entityType === "history"));
      const entry = pull.changes.find((c) => c.entityType === "doc-entry");
      assert.ok(entry, "doc-entry change present");
      // Round-trip through the server untouched:
      assert.equal(decryptEntry(keyRec.key, "style", PROJECT, entry!.payload as unknown as CipherEnvelope), "- keep canvas dark");
      // Console overview: session-token guarded.
      const unauthConsole = await fetch(`${base}/api/console/memory/overview`);
      assert.equal(unauthConsole.status, 401);
      const session = createSessionToken("tester");
      const overview = await (await fetch(`${base}/api/console/memory/overview`, { headers: { "x-auth-token": session.token } })).json() as {
        sqlite: boolean; historyRows: number; projects: Array<{ counts: Record<string, number> }>; devices: Array<{ deviceId: string }>;
      };
      assert.equal(overview.sqlite, true);
      assert.equal(overview.historyRows, 1);
      assert.equal(overview.projects[0]!.counts.style, 1);
      assert.ok(overview.devices.some((d) => d.deviceId === "dev-mac"));
      // Audit trail has the pushes.
      const audit = relay.store.recentAudit(10);
      assert.ok(audit.some((a) => a.action === "memoryPush"));
    } finally {
      await relay.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("returns 503 with reason once the store is closed", async () => {
    const dataDir = tempDataDir();
    const relay = await startRelay({ port: 0, dataDir });
    const keyRec = relay.store.createKey("k");
    relay.memory.close();
    try {
      const res = await fetch(`http://127.0.0.1:${relay.port}/api/memory/history:push`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${keyRec.key}` },
        body: JSON.stringify({ rows: [] }),
      });
      assert.equal(res.status, 503);
      const body = await res.json() as { error: string; reason: string | null };
      assert.equal(body.error, "memory_unavailable");
      assert.ok(body.reason);
      // Anonymous status still reports sqlite:false without crashing.
      const probe = await (await fetch(`http://127.0.0.1:${relay.port}/api/memory/status`)).json() as { sqlite: boolean };
      assert.equal(probe.sqlite, false);
    } finally {
      await relay.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
