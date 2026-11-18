import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  enqueueBackgroundExtract,
  resetBackgroundExtractQueueForTests,
  setBackgroundExtractQuietMsForTests,
} from "./backgroundExtractQueue.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(() => {
  resetBackgroundExtractQueueForTests();
});

describe("backgroundExtractQueue", () => {
  it("waits for the quiet window before running", async () => {
    setBackgroundExtractQuietMsForTests(40);
    const order: string[] = [];
    enqueueBackgroundExtract("a", async () => {
      order.push("a");
    });
    await delay(15);
    assert.deepEqual(order, []);
    await delay(50);
    assert.deepEqual(order, ["a"]);
  });

  it("coalesces the same key to the latest run", async () => {
    setBackgroundExtractQuietMsForTests(30);
    const order: string[] = [];
    enqueueBackgroundExtract("user", async () => {
      order.push("old");
    });
    enqueueBackgroundExtract("user", async () => {
      order.push("new");
    });
    await delay(60);
    assert.deepEqual(order, ["new"]);
  });

  it("runs distinct keys serially", async () => {
    setBackgroundExtractQuietMsForTests(20);
    const order: string[] = [];
    enqueueBackgroundExtract("user", async () => {
      order.push("user-start");
      await delay(40);
      order.push("user-end");
    });
    enqueueBackgroundExtract("project:/tmp/w", async () => {
      order.push("project");
    });
    await delay(120);
    assert.deepEqual(order, ["user-start", "user-end", "project"]);
  });

  it("debounces while schedules keep arriving", async () => {
    setBackgroundExtractQuietMsForTests(40);
    const order: string[] = [];
    enqueueBackgroundExtract("user", async () => {
      order.push("first");
    });
    await delay(25);
    enqueueBackgroundExtract("user", async () => {
      order.push("second");
    });
    await delay(25);
    assert.deepEqual(order, []);
    await delay(50);
    assert.deepEqual(order, ["second"]);
  });
});
