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
  const fireNext = async (): Promise<void> => {
    const timer = pending()[0];
    assert.ok(timer, "expected a pending timer");
    timer.cancelled = true;
    timer.fn();
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  };
  return { schedule, cancel, pending, fireNext, nextDelay: () => pending()[0]?.ms };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

function buildHarness(behavior: {
  respond?: (deviceId: string) => Promise<ComposerOptions>;
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
  assert.equal(store.capFor("dev"), null);
  assert.equal(await store.ensure("dev"), true);
  assert.equal(store.probeOf("dev"), "ok");
  assert.deepEqual(store.capFor("dev"), OPTIONS);
  assert.equal(calls[0]?.timeoutMs, 10000);
  assert.equal(await store.ensure("dev"), false);
  assert.equal(calls.length, 1);
});

test("invalidate drops the cache — providers_changed must hit the wire again", async () => {
  let options = OPTIONS;
  const { calls, store } = buildHarness({ respond: () => Promise.resolve(options) });
  await store.ensure("dev");
  assert.equal(calls.length, 1);
  assert.deepEqual(store.capFor("dev"), OPTIONS);

  options = {
    ...OPTIONS,
    providers: [{ id: "glm", name: "GLM", modelId: "glm-5.3-flash" }],
    activeProviderId: "glm",
  };
  store.invalidate("dev");
  assert.equal(await store.ensure("dev"), true);
  assert.equal(calls.length, 2);
  assert.deepEqual(store.capFor("dev")?.providers[0]?.id, "glm");
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
  assert.equal(store.capFor("dev"), null);
  fail = false;
  assert.equal(await store.ensure("dev"), true);
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
  assert.equal(calls.length, 1);
});

test("scheduleRetry heals a transiently failed probe exactly once", async () => {
  let fail = true;
  const { clock, calls, store } = buildHarness({
    respond: () => (fail ? Promise.reject(new Error("timeout")) : Promise.resolve(OPTIONS)),
  });
  await store.ensure("dev");
  let settled = 0;
  store.scheduleRetry("dev", () => settled++, () => true);
  await clock.fireNext();
  assert.equal(settled, 0);
  assert.equal(clock.nextDelay(), 8000);
  fail = false;
  await clock.fireNext();
  assert.equal(settled, 1);
  assert.equal(store.probeOf("dev"), "ok");
  assert.equal(clock.pending().length, 0);
  assert.equal(calls.length, 3);
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
  await store.ensure("dev");
  let settled = 0;
  let active = true;
  store.scheduleRetry("dev", () => settled++, () => active);
  active = false;
  await clock.fireNext();
  assert.equal(settled, 0);
  assert.equal(clock.pending().length, 0);
  assert.equal(calls.length, 1);
});

test("settled devices don't schedule; device switch cancels the old retry", async () => {
  const { clock, store } = buildHarness({
    respond: (deviceId) =>
      deviceId === "legacy-dev-1"
        ? Promise.reject(new Error("unknown action: listComposerOptions"))
        : Promise.reject(new Error("timeout")),
  });
  await store.ensure("legacy-dev-1");
  store.scheduleRetry("legacy-dev-1", () => assert.fail("legacy never retries"), () => true);
  assert.equal(clock.pending().length, 0);

  store.scheduleRetry("dev-a", () => assert.fail("A superseded"), () => true);
  const aTimer = clock.pending()[0];
  assert.equal(aTimer?.ms, 3000);
  store.scheduleRetry("dev-b", () => assert.fail("B not fired here"), () => true);
  assert.equal(aTimer.cancelled, true);
  assert.equal(clock.pending().length, 1);
  assert.equal(clock.pending()[0]?.ms, 3000);
});

test("retry that finds the capability already settled skips the repaint", async () => {
  let fail = true;
  const { clock, store } = buildHarness({
    respond: () => (fail ? Promise.reject(new Error("timeout")) : Promise.resolve(OPTIONS)),
  });
  await store.ensure("dev");
  let settled = 0;
  store.scheduleRetry("dev", () => settled++, () => true);
  fail = false;
  await store.ensure("dev");
  await clock.fireNext();
  assert.equal(settled, 0);
  assert.equal(clock.pending().length, 0);
});

test("retry landing a legacy settle still fires the repaint exactly once", async () => {
  let fail = true;
  const { clock, store } = buildHarness({
    respond: () =>
      fail
        ? Promise.reject(new Error("timeout"))
        : Promise.reject(new Error("unknown action: listComposerOptions")),
  });
  await store.ensure("dev");
  let settled = 0;
  store.scheduleRetry("dev", () => settled++, () => true);
  await clock.fireNext();
  assert.equal(settled, 0);
  fail = false;
  await clock.fireNext();
  assert.equal(settled, 1);
  assert.equal(store.probeOf("dev"), "legacy");
  assert.equal(clock.pending().length, 0);
});

test("version change re-probes and reports the repaint-worthy diff", async () => {
  let version = "1.0.0";
  const { calls, store } = buildHarness({ getVersion: () => version });
  await store.ensure("dev");
  version = "1.1.0";
  assert.equal(await store.ensure("dev"), true);
  assert.equal(calls.length, 2);
});
