import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { CocoRepository } from "./repository.js";
import { budgetState, CocoBudgetManager, windowKeys } from "./budgetManager.js";
import { defaultSettings } from "./validation.js";
import type { CocoSettings } from "./types.js";

function fixture(overrides: Partial<CocoSettings> = {}) {
  const db = new DatabaseSync(":memory:"), repository = new CocoRepository(db);
  let now = Date.UTC(2026, 9, 28, 2, 10);
  let settings: CocoSettings = { ...defaultSettings(), enabled: true, timezone: "Asia/Shanghai", hourlyTokens: 100, dailyTokens: 1000, ...overrides };
  const manager = new CocoBudgetManager(repository, () => settings, () => now);
  const events: string[] = [];
  manager.on("exhausted", () => events.push("exhausted"));
  manager.on("reset", () => events.push("reset"));
  return {
    manager, repository, events, db,
    advance: (ms: number) => { now += ms; },
    setSettings: (next: Partial<CocoSettings>) => { settings = { ...settings, ...next }; },
    close: () => { manager.stop(); db.close(); },
  };
}

test("crossing the hourly ceiling emits exhausted once, rollover emits reset once", () => {
  const f = fixture();
  f.manager.start();
  f.manager.record({ id: "a", tokens: 60, estimated: false, purpose: "execute" });
  assert.deepEqual(f.events, []);
  assert.equal(f.manager.cooling(), false);
  f.manager.record({ id: "b", tokens: 50, estimated: false, purpose: "execute" });
  assert.deepEqual(f.events, ["exhausted"]);
  const state = f.manager.state();
  assert.equal(state.cooling, true);
  assert.equal(state.unit, "hour");
  assert.equal(state.resumeAt, Date.UTC(2026, 9, 28, 3));
  f.manager.record({ id: "c", tokens: 10, estimated: false, purpose: "verify" });
  f.manager.refresh();
  assert.deepEqual(f.events, ["exhausted"], "already cooling: no duplicate edge");
  f.advance(50 * 60000);
  f.manager.refresh();
  assert.deepEqual(f.events, ["exhausted", "reset"]);
  assert.equal(f.manager.cooling(), false);
  f.manager.refresh();
  assert.deepEqual(f.events, ["exhausted", "reset"], "no duplicate reset");
  f.close();
});

test("clearing the current window lifts cooldown and keeps only older usage", () => {
  const f = fixture();
  f.manager.start();
  f.manager.record({ id: "hour", tokens: 120, estimated: false, purpose: "execute" });
  f.manager.record({ id: "chat", tokens: 80, estimated: false, purpose: "chat" });
  f.manager.record({ id: "yesterday", at: Date.UTC(2026, 9, 27, 2, 10), tokens: 40, estimated: false, purpose: "execute" });
  assert.equal(f.manager.cooling(), true);
  const cleared = f.manager.clearCurrentWindow();
  assert.equal(cleared.cooling, false);
  assert.equal(cleared.hourly, 0);
  assert.equal(cleared.daily, 0);
  assert.equal(cleared.resumeAt, undefined);
  assert.deepEqual(f.events, ["exhausted", "reset"]);
  assert.equal(f.repository.get<{ tokens: number }>("usage", "yesterday")?.tokens, 40);
  assert.equal(f.repository.get("usage", "hour"), undefined);
  assert.equal(f.repository.get("usage", "chat"), undefined, "current-window chat usage is cleared with the reset");
  f.close();
});

test("interactive chat usage counts toward the shared ceiling", () => {
  const f = fixture();
  f.manager.start();
  f.manager.record({ id: "chat", tokens: 500, estimated: false, purpose: "chat" });
  assert.equal(f.manager.state().hourly, 500);
  assert.equal(f.manager.state().daily, 500);
  assert.deepEqual(f.events, ["exhausted"], "chat alone can trip the cooldown");
  assert.equal(f.manager.state().unit, "hour");
  f.close();
});

test("raising the ceiling while cooling emits reset on the next refresh", () => {
  const f = fixture();
  f.manager.start();
  f.manager.record({ id: "a", tokens: 120, estimated: false, purpose: "execute" });
  assert.deepEqual(f.events, ["exhausted"]);
  f.setSettings({ hourlyTokens: 500 });
  f.manager.refresh();
  assert.deepEqual(f.events, ["exhausted", "reset"]);
  f.close();
});

test("the same request id upserts instead of double-counting", () => {
  const f = fixture();
  let changes = 0;
  f.manager.on("changed", () => { changes++; });
  f.manager.start();
  f.manager.record({ id: "r", tokens: 40, estimated: true, purpose: "execute" });
  f.manager.record({ id: "r", tokens: 30, estimated: false, purpose: "execute" });
  assert.equal(f.manager.state().hourly, 30, "a provider count replaces the estimate");
  assert.equal(f.manager.state().estimated, false);
  assert.ok(changes >= 2);
  f.close();
});

test("starting while already over budget reports cooling and emits exhausted on first evaluation", () => {
  const f = fixture();
  f.manager.record({ id: "old", tokens: 200, estimated: false, purpose: "execute" });
  const fresh = new CocoBudgetManager((f.manager as unknown as { repository: CocoRepository }).repository, () => ({ ...defaultSettings(), timezone: "Asia/Shanghai", hourlyTokens: 100, dailyTokens: 1000 }), () => Date.UTC(2026, 9, 28, 2, 20));
  const seen: string[] = [];
  fresh.on("exhausted", () => seen.push("exhausted"));
  fresh.start();
  assert.equal(fresh.cooling(), true);
  assert.deepEqual(seen, ["exhausted"], "first evaluation of an over-budget window is an exhausted edge");
  fresh.stop();
  f.close();
});

test("window bounds match per-row window keys across DST transitions", () => {
  const timezone = "America/New_York";
  const settings: CocoSettings = { ...defaultSettings(), timezone, hourlyTokens: 1, dailyTokens: 1_000_000 };
  // Spring-forward and fall-back days, sampled every 20 minutes.
  for (const startUtc of [Date.UTC(2026, 2, 7, 22), Date.UTC(2026, 10, 0, 22)]) {
    for (let now = startUtc; now < startUtc + 36 * 3600000; now += 20 * 60000) {
      const usage = Array.from({ length: 60 }, (_, i) => ({ id: `u${i}`, at: now - 30 * 3600000 + i * 3600000 + 1234, tokens: 1, estimated: false, purpose: "execute" as const }));
      const keys = windowKeys(now, timezone);
      const day = usage.filter(u => windowKeys(u.at, timezone).day === keys.day);
      let resumeAt = Math.floor(now / 60000) * 60000 + 60000;
      while (windowKeys(resumeAt, timezone).hour === keys.hour) resumeAt += 60000;
      const state = budgetState(usage, settings, now);
      assert.equal(state.daily, day.length, new Date(now).toISOString());
      assert.equal(state.hourly, day.filter(u => windowKeys(u.at, timezone).hour === keys.hour).length, new Date(now).toISOString());
      assert.equal(state.resumeAt, resumeAt, new Date(now).toISOString());
    }
  }
});
