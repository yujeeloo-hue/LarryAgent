import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { isRemoteRsyncUpload, runShellHandler } from "./runShell.js";
import { ToolReturnCode } from "../../session/returnCodes.js";
import type { ToolExecuteContext } from "../types.js";

function makeContext(signal?: AbortSignal): ToolExecuteContext {
  return {
    workspacePath: tmpdir(),
    ...(signal ? { signal } : {}),
  } as unknown as ToolExecuteContext;
}

describe("run_shell process lifetime", () => {
  it("settles when the shell exits even if a background child holds the pipes", async () => {
    const startedAt = Date.now();
    const result = await runShellHandler(
      { command: "sleep 20 & echo done" },
      makeContext(),
    );
    const elapsed = Date.now() - startedAt;

    assert.equal(result.returnCode, ToolReturnCode.Success);
    assert.ok(
      elapsed < 5_000,
      `expected a prompt settle, took ${elapsed}ms (waiting on pipe close?)`,
    );
  });

  it(
    "cancel kills the whole process group, not just the shell",
    // POSIX-only body (sleep/touch, `&` + `;` separators): cmd.exe settles
    // it as Success before the cancel fires — process-group semantics are
    // verified on POSIX platforms.
    { skip: process.platform === "win32" },
    async () => {
    const marker = join(tmpdir(), `jb-run-shell-${Date.now()}.marker`);
    rmSync(marker, { force: true });
    const controller = new AbortController();

    const pending = runShellHandler(
      { command: `(sleep 2 && touch ${marker}) & echo started; sleep 20` },
      makeContext(controller.signal),
    );
    setTimeout(() => controller.abort(), 300);

    const startedAt = Date.now();
    const result = await pending;
    assert.equal(result.returnCode, ToolReturnCode.Cancelled);
    assert.ok(
      Date.now() - startedAt < 5_000,
      "cancel should not wait for the background child",
    );

    await new Promise((resolve) => setTimeout(resolve, 3_000));
    assert.equal(
      existsSync(marker),
      false,
      "background grandchild survived the cancel",
    );
    rmSync(marker, { force: true });
  });
});

describe("run_shell structured receipt", () => {
  it("is absent unless the FSM sets shellStructuredReceipt", async () => {
    const result = await runShellHandler({ command: "echo plain" }, makeContext());
    assert.equal(result.receipt, undefined);
  });

  it("carries exit code and stdout without changing the model text", async () => {
    const ctx = { ...makeContext(), shellStructuredReceipt: true } as ToolExecuteContext;
    const ok = await runShellHandler({ command: "echo edg-ok" }, ctx);
    assert.equal(ok.returnCode, ToolReturnCode.Success);
    assert.equal(ok.receipt?.exitCode, 0);
    assert.equal(ok.receipt?.timedOut, false);
    assert.match(String(ok.receipt?.stdout), /edg-ok/);
    const plain = await runShellHandler({ command: "echo edg-ok" }, makeContext());
    assert.deepEqual(ok.content, plain.content);

    const failed = await runShellHandler({ command: "exit 3" }, ctx);
    assert.equal(failed.returnCode, ToolReturnCode.GenericFailure);
    assert.equal(failed.receipt?.exitCode, 3);
  });

  it("ignores an extra `then` argument", async () => {
    const ctx = { ...makeContext(), shellStructuredReceipt: true } as ToolExecuteContext;
    const result = await runShellHandler({ command: "echo root", then: ["echo next"] }, ctx);
    assert.equal(result.receipt?.exitCode, 0);
    assert.doesNotMatch(String(result.receipt?.stdout), /next/);
  });
});

describe("isRemoteRsyncUpload redirect", () => {
  it("flags rsync commands targeting a remote host:path", () => {
    assert.equal(
      isRemoteRsyncUpload("rsync -az web/ jnote-cloud:/opt/jnote-web/"),
      true,
    );
    assert.equal(
      isRemoteRsyncUpload("rsync -az --delete a root@1.2.3.4:/opt/x"),
      true,
    );
  });

  it("passes local rsync and non-rsync commands through", () => {
    assert.equal(isRemoteRsyncUpload("rsync -az --version"), false);
    assert.equal(isRemoteRsyncUpload("rsync -az a /tmp/b"), false);
    assert.equal(isRemoteRsyncUpload("echo hi"), false);
    assert.equal(isRemoteRsyncUpload("sleep 5 && echo ok"), false);
  });

  it("redirects a remote rsync run_shell call to upload_files", async () => {
    const result = await runShellHandler(
      { command: "rsync -az d jnote-cloud:/opt/jnote-web" },
      { workspacePath: "/tmp" } as never,
    );
    assert.equal(result.returnCode, ToolReturnCode.InvalidArguments);
    const text = result.content.map((p) => ("text" in p ? p.text : "")).join("");
    assert.match(text, /upload_files/);
  });
});
