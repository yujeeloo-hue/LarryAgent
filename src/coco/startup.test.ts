import assert from "node:assert/strict";
import { test } from "node:test";
import { CocoStartup } from "./startup.js";

test("startup automatically recovers after a temporary legacy-scheduler block", async () => {
  let checks = 0, starts = 0; const states: (string | undefined)[] = [];
  let ready!: () => void; const started = new Promise<void>(resolve => { ready = resolve; });
  const startup = new CocoStartup({ verify: async () => ++checks === 1 ? { ok: false, message: "Still unloading" } : { ok: true }, blocked: message => states.push(message), start: () => { starts++; ready(); } }, 5);
  try {
    await startup.run(); assert.equal(starts, 0);
    await Promise.race([started, new Promise((_, reject) => setTimeout(() => reject(new Error("Did not recover")), 1000))]);
    assert.equal(starts, 1); assert.deepEqual(states, ["Still unloading", undefined]);
    await startup.run(); assert.equal(checks, 2, "successful startup must never clear later runtime blocks");
  } finally { startup.stop(); }
});
test("overlapping startup calls share a single verification", async () => {
  let complete!: (result: { ok: boolean }) => void, checks = 0, starts = 0;
  const gate = new Promise<{ ok: boolean }>(resolve => { complete = resolve; });
  const startup = new CocoStartup({ verify: () => { checks++; return gate; }, blocked: () => undefined, start: () => { starts++; } });
  const first = startup.run(), second = startup.run(); assert.equal(checks, 1);
  complete({ ok: true }); await Promise.all([first, second]); assert.equal(starts, 1); startup.stop();
});
test("quitting during verification cancels pending admission and retries", async () => {
  let complete!: (result: { ok: boolean }) => void, starts = 0;
  const gate = new Promise<{ ok: boolean }>(resolve => { complete = resolve; });
  const startup = new CocoStartup({ verify: () => gate, blocked: () => undefined, start: () => { starts++; } }, 5);
  const pending = startup.run(); startup.stop(); complete({ ok: true }); await pending; await startup.run(); assert.equal(starts, 0);
});
test("a runtime initialization failure stays blocked and is not repeatedly restarted", async () => {
  let checks = 0, starts = 0; const states: (string | undefined)[] = [];
  const startup = new CocoStartup({ verify: async () => { checks++; return { ok: true }; }, blocked: message => states.push(message), start: () => { starts++; throw new Error("Database unavailable"); } });
  await startup.run(); await startup.run(); assert.equal(checks, 1); assert.equal(starts, 1); assert.match(states.at(-1) ?? "", /Database unavailable/); startup.stop();
});
