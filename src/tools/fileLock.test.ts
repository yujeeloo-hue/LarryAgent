import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import {
  FileLockTimeoutError,
  extractPartialPath,
  fileLockEntryCountForTests,
  rekeyStreamingReservation,
  releaseStreamingReservation,
  reserveStreamingWrite,
  resetFileLocksForTests,
  setFileLockTimeoutsForTests,
  sweepTurnFileLocks,
  withFileLock,
} from "./fileLock.js";

beforeEach(() => {
  resetFileLocksForTests();
  setFileLockTimeoutsForTests({});
});

afterEach(() => {
  resetFileLocksForTests();
  setFileLockTimeoutsForTests({});
});

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("withFileLock — FIFO serialization", () => {
  it("serializes concurrent writes in arrival order", async () => {
    const order: string[] = [];
    const p1 = withFileLock("/tmp/lock-a", "write", {}, async () => {
      await tick(40);
      order.push("w1");
    });
    const p2 = withFileLock("/tmp/lock-a", "write", {}, async () => {
      order.push("w2");
    });
    await Promise.all([p1, p2]);
    assert.deepEqual(order, ["w1", "w2"]);
    assert.equal(fileLockEntryCountForTests(), 0);
  });

  it("reads wait for the in-flight write to land", async () => {
    const order: string[] = [];
    const p1 = withFileLock("/tmp/lock-b", "write", {}, async () => {
      await tick(40);
      order.push("write");
    });
    const p2 = withFileLock("/tmp/lock-b", "read", {}, async () => {
      order.push("read");
    });
    await Promise.all([p1, p2]);
    assert.deepEqual(order, ["write", "read"]);
  });

  it("case-folds keys on darwin so PATH variants collide", async () => {
    const order: string[] = [];
    const p1 = withFileLock("/tmp/CaseFold.TXT", "write", {}, async () => {
      await tick(30);
      order.push("upper");
    });
    const p2 = withFileLock("/tmp/casefold.txt", "write", {}, async () => {
      order.push("lower");
    });
    await Promise.all([p1, p2]);
    assert.equal(order.length, 2);
    if (process.platform === "darwin") {
      assert.deepEqual(order, ["upper", "lower"]);
    }
  });
});

describe("streaming reservations", () => {
  it("reservation at head blocks readers until adopted write completes", async () => {
    reserveStreamingWrite("/tmp/res-a", "s1:tc1");
    let readDone = false;
    const readP = withFileLock("/tmp/res-a", "read", {}, async () => {
      readDone = true;
    });
    await tick(20);
    assert.equal(readDone, false, "reader must queue behind the reservation");

    const writeP = withFileLock(
      "/tmp/res-a",
      "write",
      { adoptToken: "s1:tc1" },
      async () => {
        await tick(20);
      },
    );
    await Promise.all([readP, writeP]);
    assert.equal(readDone, true);
    assert.equal(fileLockEntryCountForTests(), 0);
  });

  it("adopt keeps the reservation's FIFO position (no late jumper)", async () => {
    // holder → reservation(s1:tc9) → waiting write(s1:tc-late)
    const order: string[] = [];
    const holder = withFileLock("/tmp/res-b", "write", {}, async () => {
      await tick(30);
      order.push("holder");
    });
    reserveStreamingWrite("/tmp/res-b", "s1:tc9");
    let lateStarted = false;
    const lateP = withFileLock("/tmp/res-b", "write", {}, async () => {
      lateStarted = true;
      order.push("late");
    });
    await tick(10); // both queued
    const adoptP = withFileLock(
      "/tmp/res-b",
      "write",
      { adoptToken: "s1:tc9" },
      async () => {
        order.push("adopted");
      },
    );
    await Promise.all([holder, lateP, adoptP]);
    assert.deepEqual(order, ["holder", "adopted", "late"]);
    assert.equal(lateStarted, true);
  });

  it("releaseStreamingReservation unblocks queued readers", async () => {
    reserveStreamingWrite("/tmp/res-c", "s1:tc1");
    let readDone = false;
    const readP = withFileLock("/tmp/res-c", "read", {}, async () => {
      readDone = true;
    });
    await tick(10);
    assert.equal(readDone, false);
    releaseStreamingReservation("/tmp/res-c", "s1:tc1");
    await readP;
    assert.equal(readDone, true);
  });

  it("release by token sweeps other paths too (identity is authoritative)", () => {
    reserveStreamingWrite("/tmp/res-d1", "s1:tcX");
    reserveStreamingWrite("/tmp/res-d2", "s1:tcX");
    releaseStreamingReservation(null, "s1:tcX");
    assert.equal(fileLockEntryCountForTests(), 0);
  });

  it("rekey moves the reservation to the new token in place", async () => {
    reserveStreamingWrite("/tmp/res-e", "s1:pending-0");
    rekeyStreamingReservation("/tmp/res-e", "s1:pending-0", "s1:real-id");
    // Old token can no longer adopt; new token adopts the same slot.
    reserveStreamingWrite("/tmp/res-e", "s1:pending-0"); // new reservation, different token
    assert.equal(fileLockEntryCountForTests(), 2);
    await withFileLock(
      "/tmp/res-e",
      "write",
      { adoptToken: "s1:real-id" },
      async () => {},
    );
    releaseStreamingReservation("/tmp/res-e", "s1:pending-0");
    assert.equal(fileLockEntryCountForTests(), 0);
  });

  it("TTL expires an unadopted reservation and frees the path", async () => {
    reserveStreamingWrite("/tmp/res-f", "s1:tc1", { ttlMs: 60 });
    let readDone = false;
    const readP = withFileLock("/tmp/res-f", "read", {}, async () => {
      readDone = true;
    });
    await tick(10);
    assert.equal(readDone, false);
    await readP; // TTL sweeper (1s interval) releases within ~1.1s
    assert.equal(readDone, true);
    assert.equal(fileLockEntryCountForTests(), 0);
  });

  it("TTL never force-releases an active holder", async () => {
    setFileLockTimeoutsForTests({ ttlMs: 50 });
    let bodyDone = false;
    const holder = withFileLock("/tmp/res-g", "write", {}, async () => {
      await tick(1500); // outlive the TTL deadline
      bodyDone = true;
    });
    await tick(30); // holder active, TTL deadline passes mid-body
    // A concurrent reader must still queue (not steal the lock).
    let readDone = false;
    const readP = withFileLock("/tmp/res-g", "read", {}, async () => {
      readDone = true;
    });
    await tick(100);
    assert.equal(readDone, false, "active holder must not be TTL-released");
    await Promise.all([holder, readP]);
    assert.ok(bodyDone && readDone);
    assert.equal(fileLockEntryCountForTests(), 0);
  });
});

