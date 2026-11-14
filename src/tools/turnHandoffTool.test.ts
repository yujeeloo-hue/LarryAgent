import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { FsmGraphRecordLike } from "./fsmGraphTool.js";
import {
  runTurnHandoffTool,
  type TurnHandoffPort,
  type TurnHandoffRequest,
} from "./turnHandoffTool.js";

/**
 * Pure in-memory port — no agent/fsm imports (isolation.boundaries forbids
 * static agent/fsm imports in src/tools, tests included).
 */
function makeHarness(options?: {
  handoffEnabled?: boolean;
  graphs?: Array<Partial<FsmGraphRecordLike> & { id: string }>;
}) {
  const graphs = new Map<string, FsmGraphRecordLike>();
  for (const g of options?.graphs ?? []) {
    graphs.set(g.id, {
      id: g.id,
      name: g.name ?? g.id,
      origin: g.origin ?? "user",
      enabled: g.enabled ?? true,
      config: g.config ?? {},
      ...(g.description !== undefined ? { description: g.description } : {}),
    });
  }
  const queued = new Map<string, TurnHandoffRequest>();
  const calls: Array<{ method: string; sessionId: string }> = [];

  const port: TurnHandoffPort = {
    isHandoffEnabled: (sessionId) => {
      calls.push({ method: "isHandoffEnabled", sessionId });
      return options?.handoffEnabled === true;
    },
    getFsmGraph: async (id) => graphs.get(id) ?? null,
    queueHandoff: (sessionId, handoff) => {
      calls.push({ method: "queueHandoff", sessionId });
      const replaced = queued.has(sessionId);
      queued.set(sessionId, handoff);
      return { replaced };
    },
    cancelHandoff: (sessionId) => {
      calls.push({ method: "cancelHandoff", sessionId });
      const cancelled = queued.delete(sessionId);
      return { cancelled };
    },
  };
  return { port, queued, calls };
}

const ENABLED_GRAPHS = {
  handoffEnabled: true,
  graphs: [
    { id: "g-on", name: "Alpha Graph", enabled: true },
    { id: "g-off", name: "Beta Graph", enabled: false },
  ],
};

