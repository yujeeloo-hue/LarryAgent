/**
 * Composer capability probe + self-heal retry.
 *
 * Regression: a transiently failed `listComposerOptions` probe (10s budget
 * vs a busy device / flaky phone network) used to leave the mobile composer
 * stuck on the legacy fallback — plain textarea + accent (teal) send button
 * — until an unrelated resync happened. The store must retry unresolved
 * probes with backoff, fire onSettled exactly once when the probe lands,
 * and stop cleanly (settle / device switch / surface closed) so nothing
 * polls forever.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createComposerProbeStore } from "../src/composerProbe.js";
import type { ComposerOptions } from "../src/types.js";

const OPTIONS: ComposerOptions = {
  providers: [{ id: "deepseek", name: "DeepSeek", modelId: "deepseek-v4-flash" }],
  activeProviderId: "deepseek",
  defaults: { composerInfinite: false, reasoningEffort: "low" },
  remoteMode: "full",
};

/** Deterministic clock: timers queue up and only run when the test fires them. */
function fakeClock() {
  type Timer = { id: number; fn: () => void; ms: number; cancelled: boolean };
  let seq = 0;
  const timers: Timer[] = [];
  const schedule = (fn: () => void, ms: number): number => {
    const timer = { id: ++seq, fn, ms, cancelled: false };
    timers.push(timer);
    return timer.id;
  };
  const cancel = (id: number): void => {
    const timer = timers.find((t) => t.id === id);
    if (timer) timer.cancelled = true;
  };
  const pending = (): Timer[] => timers.filter((t) => !t.cancelled);
  /** Run the oldest pending timer and drain the async continuation. */
  const fireNext = async (): Promise<void> => {
    const timer = pending()[0];
    assert.ok(timer, "expected a pending timer");
    timer.cancelled = true; // one-shot semantics
    timer.fn();
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  };
  return { schedule, cancel, pending, fireNext, nextDelay: () => pending()[0]?.ms };
}

/** Flush microtasks without firing timers (after a direct ensure() call). */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

function buildHarness(behavior: {
  respond?: (deviceId: string) => Promise<ComposerOptions>;
  /** Live version source — mutate the closure to simulate a device update. */
  getVersion?: () => string;
}) {
  const clock = fakeClock();
  const calls: Array<{ deviceId: string; timeoutMs: number }> = [];
  const store = createComposerProbeStore({
    request: (deviceId, timeoutMs) => {
      calls.push({ deviceId, timeoutMs });
      return behavior.respond?.(deviceId) ?? Promise.resolve(OPTIONS);
    },
    deviceVersion: () => behavior.getVersion?.() ?? "1.0.0",
    probeTimeoutMs: 10000,
    schedule: clock.schedule,
    cancel: clock.cancel,
  });
  return { clock, calls, store };
}

test("ensure settles ok and caches per device version", async () => {
  const { calls, store } = buildHarness({});
  assert.equal(store.capFor("dev"), null); // unknown → legacy composer fallback
  assert.equal(await store.ensure("dev"), true);
  assert.equal(store.probeOf("dev"), "ok");
  assert.deepEqual(store.capFor("dev"), OPTIONS);
  assert.equal(calls[0]?.timeoutMs, 10000); // short probe budget on purpose
  // Same version → cached, no second round-trip.
  assert.equal(await store.ensure("dev"), false);
  assert.equal(calls.length, 1);
});

test("invalidate drops the cache — providers_changed must hit the wire again", async () => {
  let options = OPTIONS;
  const { calls, store } = buildHarness({ respond: () => Promise.resolve(options) });
  await store.ensure("dev");
  assert.equal(calls.length, 1);
  assert.deepEqual(store.capFor("dev"), OPTIONS);

  // Device pushed providers_changed (same version!): cached options are
  // stale — without invalidate the probe would never re-run.
  options = {
    ...OPTIONS,
    providers: [{ id: "glm", name: "GLM", modelId: "glm-5.3-flash" }],
    activeProviderId: "glm",
  };
  store.invalidate("dev");
  assert.equal(await store.ensure("dev"), true);
  assert.equal(calls.length, 2);
  assert.deepEqual(store.capFor("dev")?.providers[0]?.id, "glm");
  // Other devices keep their caches.
  assert.equal(store.probeOf("other"), "unknown");
});

test("concurrent ensure calls share one probe", async () => {
  let release: (() => void) | null = null;
  const { calls, store } = buildHarness({
    respond: () => new Promise((resolve) => {
      release = () => resolve(OPTIONS);
    }),
  });
  const first = store.ensure("dev");
  const second = store.ensure("dev");
  release!();
  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.equal(calls.length, 1, "one request on the wire");
});

test("transient failure stays unknown — the exact fallback trigger", async () => {
  let fail = true;
  const { store } = buildHarness({
    respond: () => (fail ? Promise.reject(new Error("timeout")) : Promise.resolve(OPTIONS)),
  });
  await store.ensure("dev");
  assert.equal(store.probeOf("dev"), "unknown");
  assert.equal(store.capFor("dev"), null); // ← renders the teal-button composer
  fail = false;
  assert.equal(await store.ensure("dev"), true); // retry succeeds → heals
  assert.equal(store.probeOf("dev"), "ok");
});

