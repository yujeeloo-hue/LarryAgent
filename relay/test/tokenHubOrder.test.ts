import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { createSessionToken } from "../src/auth.ts";
import { createTokenHubEndpoints } from "../src/tokenHubEndpoints.ts";
import {
  TokenHubOrderConflictError,
  TokenHubStore,
  type TokenHubProviderInput,
  type TokenHubSnapshot,
} from "../src/tokenHubStore.ts";

function provider(index: number): TokenHubProviderInput {
  return {
    name: `Provider ${index}`,
    modelId: `model-${index}`,
    baseUrl: "https://order-test.example/v1",
    apiKey: `sk-order-test-${index}`,
    supportsMultimodal: false,
    multimodalSource: "manual",
  };
}

const ids = (snapshot: TokenHubSnapshot): string[] => snapshot.providers.map((item) => item.id);

function readRows(store: TokenHubStore, table: "provider" | "provider_order"): unknown[] {
  const db = new DatabaseSync(store.dbPath, { readOnly: true });
  try {
    return db.prepare(table === "provider"
      ? "SELECT * FROM provider ORDER BY id"
      : "SELECT * FROM provider_order ORDER BY sort_index").all();
  } finally {
    db.close();
  }
}

describe("token hub provider order", () => {
  it("keeps legacy order until sorted, persists after reopening, and never rewrites provider secrets", () => {
    const dir = mkdtempSync(join(tmpdir(), "token-hub-order-"));
    let store = new TokenHubStore(dir);
    try {
      const initial = store.addProviders([provider(1), provider(2), provider(3)]);
      const legacyIds = ids(initial);
      const before = readRows(store, "provider");
      assert.deepEqual(readRows(store, "provider_order"), []);
      const legacyDb = new DatabaseSync(store.dbPath);
      legacyDb.exec("DROP TABLE provider_order");
      legacyDb.close();
      store.close();
      store = new TokenHubStore(dir);
      assert.deepEqual(ids(store.snapshot()), legacyIds, "adding metadata to an old database keeps the old order");
      store.assignProvider("device-1", legacyIds[0]!);
      const links = store.snapshot().deviceProviderIds;
      const desired = [...legacyIds].reverse();
      const sorted = store.reorderProviders(desired);
      assert.deepEqual(ids(sorted), desired);
      assert.deepEqual(sorted.deviceProviderIds, links);
      assert.deepEqual(readRows(store, "provider"), before, "ciphertext, nonce, timestamps and fields remain byte-for-byte unchanged");
      store.close();
      store = new TokenHubStore(dir);
      assert.deepEqual(ids(store.snapshot()), desired);
      assert.deepEqual(store.snapshot().deviceProviderIds, links);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects malformed, duplicate, missing and unknown IDs without partial writes", () => {
    const dir = mkdtempSync(join(tmpdir(), "token-hub-order-"));
    const store = new TokenHubStore(dir);
    try {
      const order = ids(store.addProviders([provider(1), provider(2), provider(3)])).reverse();
      const before = store.reorderProviders(order);
      const ranks = readRows(store, "provider_order");
      for (const invalid of [[order[0]!, order[0]!, order[2]!], ["", ...order], [7, ...order], null]) {
        assert.throws(() => store.reorderProviders(invalid as unknown as string[]), /Provider order/);
        assert.deepEqual(store.snapshot(), before);
        assert.deepEqual(readRows(store, "provider_order"), ranks);
      }
      for (const stale of [[], order.slice(1), [order[0]!, order[1]!, "unknown"], [...order, "unknown"]]) {
        assert.throws(() => store.reorderProviders(stale), TokenHubOrderConflictError);
        assert.deepEqual(store.snapshot(), before);
        assert.deepEqual(readRows(store, "provider_order"), ranks);
      }
      const db = new DatabaseSync(store.dbPath);
      db.exec(`CREATE TRIGGER reject_order_insert BEFORE INSERT ON provider_order
        WHEN NEW.sort_index = 1 BEGIN SELECT RAISE(ABORT, 'injected ordering failure'); END`);
      try {
        assert.throws(() => store.reorderProviders([...order].reverse()), /injected ordering failure/);
        assert.deepEqual(store.snapshot(), before, "a mid-insert failure rolls back the DELETE and earlier INSERT");
        assert.deepEqual(readRows(store, "provider_order"), ranks);
      } finally {
        db.exec("DROP TRIGGER reject_order_insert");
        db.close();
      }
      assert.deepEqual(ids(store.reorderProviders(order)), order, "the failed transaction releases its lock");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("appends new and pulled providers, preserves updated positions, and removes deleted ranks", () => {
    const dir = mkdtempSync(join(tmpdir(), "token-hub-order-"));
    const store = new TokenHubStore(dir);
    try {
      const order = ids(store.addProviders([provider(1), provider(2), provider(3)])).reverse();
      store.reorderProviders(order);
      const added = store.addProviders([provider(4)]);
      assert.deepEqual(ids(added).slice(0, 3), order);
      const pulled = store.upsertByMatch(provider(5));
      assert.equal(pulled.action, "added");
      assert.deepEqual(ids(pulled.snapshot).slice(0, 3), order);
      const beforeUpdates = ids(store.snapshot());
      assert.deepEqual(ids(store.renameProvider(order[0]!, "Renamed")), beforeUpdates);
      const existing = store.getTransfer(order[1]!);
      assert.equal(store.upsertByMatch({ ...existing, multimodalSource: "manual" }).action, "overwritten");
      assert.deepEqual(ids(store.snapshot()), beforeUpdates);
      store.assignProvider("device-1", order[1]!);
      const afterDelete = store.removeProvider(order[1]!);
      assert.deepEqual(ids(afterDelete), beforeUpdates.filter((id) => id !== order[1]));
      assert.deepEqual(afterDelete.deviceProviderIds["device-1"] ?? [], []);
      assert.equal((readRows(store, "provider_order") as Array<{ provider_id: string }>)
        .some((rank) => rank.provider_id === order[1]), false);
      const next = ids(afterDelete).reverse();
      assert.deepEqual(ids(store.reorderProviders(next)), next);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps duplicate matching precedence independent from the displayed order", () => {
    const dir = mkdtempSync(join(tmpdir(), "token-hub-order-"));
    const store = new TokenHubStore(dir);
    try {
      const initial = store.addProviders([provider(1), { ...provider(1), name: "Duplicate", apiKey: "sk-other" }]);
      const originalMatch = initial.providers[0]!;
      const peer = initial.providers[1]!;
      const peerTransfer = store.getTransfer(peer.id);
      const desired = ids(initial).reverse();
      store.reorderProviders(desired);
      const updated = store.upsertByMatch({ ...provider(1), name: "Pulled update" });
      assert.equal(updated.providerId, originalMatch.id);
      assert.deepEqual(ids(updated.snapshot), desired);
      assert.deepEqual(store.getTransfer(peer.id), peerTransfer);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("checks current membership from another connection and supports empty or more than 32 providers", () => {
    const dir = mkdtempSync(join(tmpdir(), "token-hub-order-"));
    const store = new TokenHubStore(dir);
    const other = new TokenHubStore(dir);
    try {
      assert.deepEqual(ids(store.reorderProviders([])), []);
      const initial = store.addProviders(Array.from({ length: 32 }, (_, i) => provider(i)));
      const stale = ids(initial).reverse();
      store.reorderProviders(stale);
      other.addProviders([provider(32)]);
      const current = store.snapshot();
      assert.throws(() => store.reorderProviders(stale), TokenHubOrderConflictError);
      assert.deepEqual(store.snapshot(), current);
      const desired = ids(current).reverse();
      assert.equal(desired.length, 33);
      assert.deepEqual(ids(store.reorderProviders(desired)), desired);
      other.removeProvider(desired[0]!);
      const afterDelete = store.snapshot();
      assert.throws(() => store.reorderProviders(desired), TokenHubOrderConflictError);
      assert.deepEqual(store.snapshot(), afterDelete);
    } finally {
      other.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("token hub reorder HTTP", () => {
  it("requires a session, returns ordered snapshots, and reports stale membership as 409", async () => {
    const dir = mkdtempSync(join(tmpdir(), "token-hub-order-http-"));
    const store = new TokenHubStore(dir);
    const initial = store.addProviders([provider(1), provider(2)]);
    const audits: string[] = [];
    const endpoints = createTokenHubEndpoints({ tokenHub: store, onAudit: (_actor, action) => audits.push(action) });
    const server = createServer((req, res) => {
      void endpoints.handle(new URL(req.url ?? "/", "http://localhost").pathname, req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/api/console/token-hub`;
    const headers = { "content-type": "application/json", "x-auth-token": createSessionToken("tester").token };
    const post = (body: unknown) => fetch(`${base}/providers/reorder`, { method: "POST", headers, body: JSON.stringify(body) });
    try {
      const unauthorized = await fetch(`${base}/providers/reorder`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ providerIds: ids(initial) }),
      });
      assert.equal(unauthorized.status, 401);
      for (const providerIds of [null, "bad", [7], [" "], [initial.providers[0]!.id, initial.providers[0]!.id]]) {
        assert.equal((await post({ providerIds })).status, 400);
        assert.deepEqual(store.snapshot(), initial);
      }
      const desired = ids(initial).reverse();
      const response = await post({ providerIds: desired });
      assert.equal(response.status, 200);
      const ordered = await response.json() as TokenHubSnapshot;
      assert.deepEqual(ids(ordered), desired);
      assert.equal(JSON.stringify(ordered).includes("sk-order-test"), false);
      assert.deepEqual(ids(await (await fetch(base, { headers })).json() as TokenHubSnapshot), desired);
      assert.deepEqual(audits, ["tokenHubReorder"]);
      const expanded = store.addProviders([provider(3)]);
      const conflict = await post({ providerIds: desired });
      assert.equal(conflict.status, 409);
      const error = await conflict.json() as { error: string; detail: string };
      assert.equal(error.error, "provider_order_conflict");
      assert.match(error.detail, /Refresh the list/);
      assert.deepEqual(store.snapshot(), expanded);
      assert.deepEqual(audits, ["tokenHubReorder"]);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
