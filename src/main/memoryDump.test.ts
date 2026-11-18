import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  dumpMemoryGraphs,
  formatDumpStamp,
  formatMemoryDumpLog,
  heapSnapshotSibling,
  withHeapSnapshotExtension,
  type HeapMessageListener,
  type RendererHeapTarget,
} from "./memoryDump.js";

const root = mkdtempSync(join(tmpdir(), "memory-dump-"));

after(() => {
  rmSync(root, { recursive: true, force: true });
});

class FakeDebugger {
  attached: boolean;
  detachCount = 0;
  disableCount = 0;
  private readonly listeners = new Set<HeapMessageListener>();

  constructor(
    private readonly opts: {
      initiallyAttached?: boolean;
      attachError?: string;
      commandError?: string;
      chunks?: string[];
      extraMethod?: string;
    } = {},
  ) {
    this.attached = opts.initiallyAttached === true;
  }

  isAttached(): boolean {
    return this.attached;
  }

  attach(): void {
    if (this.opts.attachError) throw new Error(this.opts.attachError);
    this.attached = true;
  }

  detach(): void {
    this.detachCount += 1;
    this.attached = false;
  }

  on(_event: "message", listener: HeapMessageListener): void {
    this.listeners.add(listener);
  }

  off(_event: "message", listener: HeapMessageListener): void {
    this.listeners.delete(listener);
  }

  async sendCommand(method: string): Promise<void> {
    if (this.opts.commandError) throw new Error(this.opts.commandError);
    if (method === "HeapProfiler.disable") this.disableCount += 1;
    if (method !== "HeapProfiler.takeHeapSnapshot") return;
    for (const listener of this.listeners) {
      if (this.opts.extraMethod) {
        listener({}, this.opts.extraMethod, { chunk: "IGNORE" });
      }
      for (const chunk of this.opts.chunks ?? []) {
        listener({}, "HeapProfiler.addHeapSnapshotChunk", { chunk });
      }
    }
  }
}

function target(
  id: number,
  dbg: FakeDebugger,
  title = "Chat",
): RendererHeapTarget {
  return { id, title, debugger: dbg };
}

function writeMain(filePath: string): void {
  writeFileSync(filePath, "MAIN");
}

describe("heap snapshot paths", () => {
  it("adds the snapshot extension only when the chosen path has none", () => {
    assert.equal(withHeapSnapshotExtension("/tmp/heap"), "/tmp/heap.heapsnapshot");
    assert.equal(
      withHeapSnapshotExtension("/tmp/heap.heapsnapshot"),
      "/tmp/heap.heapsnapshot",
    );
    assert.equal(withHeapSnapshotExtension("/tmp/heap.json"), "/tmp/heap.json");
  });

  it("places a window snapshot beside the chosen file", () => {
    assert.equal(
      heapSnapshotSibling("/tmp/heap.heapsnapshot", "renderer-3"),
      "/tmp/heap-renderer-3.heapsnapshot",
    );
  });

  it("stamps the default file name from local time", () => {
    assert.equal(
      formatDumpStamp(new Date(2026, 10, 17, 21, 44, 5)),
      "20261117-214405",
    );
  });
});

