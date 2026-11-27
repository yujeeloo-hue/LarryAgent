import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execShellProcess } from "./shellExec.js";
import { excludedProjectShell, SHELL_EXCLUSION_UNAVAILABLE, shellExclusionsEnforceable } from "./shellExclusions.js";

const roots = [join(tmpdir(), "jellybot-excluded-project")];

describe("excludedProjectShell", () => {
  it("never wraps a command when nothing is excluded", () => {
    for (const platform of ["darwin", "win32", "linux"] as const) {
      assert.deepEqual(excludedProjectShell("git status", ["-lc", "git status"], [], platform), { command: "git status", args: ["-lc", "git status"] });
    }
  });

  it("wraps the command with sandbox-exec on macOS", () => {
    const wrapped = excludedProjectShell("git status", ["-lc", "git status"], roots, "darwin");
    assert.equal(wrapped.command, "/usr/bin/sandbox-exec");
    assert.equal(wrapped.args[0], "-p");
    assert.match(wrapped.args[1]!, /\(deny file-read\* file-write\*/);
    assert.ok(wrapped.args[1]!.includes(JSON.stringify(resolve(roots[0]!))));
    assert.deepEqual(wrapped.args.slice(2), ["git status", "-lc", "git status"]);
  });

  it("runs the command unchanged on platforms without an exclusion backend", () => {
    for (const platform of ["win32", "linux"] as const) {
      assert.deepEqual(excludedProjectShell("git rev-parse HEAD", ["/c", "git rev-parse HEAD"], roots, platform), { command: "git rev-parse HEAD", args: ["/c", "git rev-parse HEAD"] });
    }
  });

  it("reports which platforms can enforce exclusions", () => {
    assert.equal(shellExclusionsEnforceable("darwin"), true);
    assert.equal(shellExclusionsEnforceable("win32"), false);
    assert.equal(shellExclusionsEnforceable("linux"), false);
  });
});

describe("strict shell exclusions", { skip: process.platform === "darwin" ? "macOS has a real backend" : false }, () => {
  it("fails closed instead of running an unscoped command", async () => {
    const result = await execShellProcess({ command: "echo hi", cwd: tmpdir(), timeoutMs: 5_000, excludedPaths: roots, strictShellExclusions: true });
    assert.equal(result.status, "spawn-error");
    assert.equal(result.errorMessage, SHELL_EXCLUSION_UNAVAILABLE);
    assert.equal(result.stdout, "");
  });

  it("runs the command when strict mode is off", async () => {
    const result = await execShellProcess({ command: process.platform === "win32" ? "echo hi" : "printf hi", cwd: tmpdir(), timeoutMs: 10_000, excludedPaths: roots });
    assert.equal(result.status, "done");
    assert.equal(result.exitCode, 0);
  });
});
