import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { describe, it } from "node:test";
import { DebugSession } from "./dapSession.js";

const adapter = process.env.LARRY_LLDB_DAP_E2E;
const target = process.env.LARRY_LLDB_TARGET_E2E;
const skip =
  process.platform !== "win32" ||
  !adapter ||
  !target ||
  !existsSync(adapter) ||
  !existsSync(target);

describe("Larry custom lldb-dap", { skip }, () => {
  it("accepts the PDB allowlist, reports symbols, and detaches without killing", async () => {
    if (!adapter || !target) throw new Error("E2E paths are required");
    const processHandle = spawn(target, [], {
      cwd: process.cwd(),
      stdio: "ignore",
      windowsHide: true,
    });
    try {
      assert.ok(processHandle.pid);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const session = await DebugSession.launch({
        adapterPath: adapter,
        program: target,
        attachPid: processHandle.pid,
        breakpoints: [],
        waitForStop: false,
        pdbModuleAllowlist: [basename(target).toUpperCase()],
      });
      const body = await session.client.request<{
        modules?: Array<{
          name?: string;
          path?: string;
          symbolStatus?: string;
          symbolFilePath?: string;
        }>;
      }>("modules", {});
      const module = body.modules?.find(
        (item) =>
          (item.path ?? item.name ?? "").toLowerCase().endsWith(
            basename(target).toLowerCase(),
          ),
      );
      assert.ok(module, `target module missing: ${JSON.stringify(body.modules)}`);
      assert.match(module.symbolStatus ?? "", /loaded/i);
      assert.match(module.symbolFilePath ?? "", /\.pdb$/i);

      await session.detachKeepAlive();
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(processHandle.exitCode, null, "detach killed the debuggee");
    } finally {
      if (processHandle.exitCode === null) processHandle.kill();
    }
  });

  it("keeps a denied module visible without loading its PDB", async () => {
    if (!adapter || !target) throw new Error("E2E paths are required");
    const processHandle = spawn(target, [], {
      cwd: process.cwd(),
      stdio: "ignore",
      windowsHide: true,
    });
    try {
      assert.ok(processHandle.pid);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const session = await DebugSession.launch({
        adapterPath: adapter,
        program: target,
        attachPid: processHandle.pid,
        breakpoints: [],
        waitForStop: false,
        pdbModuleAllowlist: ["Other.dll"],
      });
      const body = await session.client.request<{
        modules?: Array<{ name?: string; path?: string; symbolStatus?: string }>;
      }>("modules", {});
      const module = body.modules?.find(
        (item) =>
          (item.path ?? item.name ?? "").toLowerCase().endsWith(
            basename(target).toLowerCase(),
          ),
      );
      assert.ok(module, "denied target module must remain visible");
      assert.match(module.symbolStatus ?? "", /skipped.*pdbModuleAllowlist/i);
      await session.detachKeepAlive();
    } finally {
      if (processHandle.exitCode === null) processHandle.kill();
    }
  });
});
