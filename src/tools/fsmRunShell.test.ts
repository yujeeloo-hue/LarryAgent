/**
 * runFsmShellScript — NodeActionRunShell implementation: source resolution
 * (inline command / script file), cwd + timeout handling, structured errors.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runFsmShellScript } from "./fsmRunShell.js";

// cmd.exe vs /bin/zsh: platform-native commands and line endings.
const IS_WIN = process.platform === "win32";
const NL = IS_WIN ? "\x0d\x0a" : "";

function makeWorkspace(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "jb-fsm-shell-"));
  return {
    root,
    // On Windows the killed cmd tree (taskkill /T fires async) can hold the
    // cwd for a few hundred ms — retry the removal before giving up.
    cleanup: () => {
      for (let i = 0; i < 20; i++) {
        try {
          rmSync(root, { recursive: true, force: true });
          return;
        } catch {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
        }
      }
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // Still locked after 3s (slow conhost teardown) — the OS temp dir
        // cleaner owns it from here; never fail the test on cleanup.
      }
    },
  };
}

describe("runFsmShellScript", () => {
  it("runs an inline command and reports ok with exit 0", async () => {
    const { root, cleanup } = makeWorkspace();
    try {
      const result = await runFsmShellScript(
        { command: IS_WIN ? "echo fsm" : "printf fsm" },
        root,
      );
      assert.equal(result.status, "ok");
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout, `fsm${NL}`);
      assert.equal(result.cwd, root);
      assert.equal(result.command, IS_WIN ? "echo fsm" : "printf fsm");
    } finally {
      cleanup();
    }
  });

  it("reads a workspace-relative script file", async () => {
    const { root, cleanup } = makeWorkspace();
    try {
      writeFileSync(
        join(root, IS_WIN ? "task.cmd" : "task.sh"),
        IS_WIN ? "@echo from-file" : "echo from-file",
        "utf8",
      );
      const result = await runFsmShellScript(
        { scriptPath: IS_WIN ? "task.cmd" : "task.sh" },
        root,
      );
      assert.equal(result.status, "ok");
      assert.equal(result.stdout, `from-file${IS_WIN ? NL : "\x0a"}`);
      assert.equal(
        result.command,
        IS_WIN ? "@echo from-file" : "echo from-file",
      );
    } finally {
      cleanup();
    }
  });

  it("resolves cwd relative to the workspace root", async () => {
    const { root, cleanup } = makeWorkspace();
    try {
      mkdirSync(join(root, "sub"));
      const result = await runFsmShellScript(
        { command: IS_WIN ? "cd" : "pwd", cwd: "sub" },
        root,
      );
      assert.equal(result.status, "ok");
      assert.equal(result.cwd, join(root, "sub"));
    } finally {
      cleanup();
    }
  });

  it("returns a structured error for a missing script file", async () => {
    const { root, cleanup } = makeWorkspace();
    try {
      const result = await runFsmShellScript(
        { scriptPath: "nope.sh" },
        root,
      );
      assert.equal(result.status, "error");
      assert.match(result.errorMessage ?? "", /Cannot read shell script/);
    } finally {
      cleanup();
    }
  });

  it("returns a structured error when neither source is provided", async () => {
    const { root, cleanup } = makeWorkspace();
    try {
      const result = await runFsmShellScript({}, root);
      assert.equal(result.status, "error");
      assert.match(result.errorMessage ?? "", /command.*scriptPath|scriptPath.*command/);
    } finally {
      cleanup();
    }
  });

  it("marks non-zero exits as error and carries stderr", async () => {
    const { root, cleanup } = makeWorkspace();
    try {
      const result = await runFsmShellScript(
        { command: IS_WIN ? "echo bad 1>&2 & exit 7" : "echo bad >&2; exit 7" },
        root,
      );
      assert.equal(result.status, "error");
      assert.equal(result.exitCode, 7);
      assert.ok(result.stderr.includes("bad"));
      assert.equal(result.errorMessage, undefined);
    } finally {
      cleanup();
    }
  });

  it("reports timeout via timedOut", async () => {
    const { root, cleanup } = makeWorkspace();
    try {
      const result = await runFsmShellScript(
        {
          command: IS_WIN ? "ping -n 31 127.0.0.1 >nul" : "sleep 30",
          timeoutMs: 1_000,
        },
        root,
      );
      assert.equal(result.status, "error");
      assert.equal(result.timedOut, true);
      assert.match(result.errorMessage ?? "", /timed out after 1000ms/);
    } finally {
      cleanup();
    }
  });

  it("propagates abort as cancelled", async () => {
    const { root, cleanup } = makeWorkspace();
    const controller = new AbortController();
    try {
      const pending = runFsmShellScript(
        {
          command: IS_WIN ? "ping -n 31 127.0.0.1 >nul" : "sleep 30",
          timeoutMs: 30_000,
          signal: controller.signal,
        },
        root,
      );
      setTimeout(() => controller.abort(), 200);
      const result = await pending;
      assert.equal(result.status, "error");
      assert.equal(result.cancelled, true);
    } finally {
      cleanup();
    }
  });
});
