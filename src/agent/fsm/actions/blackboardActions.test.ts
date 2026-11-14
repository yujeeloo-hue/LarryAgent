import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FsmHostCapabilities } from "../FsmHostCapabilities.js";
import type { NodeActionExecArgs } from "../types.js";
import { NodeActionReadBlackboard } from "./NodeActionReadBlackboard.js";
import { NodeActionWriteBlackboard } from "./NodeActionWriteBlackboard.js";

function hostWithBlackboard(
  store: Record<string, unknown>,
  failSet?: string,
): FsmHostCapabilities {
  return {
    blackboardGet: (key: string) => store[key],
    blackboardSet: (key: string, value: unknown) => {
      if (failSet) return { ok: false as const, error: failSet };
      store[key] = value;
      return { ok: true as const };
    },
  } as unknown as FsmHostCapabilities;
}

function makeArgs(
  turnContext: Record<string, unknown> = {},
  host?: FsmHostCapabilities,
  nodeContext: Record<string, unknown> = {},
): NodeActionExecArgs {
  return host
    ? { turnContext, nodeContext, host }
    : { turnContext, nodeContext };
}

describe("NodeActionWriteBlackboard", () => {
  it("set writes any JSON value to turnContext", () => {
    const action = new NodeActionWriteBlackboard({ key: "target", value: 42 });
    const out = action.Exec(makeArgs());
    assert.equal(out.status, "continue");
    assert.deepEqual(out.turnContextPatch, { target: 42 });

    const obj = new NodeActionWriteBlackboard({
      key: "payload",
      value: { ok: true, tags: ["a"] },
    });
    assert.deepEqual(obj.Exec(makeArgs()).turnContextPatch, {
      payload: { ok: true, tags: ["a"] },
    });
  });

  it("increment starts from 0 on a missing key and adds numeric operands", () => {
    const fresh = new NodeActionWriteBlackboard({
      key: "count",
      value: 1,
      mode: "increment",
    });
    assert.deepEqual(fresh.Exec(makeArgs()).turnContextPatch, { count: 1 });

    // No operand → counter bump defaults to +1.
    const bump = new NodeActionWriteBlackboard({
      key: "count",
      mode: "increment",
    });
    assert.deepEqual(bump.Exec(makeArgs({ count: 5 })).turnContextPatch, {
      count: 6,
    });
    assert.deepEqual(bump.Exec(makeArgs()).turnContextPatch, { count: 1 });

    const add = new NodeActionWriteBlackboard({
      key: "count",
      value: 2,
      mode: "increment",
    });
    assert.deepEqual(add.Exec(makeArgs({ count: 5 })).turnContextPatch, {
      count: 7,
    });

    const fromString = new NodeActionWriteBlackboard({
      key: "count",
      value: 2,
      mode: "increment",
    });
    assert.deepEqual(fromString.Exec(makeArgs({ count: "5" })).turnContextPatch, {
      count: 7,
    });
  });

  it("set without a value is an authoring halt", () => {
    const action = new NodeActionWriteBlackboard({ key: "k", mode: "set" });
    const out = action.Exec(makeArgs());
    assert.equal(out.status, "halt");
    assert.match(out.errorMessage ?? "", /mode "set" requires a value/);
  });

  it("increment halts on non-numeric current values and operands", () => {
    const badCurrent = new NodeActionWriteBlackboard({
      key: "count",
      value: 1,
      mode: "increment",
    });
    const out = badCurrent.Exec(makeArgs({ count: "abc" }));
    assert.equal(out.status, "halt");
    assert.match(out.errorMessage ?? "", /not a number/);

    const badOperand = new NodeActionWriteBlackboard({
      key: "count",
      value: "x",
      mode: "increment",
    });
    assert.match(
      badOperand.Exec(makeArgs({ count: 1 })).errorMessage ?? "",
      /numeric value operand/,
    );

    const boolCurrent = new NodeActionWriteBlackboard({
      key: "flag",
      value: 1,
      mode: "increment",
    });
    assert.equal(boolCurrent.Exec(makeArgs({ flag: true })).status, "halt");
  });

  it("multiply requires an existing numeric value and rejects non-finite results", () => {
    const missing = new NodeActionWriteBlackboard({
      key: "score",
      value: 2,
      mode: "multiply",
    });
    const missingOut = missing.Exec(makeArgs());
    assert.equal(missingOut.status, "halt");
    assert.match(missingOut.errorMessage ?? "", /multiply requires an existing/);

    const ok = new NodeActionWriteBlackboard({
      key: "score",
      value: 4,
      mode: "multiply",
    });
    assert.deepEqual(ok.Exec(makeArgs({ score: 3 })).turnContextPatch, {
      score: 12,
    });

    const overflow = new NodeActionWriteBlackboard({
      key: "score",
      value: 10,
      mode: "multiply",
    });
    const overflowOut = overflow.Exec(makeArgs({ score: 1e308 }));
    assert.equal(overflowOut.status, "halt");
    assert.match(overflowOut.errorMessage ?? "", /non-finite/);
  });

  it("reserved and malformed keys always halt (never strict-dependent)", () => {
    const reserved = new NodeActionWriteBlackboard({
      key: "routeTarget",
      value: 1,
    });
    assert.match(reserved.Exec(makeArgs()).errorMessage ?? "", /reserved/);

    const malformed = new NodeActionWriteBlackboard({
      key: "9bad",
      value: 1,
    });
    assert.match(malformed.Exec(makeArgs()).errorMessage ?? "", /must match/);
  });

  it("session scope writes through the host capability", () => {
    const store: Record<string, unknown> = { hits: 4 };
    const action = new NodeActionWriteBlackboard({
      key: "hits",
      value: 1,
      mode: "increment",
      scope: "session",
    });
    const out = action.Exec(makeArgs({}, hostWithBlackboard(store)));
    assert.equal(out.status, "continue");
    assert.equal(out.turnContextPatch, undefined);
    assert.equal(store.hits, 5);
  });

  it("session scope surfaces host set failures as named halts", () => {
    const action = new NodeActionWriteBlackboard({
      key: "hits",
      value: 1,
      scope: "session",
    });
    const out = action.Exec(
      makeArgs({}, hostWithBlackboard({}, "disk full")),
    );
    assert.equal(out.status, "halt");
    assert.match(out.errorMessage ?? "", /disk full/);
  });

  it("session scope without a host capability degrades per strict", () => {
    const lax = new NodeActionWriteBlackboard({
      key: "hits",
      value: 1,
      scope: "session",
    });
    const laxOut = lax.Exec(makeArgs());
    assert.equal(laxOut.status, "continue");
    assert.equal(laxOut.turnContextPatch, undefined);

    const strict = new NodeActionWriteBlackboard({
      key: "hits",
      value: 1,
      scope: "session",
      strict: true,
    });
    const strictOut = strict.Exec(makeArgs());
    assert.equal(strictOut.status, "halt");
    assert.match(strictOut.errorMessage ?? "", /capability is not available/);
  });
});

