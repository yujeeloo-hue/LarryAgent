import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { benignDebuggeeStop } from "./stopFilter.js";

describe("benignDebuggeeStop", () => {
  it("resumes the thread-naming exception Unreal raises under a debugger", () => {
    assert.deepEqual(
      benignDebuggeeStop({
        reason: "exception",
        description: "Exception 0x406d1388 encountered at address 0x7ffb12345678",
        threadId: 3,
      }),
      { code: "0x406d1388", label: "thread name" },
    );
    assert.equal(
      benignDebuggeeStop({ reason: "exception", text: "EXCEPTION 0x4001000A" })?.label,
      "debug output",
    );
  });

  it("surfaces steps, pauses and breakpoints", () => {
    for (const reason of ["step", "pause", "breakpoint", "entry", "goto"]) {
      assert.equal(
        benignDebuggeeStop({ reason, description: "0x406d1388" }),
        null,
        reason,
      );
    }
  });

  it("surfaces unknown exceptions", () => {
    assert.equal(
      benignDebuggeeStop({
        reason: "exception",
        description: "Exception 0xc0000005 encountered at address 0x0",
      }),
      null,
    );
    assert.equal(benignDebuggeeStop({ reason: "exception" }), null);
  });
});
