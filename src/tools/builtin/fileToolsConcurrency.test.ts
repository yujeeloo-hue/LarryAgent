import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import type { ToolExecuteContext } from "../types.js";
import {
  fileLockToken,
  releaseStreamingReservation,
  reserveStreamingWrite,
  resetFileLocksForTests,
  setFileLockTimeoutsForTests,
  sweepTurnFileLocks,
} from "../fileLock.js";
import { ToolReturnCode } from "../../session/returnCodes.js";
import { writeFileHandler } from "./writeFile.js";
import { patchHandler } from "./patch.js";
import { readFileHandler } from "./readFile.js";

let TMP = "";

before(() => {
  TMP = mkdtempSync(join(tmpdir(), "jb-filelock-"));
});

after(() => {
  rmSync(TMP, { recursive: true, force: true });
});

beforeEach(() => {
  resetFileLocksForTests();
  setFileLockTimeoutsForTests({});
});

function ctx(overrides?: {
  sessionId?: string;
  toolCallId?: string;
}): ToolExecuteContext {
  return {
    workspacePath: TMP,
    fullPermissionsEnabled: true,
    sessionId: overrides?.sessionId ?? "test-session",
    ...(overrides?.toolCallId ? { toolCallId: overrides.toolCallId } : {}),
  };
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

function read(path: string): string {
  return readFileSync(path, "utf8");
}

describe("concurrent file tools — per-path serialization", () => {
  it("two concurrent write_file calls both land intact (no interleaving)", async () => {
    const p = join(TMP, "w2.txt");
    const [r1, r2] = await Promise.all([
      writeFileHandler({ path: p, content: "AAA" }, ctx({ toolCallId: "tc-1" })),
      writeFileHandler({ path: p, content: "BBB" }, ctx({ toolCallId: "tc-2" })),
    ]);
    assert.equal(r1.returnCode, ToolReturnCode.Success);
    assert.equal(r2.returnCode, ToolReturnCode.Success);
    assert.ok(["AAA", "BBB"].includes(read(p)));
  });

  it("read_file waits for the in-flight write and sees post-write content", async () => {
    const p = join(TMP, "wr.txt");
    writeFileSync(p, "old");
    // Simulate the streaming phase (tool_call_delta reservation) first: the
    // reader queues behind the reservation until the adopted write lands.
    const token = fileLockToken("test-session", "tc-w");
    reserveStreamingWrite(p, token);
    let readDone = false;
    const readP = (async () => {
      const r = await readFileHandler({ path: p }, ctx());
      readDone = true;
      return r;
    })();
    await tick(30);
    assert.equal(readDone, false, "read must wait while the write streams/executes");
    const writeP = writeFileHandler(
      { path: p, content: "new-content" },
      ctx({ toolCallId: "tc-w" }),
    );
    const [wr, rr] = await Promise.all([writeP, readP]);
    assert.equal(wr.returnCode, ToolReturnCode.Success);
    assert.equal(rr.returnCode, ToolReturnCode.Success);
    const text = rr.content[0]?.type === "text" ? rr.content[0].text : "";
    assert.equal(text, "new-content");
  });

  it("two concurrent patch calls with disjoint edits both apply (no lost update)", async () => {
    const p = join(TMP, "p2.txt");
    writeFileSync(p, "line1\nline2\nline3\n");
    const [r1, r2] = await Promise.all([
      patchHandler(
        { path: p, old_string: "line2", new_string: "PATCHED2" },
        ctx({ toolCallId: "tc-a" }),
      ),
      patchHandler(
        { path: p, old_string: "line3", new_string: "PATCHED3" },
        ctx({ toolCallId: "tc-b" }),
      ),
    ]);
    assert.equal(r1.returnCode, ToolReturnCode.Success);
    assert.equal(r2.returnCode, ToolReturnCode.Success);
    const final = read(p);
    assert.equal(final, "line1\nPATCHED2\nPATCHED3\n");
  });

  it("read_file queued behind a patch sees the patched content", async () => {
    const p = join(TMP, "pr.txt");
    writeFileSync(p, "alpha\nbeta\ngamma\n");
    reserveStreamingWrite(p, fileLockToken("test-session", "tc-p"));
    let readDone = false;
    const readP = (async () => {
      const r = await readFileHandler({ path: p }, ctx({ toolCallId: "tc-r" }));
      readDone = true;
      return r;
    })();
    await tick(30);
    assert.equal(readDone, false, "read must wait behind the patch reservation");
    const writeP = patchHandler(
      { path: p, old_string: "beta", new_string: "BETA" },
      ctx({ toolCallId: "tc-p" }),
    );
    const [pr, rr] = await Promise.all([writeP, readP]);
    assert.equal(pr.returnCode, ToolReturnCode.Success);
    assert.equal(rr.returnCode, ToolReturnCode.Success);
    assert.equal(readDone, true);
    const text = rr.content[0]?.type === "text" ? rr.content[0].text : "";
    assert.equal(text, "alpha\nBETA\ngamma\n");
  });

  it("read timeout returns an explicit retryable failure while a write holds the file", async () => {
    setFileLockTimeoutsForTests({ readMs: 80 });
    const p = join(TMP, "busy.txt");
    writeFileSync(p, "stale");
    reserveStreamingWrite(p, fileLockToken("test-session", "tc-z"));
    const r = await readFileHandler({ path: p }, ctx());
    assert.equal(r.returnCode, ToolReturnCode.GenericFailure);
    const text = r.content[0]?.type === "text" ? r.content[0].text : "";
    assert.match(text, /is being written/);
    assert.match(text, /Retry/);
  });
});

describe("lifecycle", () => {
  it("Stop force sweep frees a path held by an in-flight write", async () => {
    const p = join(TMP, "stop.txt");
    writeFileSync(p, "before");
    const { withFileLock } = await import("../fileLock.js");
    // Session-prefixed adopted holder (streaming reservation → adopt), so a
    // turn force sweep actually owns and releases it.
    const token = fileLockToken("test-session", "tc-stop");
    reserveStreamingWrite(p, token);
    const inFlight = withFileLock(p, "write", { adoptToken: token }, async () => {
      await tick(120);
      writeFileSync(p, "after"); // may still land post-sweep — accepted
    });
    await tick(20);
    sweepTurnFileLocks("test-session", { force: true }); // Stop
    // Path must be immediately usable by another flow.
    const r = await readFileHandler(
      { path: p },
      ctx({ toolCallId: "tc-read" }),
    );
    assert.equal(r.returnCode, ToolReturnCode.Success);
    await inFlight; // orphaned holder completes; its finally is a no-op
    assert.equal(read(p), "after");
  });

  it("aborting a queued read returns Cancelled and leaves the path usable", async () => {
    const p = join(TMP, "abort-read.txt");
    writeFileSync(p, "x");
    const token = fileLockToken("test-session", "tc-hold");
    reserveStreamingWrite(p, token);
    const ac = new AbortController();
    const queued = readFileHandler(
      { path: p },
      { ...ctx({ toolCallId: "tc-q" }), signal: ac.signal },
    );
    await tick(20);
    ac.abort(); // user cancels the queued read
    const rr = await queued;
    assert.equal(rr.returnCode, ToolReturnCode.Cancelled);
    releaseStreamingReservation(p, token);
    const after = await readFileHandler({ path: p }, ctx({ toolCallId: "tc-q2" }));
    assert.equal(after.returnCode, ToolReturnCode.Success);
  });

  it("permission-denied write (outside workspace, no bypass) leaves no reservation", async () => {
    const outside = "/tmp/jb-outside-test.txt";
    const r = await writeFileHandler(
      { path: outside, content: "x" },
      {
        workspacePath: TMP,
        fullPermissionsEnabled: false,
        sessionId: "test-session",
        toolCallId: "tc-out",
      },
    );
    assert.equal(r.returnCode, ToolReturnCode.PermissionDenied);
    // No lock entries leaked for this path.
    const { fileLockEntryCountForTests } = await import("../fileLock.js");
    assert.equal(fileLockEntryCountForTests(), 0);
  });
});
