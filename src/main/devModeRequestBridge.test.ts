import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import {
  DEV_MODE_REPLY_CHANNEL,
  DEV_MODE_REQUEST_CHANNEL,
  pendingDevModeRequestCount,
  registerDevModeReplyChannel,
  requestDevMode,
  resetDevModeRequests,
  type DevModeRequestOwner,
} from "./devModeRequestBridge.js";

type Sent = { channel: string; payload: unknown };

function fakeOwner(id = 1) {
  const sent: Sent[] = [];
  const listeners: Array<() => void> = [];
  const owner: DevModeRequestOwner = {
    id,
    isDestroyed: () => false,
    send: (channel, payload) => {
      sent.push({ channel, payload });
    },
    once: (_event, listener) => {
      listeners.push(listener);
    },
    removeListener: (_event, listener) => {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    },
  };
  return {
    owner,
    sent,
    destroy: () => {
      for (const listener of [...listeners]) listener();
    },
    listenerCount: () => listeners.length,
  };
}

type Reply = (senderId: number, payload: unknown) => void;

function installChannel(): { reply: Reply; channel: string } {
  let handler: Reply | undefined;
  let channel = "";
  registerDevModeReplyChannel((name, registered) => {
    channel = name;
    handler = registered;
  });
  return {
    channel,
    reply: (senderId, payload) => {
      assert.ok(handler, "reply channel was not registered");
      handler(senderId, payload);
    },
  };
}

function requestIdOf(entry: Sent): number {
  const payload = entry.payload as { id?: unknown };
  assert.equal(typeof payload.id, "number");
  return payload.id as number;
}

describe("devModeRequestBridge", () => {
  beforeEach(() => {
    resetDevModeRequests();
  });

  it("sends the op on the request channel and resolves with the reply", async () => {
    const { reply } = installChannel();
    const window = fakeOwner();
    const pending = requestDevMode(window.owner, "ensure", { x: 1 }, { timeoutMs: 1_000 });
    assert.equal(window.sent.length, 1);
    assert.equal(window.sent[0]?.channel, DEV_MODE_REQUEST_CHANNEL);
    const id = requestIdOf(window.sent[0]!);
    reply(1, { id, result: { ok: true } });
    assert.deepEqual(await pending, { ok: true });
    assert.equal(window.listenerCount(), 0);
    assert.equal(pendingDevModeRequestCount(), 0);
  });

  it("ignores replies from another window and unknown ids", async () => {
    const { reply } = installChannel();
    const window = fakeOwner(7);
    const pending = requestDevMode(window.owner, "ensure", {}, { timeoutMs: 1_000 });
    const id = requestIdOf(window.sent[0]!);
    reply(8, { id, result: { ok: true } });
    reply(7, { id: id + 99, result: { ok: true } });
    assert.equal(pendingDevModeRequestCount(), 1);
    reply(7, { id, result: { ok: false, message: "Dev Mode is not available" } });
    assert.deepEqual(await pending, { ok: false, message: "Dev Mode is not available" });
  });

  it("treats a malformed result as a failure instead of resolving ok", async () => {
    const { reply } = installChannel();
    const window = fakeOwner();
    const pending = requestDevMode(window.owner, "breakpoints", {}, { timeoutMs: 1_000 });
    reply(1, { id: requestIdOf(window.sent[0]!), result: "nope" });
    const result = await pending;
    assert.equal(result.ok, false);
    assert.match(result.message ?? "", /malformed/i);
  });

  it("rejects on timeout and drops the pending entry", async () => {
    const window = fakeOwner();
    await assert.rejects(
      requestDevMode(window.owner, "ensure", {}, { timeoutMs: 10 }),
      /did not answer "ensure"/,
    );
    assert.equal(pendingDevModeRequestCount(), 0);
    assert.equal(window.listenerCount(), 0);
  });

  it("rejects when the window is destroyed mid-request", async () => {
    const window = fakeOwner();
    const pending = requestDevMode(window.owner, "ensure", {}, { timeoutMs: 1_000 });
    window.destroy();
    await assert.rejects(pending, /window closed/);
    assert.equal(pendingDevModeRequestCount(), 0);
  });

  it("rejects immediately without a window or when send throws", async () => {
    await assert.rejects(requestDevMode(null, "ensure"), /No application window/);
    const broken: DevModeRequestOwner = {
      id: 2,
      isDestroyed: () => false,
      send: () => {
        throw new Error("renderer gone");
      },
    };
    await assert.rejects(
      requestDevMode(broken, "ensure", {}, { timeoutMs: 1_000 }),
      /Could not reach the Dev Mode window — renderer gone/,
    );
    assert.equal(pendingDevModeRequestCount(), 0);
  });

  it("registers the reply channel once and uses the documented name", () => {
    const { channel } = installChannel();
    assert.equal(channel, DEV_MODE_REPLY_CHANNEL);
    let calls = 0;
    registerDevModeReplyChannel(() => {
      calls += 1;
    });
    assert.equal(calls, 0);
  });
});
