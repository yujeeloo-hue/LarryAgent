import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { listGameEditorShlibs } from "../unreal/gameModules.js";
import { DebugSession } from "./dapSession.js";

const adapter = process.env.LARRY_UNREAL_LLDB_DAP_E2E;
const projectRoot = process.env.LARRY_UNREAL_PROJECT_E2E;
const editor = process.env.LARRY_UNREAL_EDITOR_E2E;
const pid = Number(process.env.LARRY_UNREAL_PID_E2E);
const skip =
  process.platform !== "win32" ||
  !adapter ||
  !projectRoot ||
  !editor ||
  !Number.isInteger(pid) ||
  pid <= 0 ||
  !existsSync(adapter) ||
  !existsSync(projectRoot) ||
  !existsSync(editor);

function processStats(processId: number): {
  responding: boolean;
  workingSet: number;
  privateBytes: number;
} {
  const script =
    `$p=Get-Process -Id ${processId};` +
    `[pscustomobject]@{responding=$p.Responding;workingSet=$p.WorkingSet64;` +
    `privateBytes=$p.PrivateMemorySize64}|ConvertTo-Json -Compress`;
  return JSON.parse(
    execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    }),
  ) as { responding: boolean; workingSet: number; privateBytes: number };
}

describe("NF Unreal custom lldb-dap", { skip }, () => {
  it("stays responsive, filters Engine PDBs, resolves game symbols, and detaches", async () => {
    if (!adapter || !projectRoot || !editor) {
      throw new Error("NF Unreal E2E environment is incomplete");
    }
    const allowlist = listGameEditorShlibs(projectRoot);
    assert.ok(allowlist.length > 0, "no game Editor DLLs found");
    const before = processStats(pid);
    assert.equal(before.responding, true);

    const session = await DebugSession.launch({
      adapterPath: adapter,
      program: editor,
      attachPid: pid,
      breakpoints: [],
      waitForStop: false,
      shlibs: allowlist,
      pdbModuleAllowlist: allowlist,
    });
    try {
      const modules = await session.client.request<{
        modules?: Array<{
          name?: string;
          path?: string;
          symbolStatus?: string;
          symbolFilePath?: string;
        }>;
      }>("modules", {});
      const all = modules.modules ?? [];
      const game = all.find((item) =>
        allowlist.some((name) =>
          (item.path ?? item.name ?? "").toLowerCase().endsWith(name.toLowerCase()),
        ),
      );
      assert.ok(game, "allowlisted game module missing");
      assert.match(game.symbolStatus ?? "", /loaded/i);
      assert.match(game.symbolFilePath ?? "", /\.pdb$/i);

      const engineModule = all.find((item) =>
        /UnrealEditor-(Core|Engine)\.dll$/i.test(item.path ?? item.name ?? ""),
      );
      assert.ok(engineModule, "Engine module missing");
      assert.match(
        engineModule.symbolStatus ?? "",
        /skipped.*pdbModuleAllowlist/i,
      );

      const source = join(
        projectRoot,
        "Source",
        "NF",
        "GameManager",
        "Loading",
        "NFLoadingManager.cpp",
      );
      await session.replaceBreakpoints(source, [{ line: 299 }]);
      const breakpoints = await session.client.request<{ result?: string }>(
        "evaluate",
        { expression: "breakpoint list", context: "repl" },
        180_000,
      );
      assert.match(breakpoints.result ?? "", /NFLoadingManager\.cpp/i);
      assert.match(breakpoints.result ?? "", /locations\s*=\s*1.*resolved\s*=\s*1/i);

      const adapterStats = processStats(session.adapterPid ?? 0);
      assert.ok(
        adapterStats.privateBytes < 8 * 1024 ** 3,
        `lldb-dap private memory is ${adapterStats.privateBytes}`,
      );
      const attached = processStats(pid);
      assert.equal(attached.responding, true);

      const stopped = session.client.waitForEvent("stopped", { timeoutMs: 20_000 });
      // lldb-dap does not serve `threads` while running; threadId 0 pauses all.
      await session.client.request("pause", { threadId: 0 });
      await stopped;
      const stack = await session.stack();
      assert.ok(stack.length > 0);
      await session.locals();
    } finally {
      await session.detachKeepAlive();
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(processStats(pid).responding, true);
  });
});
