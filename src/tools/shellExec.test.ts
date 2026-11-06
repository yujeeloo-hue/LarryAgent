/**
 * execShellProcess — shared shell executor core (spawn / group-kill /
 * timeout / abort). Real-process behavior tests, mirroring the guarantees
 * the run_shell tool handler relies on.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { execShellProcess, resolvePosixShell } from "./shellExec.js";

// cmd.exe vs /bin/zsh: same guarantees, platform-native commands/output.
const IS_WIN = process.platform === "win32";
const NL = IS_WIN ? "\x0d\x0a" : "";

describe("execShellProcess", () => {
  it("captures stdout and exit code 0", async () => {
    const result = await execShellProcess({
      command: IS_WIN ? "echo jellybot" : "printf jellybot",
      cwd: tmpdir(),
      timeoutMs: 10_000,
    });
    assert.equal(result.status, "done");
    assert.equal(result.exitCode, 0);
    assert.equal(result.signalName, null);
    assert.equal(result.stdout, `jellybot${NL}`);
    assert.equal(result.stderr, "");
  });

  it("propagates non-zero exit codes and stderr", async () => {
    const result = await execShellProcess({
      command: IS_WIN ? "echo boom 1>&2 & exit 3" : "echo boom >&2; exit 3",
      cwd: tmpdir(),
      timeoutMs: 10_000,
    });
    assert.equal(result.status, "done");
    assert.equal(result.exitCode, 3);
    assert.ok(result.stderr.includes("boom"));
  });

  it("merges extra env vars over process.env", async () => {
    const result = await execShellProcess({
      command: IS_WIN
        ? "echo %JELLY_SHELL_EXEC_TEST%"
        : 'printf "%s" "$JELLY_SHELL_EXEC_TEST"',
      cwd: tmpdir(),
      timeoutMs: 10_000,
      env: { JELLY_SHELL_EXEC_TEST: "42" },
    });
    assert.equal(result.status, "done");
    assert.equal(result.stdout, `42${NL}`);
  });

  it("keeps quoted paths intact so spaces survive the shell", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jellybot-shell-quote-"));
    const file = join(dir, "my notes.txt");
    await writeFile(file, "quoted-ok\n", "utf8");
    try {
      const result = await execShellProcess({
        command: IS_WIN ? `type "${file}"` : `cat "${file}"`,
        cwd: tmpdir(),
        timeoutMs: 10_000,
      });
      assert.equal(result.status, "done");
      assert.equal(result.exitCode, 0);
      assert.equal(result.stderr, "");
      assert.ok(result.stdout.includes("quoted-ok"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not kill the process when timeoutMs is 0", async () => {
    const result = await execShellProcess({
      command: IS_WIN ? "ping -n 2 127.0.0.1 >nul" : "sleep 0.4",
      cwd: tmpdir(),
      timeoutMs: 0,
    });
    assert.equal(result.status, "done");
    assert.equal(result.exitCode, 0);
  });

  it("reports timeout when the script overruns timeoutMs", async () => {
    const startedAt = Date.now();
    const result = await execShellProcess({
      // ping is the native ~30s sleeper (sleep(1) is not shipped).
      command: IS_WIN ? "ping -n 31 127.0.0.1 >nul" : "sleep 30",
      cwd: tmpdir(),
      timeoutMs: 800,
    });
    const elapsed = Date.now() - startedAt;
    assert.equal(result.status, "timeout");
    assert.ok(elapsed < 5_000, `timeout took ${elapsed}ms to settle`);
  });

  it("resolves cancelled when the abort signal fires", async () => {
    const controller = new AbortController();
    const pending = execShellProcess({
      command: IS_WIN ? "ping -n 31 127.0.0.1 >nul" : "sleep 30",
      cwd: tmpdir(),
      timeoutMs: 30_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 200);
    const startedAt = Date.now();
    const result = await pending;
    assert.equal(result.status, "cancelled");
    assert.ok(Date.now() - startedAt < 5_000);
  });

  it("reports spawn-error for an invalid working directory", async () => {
    const result = await execShellProcess({
      command: "echo hi",
      cwd: IS_WIN
        ? "Z:\\definitely\\missing\\dir\\jellybot-test"
        : "/definitely/not/a/real/dir/jellybot-test",
      timeoutMs: 10_000,
    });
    assert.equal(result.status, "spawn-error");
    assert.ok(result.errorMessage);
  });
});

describe("resolvePosixShell", () => {
  it("keeps macOS byte-identical on /bin/zsh -lc", () => {
    assert.deepEqual(resolvePosixShell("darwin", () => false), {
      shell: "/bin/zsh",
      args: ["-lc"],
    });
  });

  it("prefers bash with login semantics when present (Raspberry Pi OS)", () => {
    assert.deepEqual(
      resolvePosixShell("linux", (p) => p === "/bin/bash"),
      { shell: "/bin/bash", args: ["-lc"] },
    );
  });

  it("falls back to plain sh without -l when only sh exists", () => {
    assert.deepEqual(
      resolvePosixShell("linux", (p) => p === "/bin/sh"),
      { shell: "/bin/sh", args: ["-c"] },
    );
  });

  it("assumes /bin/sh -c when no candidate exists", () => {
    assert.deepEqual(resolvePosixShell("linux", () => false), {
      shell: "/bin/sh",
      args: ["-c"],
    });
  });

  it("resolves to an executable shell on this host", async () => {
    // The real-process suite above already proves the resolved shell runs;
    // this pins that the resolution itself never picks a missing path on
    // POSIX hosts (darwin's constant aside — zsh is guaranteed there).
    if (IS_WIN) return;
    const { shell } = resolvePosixShell();
    const result = await execShellProcess({
      command: "printf ok",
      cwd: tmpdir(),
      timeoutMs: 10_000,
    });
    assert.equal(result.status, "done");
    assert.equal(result.stdout, "ok");
    assert.ok(shell.length > 0);
  });
});
