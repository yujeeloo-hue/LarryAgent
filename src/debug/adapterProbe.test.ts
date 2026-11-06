import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  LARRY_LLDB_CAPABILITY,
  LARRY_LLDB_VERSION,
  probeDebugAdapter,
} from "./adapterProbe.js";

const compatible = {
  version: LARRY_LLDB_VERSION,
  capabilities: [LARRY_LLDB_CAPABILITY],
};

describe("probeDebugAdapter", () => {
  it("uses a compatible user-selected adapter", () => {
    const path = join(tmpdir(), "selected", "lldb-dap.exe");
    const res = probeDebugAdapter({
      configuredPath: path,
      pathExists: (p) => p === path,
      readVersion: () => compatible,
    });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.source, "configured");
      assert.equal(res.path, path);
    }
  });

  it("uses the bundled adapter when nothing is configured", () => {
    const bundled = join(tmpdir(), "bundled", "lldb-dap.exe");
    const res = probeDebugAdapter({
      bundledPath: bundled,
      pathExists: (p) => p === bundled,
      readVersion: () => compatible,
    });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.source, "bundled");
      assert.equal(res.path, bundled);
    }
  });

  it("prefers a compatible user-selected adapter over the bundle", () => {
    const configured = join(tmpdir(), "selected", "lldb-dap.exe");
    const bundled = join(tmpdir(), "bundled", "lldb-dap.exe");
    const res = probeDebugAdapter({
      configuredPath: configured,
      bundledPath: bundled,
      pathExists: (p) => p === configured || p === bundled,
      readVersion: () => compatible,
    });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.source, "configured");
      assert.equal(res.path, configured);
    }
  });

  it("falls back to the bundle when the selected adapter is incompatible", () => {
    const configured = join(tmpdir(), "stock", "lldb-dap.exe");
    const bundled = join(tmpdir(), "bundled", "lldb-dap.exe");
    const res = probeDebugAdapter({
      configuredPath: configured,
      bundledPath: bundled,
      pathExists: (p) => p === configured || p === bundled,
      readVersion: (p) => (p === bundled ? compatible : null),
    });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.source, "bundled");
      assert.equal(res.path, bundled);
    }
  });

  it("rejects a user-selected stock adapter", () => {
    const path = join(tmpdir(), "stock", "lldb-dap.exe");
    const res = probeDebugAdapter({
      configuredPath: path,
      pathExists: (p) => p === path,
      readVersion: () => null,
    });
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.message, /Select the compatible lldb-dap/i);
  });

  it("does not silently use stock LLDB", () => {
    const onPath = join("C:\\LLVM\\bin", "lldb-dap.exe");
    const res = probeDebugAdapter({
      pathExists: (p) => p === onPath,
    });
    assert.equal(res.ok, false);
  });

  it("does not discover OpenDebugAD7 or vsdbg", () => {
    const res = probeDebugAdapter({
      pathExists: (p) =>
        p.endsWith("OpenDebugAD7.exe") || p.endsWith("vsdbg.exe"),
    });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.ok(
      !res.searched.some(
        (p) => p.includes("OpenDebugAD7") || p.includes("vsdbg"),
      ),
    );
  });

  it("asks the user to select an adapter when none is configured", () => {
    const res = probeDebugAdapter({
      pathExists: () => false,
    });
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.message, /Select the compatible lldb-dap/i);
  });
});
