import assert from "node:assert/strict";
import { test } from "node:test";
import {
  computeSessionSortKeys,
  sortSessionsByKeys,
} from "./sessionSortKeys.js";

type Row = { id: string; updatedAt: number; status?: string };

const rows = (list: Row[]) => list;

test("running session keeps frozen key while turn streams", () => {
  const prev = new Map([
    ["a", 100],
    ["b", 500],
  ]);
  // "a" is mid-turn: updatedAt bumped to 900 but must stay at 100.
  const next = computeSessionSortKeys(
    rows([
      { id: "a", updatedAt: 900, status: "running" },
      { id: "b", updatedAt: 500 },
    ]),
    prev,
  );
  assert.equal(next.get("a"), 100);
  assert.equal(next.get("b"), 500);
});

test("turn end adopts fresh updatedAt and re-sorts", () => {
  const prev = new Map([
    ["a", 100],
    ["b", 500],
  ]);
  const sessions = rows([
    { id: "a", updatedAt: 900, status: "idle" },
    { id: "b", updatedAt: 500 },
  ]);
  const keys = computeSessionSortKeys(sessions, prev);
  assert.equal(keys.get("a"), 900);
  sortSessionsByKeys(sessions, keys);
  assert.deepEqual(
    sessions.map((s) => s.id),
    ["a", "b"],
  );
});

test("new running session adopts current updatedAt (appears at top)", () => {
  const prev = new Map([["old", 500]]);
  const sessions = rows([
    { id: "old", updatedAt: 500 },
    { id: "new", updatedAt: 800, status: "running" },
  ]);
  const keys = computeSessionSortKeys(sessions, prev);
  assert.equal(keys.get("new"), 800);
  sortSessionsByKeys(sessions, keys);
  assert.deepEqual(
    sessions.map((s) => s.id),
    ["new", "old"],
  );
});

test("deleted sessions drop out of the key map", () => {
  const prev = new Map([
    ["a", 100],
    ["gone", 300],
  ]);
  const next = computeSessionSortKeys(
    rows([{ id: "a", updatedAt: 100 }]),
    prev,
  );
  assert.equal(next.has("gone"), false);
  assert.equal(next.size, 1);
});

test("equal keys keep input order (stable sort)", () => {
  const sessions = rows([
    { id: "x", updatedAt: 50 },
    { id: "y", updatedAt: 50 },
  ]);
  const keys = computeSessionSortKeys(sessions, new Map());
  sortSessionsByKeys(sessions, keys);
  assert.deepEqual(
    sessions.map((s) => s.id),
    ["x", "y"],
  );
});
