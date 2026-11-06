import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DapFramer, encodeDapMessage, type DapEvent } from "./dapFraming.js";

describe("DapFramer", () => {
  it("decodes a single Content-Length message", () => {
    const ev: DapEvent = { type: "event", seq: 1, event: "initialized" };
    const framed = encodeDapMessage(ev);
    const out = new DapFramer().feed(framed);
    assert.equal(out.length, 1);
    assert.deepEqual(out[0], ev);
  });

  it("reassembles a message split across chunks", () => {
    const ev: DapEvent = { type: "event", seq: 2, event: "stopped", body: { threadId: 1 } };
    const framed = encodeDapMessage(ev);
    const framer = new DapFramer();
    assert.deepEqual(framer.feed(framed.subarray(0, 12)), []);
    const rest = framer.feed(framed.subarray(12));
    assert.equal(rest.length, 1);
    assert.equal(rest[0]?.type, "event");
    if (rest[0]?.type === "event") assert.equal(rest[0].event, "stopped");
  });

  it("decodes two messages in one chunk", () => {
    const a: DapEvent = { type: "event", seq: 1, event: "initialized" };
    const b: DapEvent = { type: "event", seq: 2, event: "stopped" };
    const out = new DapFramer().feed(
      Buffer.concat([encodeDapMessage(a), encodeDapMessage(b)]),
    );
    assert.equal(out.length, 2);
    assert.equal(out[0]?.type === "event" && out[0].event, "initialized");
    assert.equal(out[1]?.type === "event" && out[1].event, "stopped");
  });
});
