import assert from "node:assert/strict";
import { test } from "node:test";
import type { CocoRepository } from "../coco/repository.js";
import type { CocoWork } from "../coco/types.js";
import type { SessionStore } from "./sessionRuntime.js";
import { backfillCocoSessionSources } from "./cocoSessionSource.js";

type Summary = { id: string; source?: string };

const fakeStore = (summaries: Summary[]) => {
  const stamped: Array<{ id: string; source: string }> = [];
  const byId = new Map(summaries.map(s => [s.id, s]));
  return {
    stamped,
    listSessions: () => summaries.map(s => ({ id: s.id, source: s.source })),
    setSessionSource: (id: string, source: string) => {
      const row = byId.get(id); if (!row) return false;
      row.source = source; stamped.push({ id, source }); return true;
    },
  } as unknown as SessionStore;
};
const fakeRepository = (works: Partial<CocoWork>[]) => ({ list: () => works }) as unknown as CocoRepository;

test("backfill stamps only 'app' sessions linked as execution targets of CoCo work", () => {
  const store = fakeStore([
    { id: "adopted" },                  // linked work session created pre-stamping ('app' ⇒ absent)
    { id: "fresh", source: "coco" },    // already marked — must not be touched
    { id: "user" },                     // ordinary user session — untouched
    { id: "legacy", source: "loop" },   // legacy marker preserved
    { id: "reclaimed", source: "app" }, // explicit take-back — must stay user-owned
  ]);
  backfillCocoSessionSources(store, fakeRepository([
    { sessionId: "adopted" }, { sessionId: "fresh" }, { sessionId: "reclaimed" }, { sessionId: "missing-row" },
  ]));
  assert.deepEqual((store as unknown as { stamped: Array<{ id: string; source: string }> }).stamped, [{ id: "adopted", source: "coco" }]);
});

test("backfill is a no-op when no work carries an execution session", () => {
  const store = fakeStore([{ id: "user" }]);
  backfillCocoSessionSources(store, fakeRepository([{ sessionId: undefined }]));
  assert.deepEqual((store as unknown as { stamped: unknown[] }).stamped, []);
});