describe("NodeActionReadBlackboard", () => {
  it("materializes turn values under asKey (defaults to key)", () => {
    const plain = new NodeActionReadBlackboard({ key: "k" });
    assert.deepEqual(plain.Exec(makeArgs({ k: "v" })).turnContextPatch, {
      k: "v",
    });

    const renamed = new NodeActionReadBlackboard({
      key: "k",
      asKey: "alias",
    });
    assert.deepEqual(renamed.Exec(makeArgs({ k: "v" })).turnContextPatch, {
      alias: "v",
    });
  });

  it("missing keys skip quietly unless strict", () => {
    const lax = new NodeActionReadBlackboard({ key: "missing" });
    const laxOut = lax.Exec(makeArgs());
    assert.equal(laxOut.status, "continue");
    assert.equal(laxOut.turnContextPatch, undefined);

    const strict = new NodeActionReadBlackboard({ key: "missing", strict: true });
    const strictOut = strict.Exec(makeArgs());
    assert.equal(strictOut.status, "halt");
    assert.match(strictOut.errorMessage ?? "", /not set/);
  });

  it("session scope reads through the host capability", () => {
    const store: Record<string, unknown> = { token: "abc" };
    const action = new NodeActionReadBlackboard({
      key: "token",
      scope: "session",
    });
    assert.deepEqual(
      action.Exec(makeArgs({}, hostWithBlackboard(store))).turnContextPatch,
      { token: "abc" },
    );
  });

  it("session scope without a host capability degrades per strict", () => {
    const strict = new NodeActionReadBlackboard({
      key: "token",
      scope: "session",
      strict: true,
    });
    assert.equal(strict.Exec(makeArgs()).status, "halt");

    const lax = new NodeActionReadBlackboard({
      key: "token",
      scope: "session",
    });
    assert.equal(lax.Exec(makeArgs()).status, "continue");
  });

  it("reserved asKey is rejected", () => {
    const action = new NodeActionReadBlackboard({
      key: "k",
      asKey: "haltResult",
    });
    assert.match(action.Exec(makeArgs({ k: 1 })).errorMessage ?? "", /reserved/);
  });

  it("plain read leaves nodeContext untouched (injection lives in PromptInject)", () => {
    const action = new NodeActionReadBlackboard({ key: "mode" });
    const out = action.Exec(makeArgs({ mode: "fast" }));
    assert.equal(out.status, "continue");
    assert.deepEqual(out.turnContextPatch, { mode: "fast" });
    assert.equal(out.nodeContextPatch, undefined);
  });
});
