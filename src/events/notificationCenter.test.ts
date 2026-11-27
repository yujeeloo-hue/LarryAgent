import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addNotificationListener,
  postNotification,
  type NotificationCenterEvent,
} from "./notificationCenter.js";

function sampleEvent(
  overrides?: Partial<NotificationCenterEvent>,
): NotificationCenterEvent {
  return {
    eventName: "notifications/message",
    params: { level: "info", data: { text: "hello" } },
    sender: { tag: "test-sender" },
    ...overrides,
  };
}

describe("NotificationCenter", () => {
  it("delivers a posted event to a listener (same object reference)", () => {
    const received: NotificationCenterEvent[] = [];
    const unsubscribe = addNotificationListener((event) =>
      received.push(event),
    );
    const event = sampleEvent();
    postNotification(event);
    unsubscribe();
    assert.equal(received.length, 1);
    assert.strictEqual(received[0], event);
  });

  it("stops delivering after unsubscribe", () => {
    let count = 0;
    const unsubscribe = addNotificationListener(() => {
      count += 1;
    });
    unsubscribe();
    postNotification(sampleEvent());
    assert.equal(count, 0);
  });

  it("broadcasts to multiple listeners", () => {
    let a = 0;
    let b = 0;
    const unsubscribeA = addNotificationListener(() => {
      a += 1;
    });
    const unsubscribeB = addNotificationListener(() => {
      b += 1;
    });
    postNotification(sampleEvent());
    unsubscribeA();
    unsubscribeB();
    assert.equal(a, 1);
    assert.equal(b, 1);
  });

  it("isolates a throwing listener — siblings and poster unaffected", () => {
    const originalError = console.error;
    console.error = () => undefined;
    try {
      const received: NotificationCenterEvent[] = [];
      const unsubscribeBad = addNotificationListener(() => {
        throw new Error("boom");
      });
      const unsubscribeGood = addNotificationListener((event) =>
        received.push(event),
      );
      assert.doesNotThrow(() => postNotification(sampleEvent()));
      unsubscribeBad();
      unsubscribeGood();
      assert.equal(received.length, 1);
    } finally {
      console.error = originalError;
    }
  });
});