describe("dumpMemoryGraphs", () => {
  it("writes the main snapshot at the chosen path and each window beside it", async () => {
    const filePath = join(root, "chosen.heapsnapshot");
    const windowDbg = new FakeDebugger({ chunks: ['{"nodes":[', "1]}"] });
    const result = await dumpMemoryGraphs({
      filePath,
      renderers: [target(7, windowDbg, "Main  window")],
      writeMainSnapshot: writeMain,
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
    assert.equal(readFileSync(filePath, "utf8"), "MAIN");
    assert.equal(
      readFileSync(join(root, "chosen-renderer-7.heapsnapshot"), "utf8"),
      '{"nodes":[1]}',
    );
    assert.equal(windowDbg.attached, false);
    assert.equal(windowDbg.detachCount, 1);
    assert.equal(windowDbg.disableCount, 1);
    assert.deepEqual(
      result.files.map((file) => file.role),
      ["renderer", "main"],
    );
    assert.match(formatMemoryDumpLog(result), /Saved heap snapshot/);
    assert.match(formatMemoryDumpLog(result), /chosen\.heapsnapshot/);
    assert.doesNotMatch(formatMemoryDumpLog(result), /skipped/);
  });

  it("ignores profiler progress events", async () => {
    const filePath = join(root, "progress.heapsnapshot");
    const windowDbg = new FakeDebugger({
      chunks: ["HEAP"],
      extraMethod: "HeapProfiler.reportHeapSnapshotProgress",
    });
    await dumpMemoryGraphs({
      filePath,
      renderers: [target(1, windowDbg)],
      writeMainSnapshot: writeMain,
    });
    assert.equal(
      readFileSync(join(root, "progress-renderer-1.heapsnapshot"), "utf8"),
      "HEAP",
    );
  });

  it("keeps the main file when a window snapshot fails", async () => {
    const filePath = join(root, "partial.heapsnapshot");
    const blocked = new FakeDebugger({
      attachError: "Debugger is already attached",
    });
    const result = await dumpMemoryGraphs({
      filePath,
      renderers: [target(4, blocked, "Tools\npanel")],
      writeMainSnapshot: writeMain,
    });

    assert.equal(result.ok, true);
    assert.equal(readFileSync(filePath, "utf8"), "MAIN");
    assert.equal(existsSync(join(root, "partial-renderer-4.heapsnapshot")), false);
    assert.equal(blocked.detachCount, 0);
    assert.match(result.errors[0] ?? "", /Window 4 \(Tools panel\)/);
    assert.match(result.errors[0] ?? "", /already attached/);
    assert.match(formatMemoryDumpLog(result), /1 skipped/);
  });

  it("does not detach a debugger it did not attach", async () => {
    const filePath = join(root, "devtools.heapsnapshot");
    const openDevtools = new FakeDebugger({
      initiallyAttached: true,
      commandError: "No debugger is attached",
    });
    const result = await dumpMemoryGraphs({
      filePath,
      renderers: [target(2, openDevtools)],
      writeMainSnapshot: writeMain,
    });

    assert.equal(openDevtools.detachCount, 0);
    assert.equal(openDevtools.attached, true);
    assert.match(result.errors[0] ?? "", /No debugger is attached/);
    assert.equal(readFileSync(filePath, "utf8"), "MAIN");
  });

  it("drops an empty window snapshot and still saves the main file", async () => {
    const filePath = join(root, "empty.heapsnapshot");
    const empty = new FakeDebugger({ chunks: [] });
    const result = await dumpMemoryGraphs({
      filePath,
      renderers: [target(9, empty, "")],
      writeMainSnapshot: writeMain,
    });

    assert.equal(existsSync(join(root, "empty-renderer-9.heapsnapshot")), false);
    assert.match(result.errors[0] ?? "", /Window 9: Heap snapshot was empty/);
    assert.equal(result.files.some((file) => file.role === "main"), true);
    assert.equal(empty.detachCount, 1);
  });

  it("reports failure when every snapshot fails", async () => {
    const filePath = join(root, "none.heapsnapshot");
    const blocked = new FakeDebugger({ attachError: "busy" });
    const result = await dumpMemoryGraphs({
      filePath,
      renderers: [target(1, blocked)],
      writeMainSnapshot: () => {
        throw new Error("disk full");
      },
    });

    assert.equal(result.ok, false);
    assert.equal(existsSync(filePath), false);
    assert.match(formatMemoryDumpLog(result), /Heap snapshot failed/);
    assert.match(formatMemoryDumpLog(result), /disk full/);
  });

  it("removes a main file left behind by a failed write", async () => {
    const filePath = join(root, "torn.heapsnapshot");
    const result = await dumpMemoryGraphs({
      filePath,
      renderers: [],
      writeMainSnapshot: (path) => {
        writeFileSync(path, "");
        throw new Error("torn write");
      },
    });

    assert.equal(result.ok, false);
    assert.equal(existsSync(filePath), false);
    assert.match(result.errors[0] ?? "", /torn write/);
  });
});
