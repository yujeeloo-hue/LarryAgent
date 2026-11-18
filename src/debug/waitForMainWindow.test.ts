import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { waitForProcessMainWindow } from "./waitForMainWindow.js";

describe("waitForProcessMainWindow", () => {
  it("returns ready once the probe sees a window", async () => {
    let n = 0;
    const result = await waitForProcessMainWindow({
      pid: 7,
      timeoutMs: 1_000,
      pollMs: 1,
      sleep: async () => undefined,
      probe: () => {
        n += 1;
        return n >= 3 ? "ready" : "alive";
      },
    });
    assert.equal(result, "ready");
    assert.equal(n, 3);
  });

  it("returns exited when the process disappears", async () => {
    const result = await waitForProcessMainWindow({
      pid: 7,
      timeoutMs: 1_000,
      pollMs: 1,
      sleep: async () => undefined,
      probe: () => "exited",
    });
    assert.equal(result, "exited");
  });

  it("returns cancelled when the abort signal is already set", async () => {
    const ac = new AbortController();
    ac.abort();
    const result = await waitForProcessMainWindow({
      pid: 7,
      signal: ac.signal,
      probe: () => "alive",
    });
    assert.equal(result, "cancelled");
  });

  it("does not time out when timeoutMs is null", async () => {
    let n = 0;
    const result = await waitForProcessMainWindow({
      pid: 7,
      timeoutMs: null,
      pollMs: 1,
      sleep: async () => undefined,
      probe: () => {
        n += 1;
        return n >= 4 ? "ready" : "alive";
      },
    });
    assert.equal(result, "ready");
    assert.equal(n, 4);
  });
});
