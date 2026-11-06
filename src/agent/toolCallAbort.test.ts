import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  abortToolCall,
  registerToolCallAbort,
  unregisterToolCallAbort,
} from "./toolCallAbort.js";
import { runShellHandler } from "../tools/builtin/runShell.js";
import { ToolReturnCode } from "../session/returnCodes.js";
import type { ToolExecuteContext } from "../tools/types.js";

function makeContext(signal?: AbortSignal): ToolExecuteContext {
  return {
    workspacePath: tmpdir(),
    ...(signal ? { signal } : {}),
  } as unknown as ToolExecuteContext;
}

describe("toolCallAbort registry", () => {
  it("aborts only the registered call for the matching session", () => {
    const controller = new AbortController();
    registerToolCallAbort("sess-1", "call-1", controller);

    assert.equal(abortToolCall("sess-1", "call-1"), true, "first abort wins");
    assert.ok(controller.signal.aborted, "registered controller aborted");

    // Idempotent: aborting again reports false but stays safe.
    assert.equal(abortToolCall("sess-1", "call-1"), false, "second abort no-op");

    // Wrong session / unknown id never abort.
    const other = new AbortController();
    registerToolCallAbort("sess-2", "call-2", other);
    assert.equal(abortToolCall("sess-1", "call-2"), false, "session mismatch");
    assert.equal(abortToolCall("sess-1", "call-missing"), false, "unknown id");
    assert.ok(!other.signal.aborted, "unrelated controller untouched");

    unregisterToolCallAbort("call-1");
    unregisterToolCallAbort("call-2");
    assert.equal(abortToolCall("sess-1", "call-1"), false, "unregistered gone");
  });

  it("turn signal cascades into the per-call fork", () => {
    const turn = new AbortController();
    const child = new AbortController();
    const onTurnAbort = () => child.abort();
    turn.signal.addEventListener("abort", onTurnAbort, { once: true });
    registerToolCallAbort("sess-1", "call-1", child);

    turn.abort();
    assert.ok(child.signal.aborted, "child aborted when turn aborted");
    unregisterToolCallAbort("call-1");
  });
});

describe("abortToolCall -> run_shell", () => {
  it(
    "kills a hanging shell command and its process group, turn stays alive",
    // POSIX-only body (sleep/touch, `&` + `;` separators): cmd.exe settles
    // it as Success before the abort even fires — skip on Windows.
    { skip: process.platform === "win32" },
    async () => {
    const marker = join(tmpdir(), `jb-tool-abort-${Date.now()}.marker`);
    rmSync(marker, { force: true });

    // Mirror runTools: fork a per-call controller from the (untouched) turn
    // signal, register it, and hand the child signal to the handler.
    const turn = new AbortController();
    const callAbort = new AbortController();
    const onTurnAbort = () => callAbort.abort();
    turn.signal.addEventListener("abort", onTurnAbort, { once: true });
    registerToolCallAbort("sess-1", "call-1", callAbort);

    const pending = runShellHandler(
      { command: `(sleep 2 && touch ${marker}) & echo started; sleep 20` },
      makeContext(callAbort.signal),
    );
    setTimeout(() => abortToolCall("sess-1", "call-1"), 300);

    const startedAt = Date.now();
    const result = await pending;
    assert.equal(result.returnCode, ToolReturnCode.Cancelled);
    assert.ok(
      Date.now() - startedAt < 5_000,
      "abort should settle promptly without waiting for the background child",
    );
    assert.equal(turn.signal.aborted, false, "turn keeps running");

    await new Promise((resolve) => setTimeout(resolve, 3_000));
    assert.equal(
      existsSync(marker),
      false,
      "background grandchild survived the per-call abort",
    );
    rmSync(marker, { force: true });
    unregisterToolCallAbort("call-1");
  });
});
