import assert from "node:assert/strict";
import { test } from "node:test";
import { createLegacyRetirement, isMissingLaunchctlService, type LegacySchedulerStatus } from "./legacyRetirement.js";

const absent: LegacySchedulerStatus = { loaded: false, availability: "absent", pid: null, plistExists: false, lastError: null };
const loaded: LegacySchedulerStatus = { loaded: true, availability: "loaded", pid: 123, plistExists: true, lastError: null };
function fixture(status: () => LegacySchedulerStatus, alive: () => boolean = () => false) {
  let now = 0, removals = 0;
  const run = createLegacyRetirement({ status: async () => status(), uninstall: async () => { removals++; return { ok: true }; }, processAlive: alive, now: () => now,
    sleep: async (ms, signal) => { signal?.throwIfAborted(); now += ms; } });
  return { run, now: () => now, removals: () => removals };
}
test("launchctl absent classification uses the failed service query, not any 'not found' error", () => {
  assert.equal(isMissingLaunchctlService({ code: 113, stderr: 'Bad request.\nCould not find service "com.jellybot.app.loops" in domain for user gui: 501' }), true);
  for (const failure of [{ code: 0, stderr: "Could not find service" }, { code: "ENOENT", stderr: "launchctl not found" }, { code: 1, stderr: "Operation not permitted" }, { code: 125, stderr: "Could not find domain" }, { code: 113, stderr: "Could not find service", killed: true }, { code: 113, stderr: "Could not find service", signal: "SIGTERM" }]) assert.equal(isMissingLaunchctlService(failure), false);
});
test("already absent without a plist passes without an uninstall", async () => {
  const f = fixture(() => absent); assert.deepEqual(await f.run(), { ok: true }); assert.equal(f.removals(), 0);
});
test("waits through delayed unload and transient probe errors until the process actually exits", async () => {
  let calls = 0;
  const f = fixture(() => ++calls === 1 ? loaded : calls < 4 ? { ...absent, availability: "unknown", lastError: "Query temporarily unavailable" } : absent, () => f.now() < 7000);
  assert.deepEqual(await f.run(), { ok: true }); assert.ok(f.now() >= 7000); assert.equal(f.removals(), 1);
});
test("a PID observed before bootout remains a barrier across later absent-service retries", async () => {
  let calls = 0, alive = true;
  const f = fixture(() => ++calls === 1 ? loaded : absent, () => alive);
  assert.equal((await f.run()).ok, false); assert.ok(f.now() >= 35000);
  assert.equal((await f.run()).ok, false, "an absent service alone cannot forget the still-live PID");
  alive = false; assert.deepEqual(await f.run(), { ok: true }); assert.equal(f.removals(), 1);
});
test("unknown state and a remaining startup plist never admit Coco", async () => {
  const unknown = fixture(() => ({ ...absent, availability: "unknown", lastError: "Permission denied" }));
  assert.equal((await unknown.run()).ok, false); assert.equal(unknown.removals(), 0);
  const plist = fixture(() => ({ ...absent, plistExists: true })); assert.equal((await plist.run()).ok, false);
});
test("application shutdown aborts retirement without starting anything", async () => {
  const f = fixture(() => loaded), abort = new AbortController(); abort.abort();
  await assert.rejects(f.run(abort.signal), { name: "AbortError" }); assert.equal(f.removals(), 0);
});
