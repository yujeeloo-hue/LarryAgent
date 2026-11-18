import assert from "node:assert/strict";
import { test } from "node:test";
import { ClangdDocumentCache } from "./documentCache.js";

test("idle cache keeps repeated queries warm and expires after the last use", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const closed: string[] = [];
  const cache = new ClangdDocumentCache(uri => closed.push(uri), 2, 60_000);
  cache.release("a");
  t.mock.timers.tick(50_000);
  cache.acquire("a");
  t.mock.timers.tick(20_000);
  assert.deepEqual(closed, []);
  cache.release("a");
  t.mock.timers.tick(59_999);
  assert.deepEqual(closed, []);
  t.mock.timers.tick(1);
  assert.deepEqual(closed, ["a"]);
  cache.dispose();
});

test("capacity evicts the least recently used idle document, never an acquired one", () => {
  const closed: string[] = [];
  const cache = new ClangdDocumentCache(uri => closed.push(uri), 2);
  cache.release("a");
  cache.release("b");
  cache.acquire("a");
  cache.release("c");
  assert.deepEqual(closed, []);
  cache.release("a");
  assert.deepEqual(closed, ["b"]);
  cache.dispose();
});

test("disposing a session cancels all idle expiry callbacks", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const closed: string[] = [];
  const cache = new ClangdDocumentCache(uri => closed.push(uri));
  cache.release("a");
  cache.release("b");
  cache.dispose();
  t.mock.timers.tick(120_000);
  assert.deepEqual(closed, []);
});