describe("waiting failure modes", () => {
  it("read wait timeout throws FileLockTimeoutError and cleans up", async () => {
    reserveStreamingWrite("/tmp/wait-a", "s1:tc1");
    await assert.rejects(
      withFileLock("/tmp/wait-a", "read", { timeoutMs: 60 }, async () => {}),
      FileLockTimeoutError,
    );
    // The read attempt is gone; the reservation itself remains until released.
    releaseStreamingReservation("/tmp/wait-a", "s1:tc1");
    assert.equal(fileLockEntryCountForTests(), 0);
  });

  it("abort while queued rejects the waiter and releases it", async () => {
    const holder = withFileLock("/tmp/wait-b", "write", {}, async () => {
      await tick(200);
    });
    const ac = new AbortController();
    const queued = withFileLock(
      "/tmp/wait-b",
      "read",
      { signal: ac.signal },
      async () => {
        assert.fail("body must not run");
      },
    );
    await tick(20);
    ac.abort();
    await assert.rejects(queued, /aborted/);
    await holder;
    assert.equal(fileLockEntryCountForTests(), 0);
    // Path is immediately usable again.
    await withFileLock("/tmp/wait-b", "read", { timeoutMs: 500 }, async () => {});
  });
});

describe("sweepTurnFileLocks", () => {
  it("non-force sweep drops only this turn's queued reservations", async () => {
    reserveStreamingWrite("/tmp/sw-a", "sessA:tc1");
    reserveStreamingWrite("/tmp/sw-b", "sessB:tc1"); // other turn
    sweepTurnFileLocks("sessA");
    assert.equal(fileLockEntryCountForTests(), 1); // sessB's survives
    releaseStreamingReservation("/tmp/sw-b", "sessB:tc1");
  });

  it("force sweep releases active holders (Stop semantics) idempotently", async () => {
    let bodyDone = false;
    const holder = withFileLock("/tmp/sw-c", "write", {}, async () => {
      await tick(120);
      bodyDone = true;
    });
    await tick(10);
    sweepTurnFileLocks("session", { force: true }); // token prefix "session:"
    let quick = false;
    await withFileLock("/tmp/sw-c", "read", { timeoutMs: 500 }, async () => {
      quick = true;
    });
    assert.equal(quick, true, "force sweep must free the path immediately");
    await holder; // orphaned holder finishes; its finally is a harmless no-op
    assert.ok(bodyDone);
    assert.equal(fileLockEntryCountForTests(), 0);
  });
});

describe("extractPartialPath", () => {
  it("extracts an absolute path from partial streaming JSON", () => {
    assert.equal(
      extractPartialPath('{"path":"/tmp/x.ts","content":"abc'),
      "/tmp/x.ts",
    );
  });

  it("handles escaped characters and surrounding fields", () => {
    assert.equal(
      extractPartialPath('{"note":"a\\"b","path":"/tmp/sp ace/f.ts","cont'),
      "/tmp/sp ace/f.ts",
    );
  });

  it("returns null for missing / non-absolute / garbage", () => {
    assert.equal(extractPartialPath('{"content":"x'), null);
    assert.equal(extractPartialPath('{"path":"rel/x'), null);
    assert.equal(extractPartialPath('{"path": 42'), null);
    assert.equal(extractPartialPath(""), null);
  });
});