test("legacy devices settle sticky and never mask as modern", async () => {
  const { calls, store } = buildHarness({
    respond: () => {
      throw new Error("unknown action: listComposerOptions");
    },
  });
  await store.ensure("dev");
  assert.equal(store.probeOf("dev"), "legacy");
  assert.equal(store.capFor("dev"), null);
  await store.ensure("dev");
  assert.equal(calls.length, 1); // sticky per version — no hammering
});

test("scheduleRetry heals a transiently failed probe exactly once", async () => {
  let fail = true;
  const { clock, calls, store } = buildHarness({
    respond: () => (fail ? Promise.reject(new Error("timeout")) : Promise.resolve(OPTIONS)),
  });
  await store.ensure("dev"); // fails → conv view renders legacy fallback
  let settled = 0;
  store.scheduleRetry("dev", () => settled++, () => true);
  await clock.fireNext(); // first retry still fails
  assert.equal(settled, 0);
  assert.equal(clock.nextDelay(), 8000); // backed off 3000 → 8000
  fail = false;
  await clock.fireNext(); // probe lands
  assert.equal(settled, 1); // repaint fired — modern composer restored
  assert.equal(store.probeOf("dev"), "ok");
  assert.equal(clock.pending().length, 0); // no further timers
  assert.equal(calls.length, 3); // initial + two retries, then stopped
});

test("backoff caps at the last ladder step", async () => {
  const { clock, store } = buildHarness({
    respond: () => {
      throw new Error("timeout");
    },
  });
  await store.ensure("dev");
  store.scheduleRetry("dev", () => assert.fail("never settles while failing"), () => true);
  const delays: number[] = [clock.nextDelay()];
  for (let i = 0; i < 4; i++) {
    await clock.fireNext();
    delays.push(clock.nextDelay());
  }
  assert.deepEqual(delays, [3000, 8000, 15000, 15000, 15000]);
});

test("retry stops when the composer surface goes away (escape hatch)", async () => {
  const { clock, calls, store } = buildHarness({
    respond: () => Promise.reject(new Error("timeout")),
  });
  await store.ensure("dev"); // fails → legacy fallback rendered, retry pending
  let settled = 0;
  let active = true;
  store.scheduleRetry("dev", () => settled++, () => active);
  active = false; // user navigated home / switched device
  await clock.fireNext();
  assert.equal(settled, 0);
  assert.equal(clock.pending().length, 0); // stopped — nothing polls forever
  assert.equal(calls.length, 1);
});

test("settled devices don't schedule; device switch cancels the old retry", async () => {
  const { clock, store } = buildHarness({
    respond: (deviceId) =>
      deviceId === "legacy-dev-1"
        ? Promise.reject(new Error("unknown action: listComposerOptions"))
        : Promise.reject(new Error("timeout")),
  });
  // Legacy settle → scheduleRetry is a no-op (fallback is already correct).
  await store.ensure("legacy-dev-1");
  store.scheduleRetry("legacy-dev-1", () => assert.fail("legacy never retries"), () => true);
  assert.equal(clock.pending().length, 0);

  // Unresolved A pending → scheduling B cancels A's timer.
  store.scheduleRetry("dev-a", () => assert.fail("A superseded"), () => true);
  const aTimer = clock.pending()[0];
  assert.equal(aTimer?.ms, 3000);
  store.scheduleRetry("dev-b", () => assert.fail("B not fired here"), () => true);
  assert.equal(aTimer.cancelled, true);
  assert.equal(clock.pending().length, 1);
  assert.equal(clock.pending()[0]?.ms, 3000); // fresh ladder for B
});

test("retry that finds the capability already settled skips the repaint", async () => {
  let fail = true;
  const { clock, store } = buildHarness({
    respond: () => (fail ? Promise.reject(new Error("timeout")) : Promise.resolve(OPTIONS)),
  });
  await store.ensure("dev"); // fails → retry scheduled below
  let settled = 0;
  store.scheduleRetry("dev", () => settled++, () => true);
  fail = false;
  await store.ensure("dev"); // another path settles it while the retry waits
  await clock.fireNext(); // retry tick: cap already ok → stop, no repaint
  assert.equal(settled, 0);
  assert.equal(clock.pending().length, 0);
});

test("retry landing a legacy settle still fires the repaint exactly once", async () => {
  // The loading placeholder must give way to the plain composer too — a
  // "legacy" settle is a valid final surface, not a silent stop.
  let fail = true;
  const { clock, store } = buildHarness({
    respond: () =>
      fail
        ? Promise.reject(new Error("timeout"))
        : Promise.reject(new Error("unknown action: listComposerOptions")),
  });
  await store.ensure("dev"); // transient fail → placeholder shown, retry pending
  let settled = 0;
  store.scheduleRetry("dev", () => settled++, () => true);
  await clock.fireNext(); // still failing
  assert.equal(settled, 0);
  fail = false;
  await clock.fireNext(); // legacy settle → repaint (placeholder → plain row)
  assert.equal(settled, 1);
  assert.equal(store.probeOf("dev"), "legacy");
  assert.equal(clock.pending().length, 0); // no further timers
});

test("version change re-probes and reports the repaint-worthy diff", async () => {
  let version = "1.0.0";
  const { calls, store } = buildHarness({ getVersion: () => version });
  await store.ensure("dev");
  version = "1.1.0"; // device updated → re-probe
  assert.equal(await store.ensure("dev"), true);
  assert.equal(calls.length, 2);
});