describe("turn_handoff tool contract", () => {
  it("rejects a missing/unknown action before touching the gate", async () => {
    const { port, calls } = makeHarness(ENABLED_GRAPHS);
    for (const action of [undefined, "", "  ", "run", "QUEUE"]) {
      const res = await runTurnHandoffTool({ action }, "s1", port);
      assert.equal(res.ok, false);
      assert.match(res.error ?? "", /action must be one of: queue, cancel/);
      assert.equal(res.code, undefined);
    }
    assert.equal(calls.length, 0);
  });

  it("fails with handoff_disabled when the session gate is off", async () => {
    const { port } = makeHarness({ handoffEnabled: false });
    const res = await runTurnHandoffTool(
      { action: "queue", graphId: "g-on", prompt: "next" },
      "s1",
      port,
    );
    assert.equal(res.ok, false);
    assert.equal(res.code, "handoff_disabled");
    assert.match(res.error ?? "", /composer/);
  });

  it("checks the session gate before any graph validation", async () => {
    const { port } = makeHarness({ handoffEnabled: false });
    // Garbage ids would produce invalid/graph errors if the gate were last.
    const res = await runTurnHandoffTool(
      { action: "queue", graphId: "", prompt: "" },
      "s1",
      port,
    );
    assert.equal(res.code, "handoff_disabled");
  });

  it("validates graphId and prompt (blank strings rejected)", async () => {
    const { port } = makeHarness(ENABLED_GRAPHS);
    const noGraph = await runTurnHandoffTool(
      { action: "queue", graphId: "   ", prompt: "next" },
      "s1",
      port,
    );
    assert.equal(noGraph.ok, false);
    assert.match(noGraph.error ?? "", /non-empty graphId/);

    const noPrompt = await runTurnHandoffTool(
      { action: "queue", graphId: "g-on", prompt: " \n " },
      "s1",
      port,
    );
    assert.equal(noPrompt.ok, false);
    assert.match(noPrompt.error ?? "", /non-empty prompt/);
  });

  it("rejects a missing graph with graph_not_found", async () => {
    const { port } = makeHarness(ENABLED_GRAPHS);
    const res = await runTurnHandoffTool(
      { action: "queue", graphId: "nope", prompt: "next" },
      "s1",
      port,
    );
    assert.equal(res.ok, false);
    assert.equal(res.code, "graph_not_found");
    assert.match(res.error ?? "", /nope/);
  });

  it("rejects a disabled graph with graph_disabled", async () => {
    const { port } = makeHarness(ENABLED_GRAPHS);
    const res = await runTurnHandoffTool(
      { action: "queue", graphId: "g-off", prompt: "next" },
      "s1",
      port,
    );
    assert.equal(res.ok, false);
    assert.equal(res.code, "graph_disabled");
    assert.match(res.error ?? "", /Beta Graph/);
    assert.match(res.error ?? "", /g-off/);
  });

  it("queues a validated handoff and reports graph name + trim", async () => {
    const { port, queued } = makeHarness(ENABLED_GRAPHS);
    const res = await runTurnHandoffTool(
      { action: "queue", graphId: " g-on ", prompt: "  do the thing  " },
      "s1",
      port,
    );
    assert.equal(res.ok, true);
    assert.equal(res.queued, true);
    assert.equal(res.graphId, "g-on");
    assert.equal(res.graphName, "Alpha Graph");
    assert.equal(res.replaced, undefined);
    assert.match(res.note ?? "", /queued — starts automatically/);
    assert.match(res.note ?? "", /full-permissions/);
    assert.deepEqual(queued.get("s1"), { graphId: "g-on", prompt: "do the thing" });
  });

  it("passes an optional note through to the queue slot", async () => {
    const { port, queued } = makeHarness(ENABLED_GRAPHS);
    const res = await runTurnHandoffTool(
      { action: "queue", graphId: "g-on", prompt: "next", note: " 阶段二 " },
      "s1",
      port,
    );
    assert.equal(res.ok, true);
    assert.deepEqual(queued.get("s1"), {
      graphId: "g-on",
      prompt: "next",
      note: "阶段二",
    });
  });

  it("queue is last-wins and reports replaced on the second call", async () => {
    const { port, queued } = makeHarness(ENABLED_GRAPHS);
    await runTurnHandoffTool(
      { action: "queue", graphId: "g-on", prompt: "first" },
      "s1",
      port,
    );
    const res = await runTurnHandoffTool(
      { action: "queue", graphId: "g-on", prompt: "second" },
      "s1",
      port,
    );
    assert.equal(res.ok, true);
    assert.equal(res.replaced, true);
    assert.equal(queued.get("s1")?.prompt, "second");
  });

  it("cancel reports whether a handoff was queued", async () => {
    const { port } = makeHarness(ENABLED_GRAPHS);
    const empty = await runTurnHandoffTool({ action: "cancel" }, "s1", port);
    assert.deepEqual(empty, { ok: true, cancelled: false });

    await runTurnHandoffTool(
      { action: "queue", graphId: "g-on", prompt: "next" },
      "s1",
      port,
    );
    const res = await runTurnHandoffTool({ action: "cancel" }, "s1", port);
    assert.deepEqual(res, { ok: true, cancelled: true });
  });

  it("cancel also respects the session gate", async () => {
    const { port } = makeHarness({ handoffEnabled: false });
    const res = await runTurnHandoffTool({ action: "cancel" }, "s1", port);
    assert.equal(res.ok, false);
    assert.equal(res.code, "handoff_disabled");
  });

  it("never throws — port failures land in { ok: false }", async () => {
    const { port } = makeHarness(ENABLED_GRAPHS);
    port.getFsmGraph = async () => {
      throw new Error("db exploded");
    };
    const res = await runTurnHandoffTool(
      { action: "queue", graphId: "g-on", prompt: "next" },
      "s1",
      port,
    );
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /db exploded/);

    // Graph resolves fine; host queueHandoff throws → still resolved.
    port.getFsmGraph = async (id) => ({
      id,
      name: id,
      enabled: true,
      origin: "user",
      config: {},
    });
    port.queueHandoff = () => {
      throw new Error("Unknown session: s1");
    };
    const res2 = await runTurnHandoffTool(
      { action: "queue", graphId: "g-on", prompt: "next" },
      "s1",
      port,
    );
    assert.equal(res2.ok, false);
    assert.match(res2.error ?? "", /Unknown session/);
  });
});
