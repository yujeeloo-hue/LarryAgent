/**
 * DOM tests: conversation snapshot render-relevance fingerprint — the idle
 * resync burst (done + status:idle staggered retries [400,1000,1600]ms)
 * must not rebuild the conversation view when the fetched snapshot is
 * render-identical to the one behind the current DOM (each rebuild
 * re-pins the scroll bottom → visible bouncing). A tool_result landing
 * late in the store, a plan flip, a status change or a fresh pending ask
 * must still invalidate.
 */
import { parseHTML } from "linkedom";
import test from "node:test";
import assert from "node:assert/strict";

const dom = parseHTML("<!doctype html><html><body></body></html>");
(Object.assign(globalThis, {
  document: dom.document,
  window: dom.window,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
}));

const { RenderRelevance, sessionRenderFingerprint } = await import("../src/sessionRenderState.js");
import type { Session } from "../src/types.js";

type Part = Session["messages"][number]["parts"][number];

function session(over: Partial<Session> = {}): Session {
  return {
    id: "s1",
    type: "agent",
    title: "Test session",
    createdAt: 0,
    updatedAt: 0,
    status: "idle",
    progressText: "",
    messages: [
      { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }], createdAt: 0 },
      {
        id: "m2",
        role: "assistant",
        parts: [{ type: "text", text: "hello" }],
        createdAt: 0,
      },
    ],
    model: "test-model",
    providerId: "p1",
    workspaceId: "w1",
    workspacePath: "/w",
    pinned: false,
    archived: false,
    archivedAt: null,
    contextUsage: { usedTokens: 0 },
    plan: null,
    ...over,
  } as Session;
}

test("identical snapshot after a render matches (resync retries skip rebuild)", () => {
  const rel = new RenderRelevance();
  const snap = session();
  rel.rendered(snap);
  assert.equal(rel.matches(snap), true, "same snapshot → already rendered");
  // Deep-identical clone (fresh object identity, same content).
  assert.equal(rel.matches(session()), true, "content identity is what matters, not reference");
});

test("fresh view never matches until rendered()", () => {
  const rel = new RenderRelevance();
  assert.equal(rel.matches(session()), false, "null fingerprint always rebuilds");
});

test("reset() forgets the baseline (view switch / load failure)", () => {
  const rel = new RenderRelevance();
  const snap = session();
  rel.rendered(snap);
  rel.reset();
  assert.equal(rel.matches(snap), false);
});

test("late tool_result landing invalidates (done-vs-store write race)", () => {
  const rel = new RenderRelevance();
  rel.rendered(session());
  const raced = session({
    messages: [
      { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }], createdAt: 0 },
      {
        id: "m2",
        role: "assistant",
        parts: [
          { type: "tool_call", id: "t1", name: "run_shell", status: "completed", arguments: {}, argumentsRaw: "" },
        ],
        createdAt: 0,
      },
      {
        id: "m3",
        role: "tool",
        toolCallId: "t1",
        parts: [{ type: "tool_result", toolCallId: "t1", content: [{ type: "text", text: "ok" }], returnCode: 0 }],
        createdAt: 0,
      },
    ] as Session["messages"],
  });
  assert.equal(rel.matches(raced), false, "new tool_result row must rebuild");
  rel.rendered(raced);
  assert.equal(rel.matches(raced), true);
});

test("tool_call status flip running → completed invalidates", () => {
  const rel = new RenderRelevance();
  const base = session({
    messages: [
      {
        id: "m2",
        role: "assistant",
        parts: [{ type: "tool_call", id: "t1", name: "run_shell", status: "running", arguments: {}, argumentsRaw: "" }],
        createdAt: 0,
      },
    ] as Session["messages"],
  });
  rel.rendered(base);
  const done = session({
    messages: [
      {
        id: "m2",
        role: "assistant",
        parts: [{ type: "tool_call", id: "t1", name: "run_shell", status: "completed", arguments: {}, argumentsRaw: "" }],
        createdAt: 0,
      },
    ] as Session["messages"],
  });
  assert.equal(rel.matches(done), false);
});

test("status, pending ask, plan approval, composer prefs all invalidate", () => {
  const rel = new RenderRelevance();
  const snap = session();
  rel.rendered(snap);

  assert.equal(rel.matches(session({ status: "running" })), false, "status flip (idle→running)");
  assert.equal(rel.matches(session({ pendingUserAsk: { requestId: "r1" } as Session["pendingUserAsk"] })), false, "new ask");

  const plan: NonNullable<Session["plan"]> = {
    id: "plan1",
    title: "Fix bounce",
    status: "active",
    steps: [{ id: "st1", title: "Fix", status: "completed" }],
    createdAt: 0,
    updatedAt: 0,
    createToolCallId: "c1",
    planDoc: { path: "docs/plans/x.md", summary: "s", updatedAt: 1, approvalPending: true },
  };
  assert.equal(rel.matches(session({ plan })), false, "plan appears");

  rel.rendered(session({ plan }));
  const approved = session({ plan: { ...plan, planDoc: { ...plan.planDoc!, approvalPending: false, approvedRevision: "r2" } } });
  assert.equal(rel.matches(approved), false, "approval settled");

  assert.equal(rel.matches(session({ reasoningEffort: "max" })), false, "effort dial");
  assert.equal(rel.matches(session({ composerInfinite: true })), false, "infinite toggle");
  assert.equal(rel.matches(session({ model: "other-model" })), false, "model fallback label");
});

test("non-rendered fields never invalidate (title, context usage, timestamps)", () => {
  const rel = new RenderRelevance();
  rel.rendered(session());
  assert.equal(
    rel.matches(session({ title: "Renamed", updatedAt: 123456, contextUsage: { usedTokens: 900 } })),
    true,
    "gauge/usage/title updates ride their own paths",
  );
});

test("unknown part kinds invalidate stably (no silent skip)", () => {
  const rel = new RenderRelevance();
  rel.rendered(session());
  const exotic = session({
    messages: [
      { id: "m1", role: "user", parts: [{ type: "brand_new_part", z: 1 } as unknown as Part], createdAt: 0 },
    ] as Session["messages"],
  });
  assert.equal(rel.matches(exotic), false);
  rel.rendered(exotic);
  assert.equal(rel.matches(exotic), true, "stable across key reordering");
  const reordered = session({
    messages: [
      { id: "m1", role: "user", parts: [{ z: 1, type: "brand_new_part" } as unknown as Part], createdAt: 0 },
    ] as Session["messages"],
  });
  assert.equal(rel.matches(reordered), true, "key order is normalized");
});

test("compaction markers and reasoning stats participate", () => {
  const rel = new RenderRelevance();
  rel.rendered(session());
  const compacted = session({
    messages: [
      {
        id: "m0",
        role: "user",
        parts: [{ type: "context_compaction", id: "cp1", summary: "folded", fromMessageId: "a", toMessageId: "b", usedTokensBefore: 10, usedTokensAfter: 5 }],
        createdAt: 0,
      },
    ] as Session["messages"],
  });
  assert.equal(rel.matches(compacted), false);

  rel.rendered(compacted);
  const reasoning = session({
    messages: [
      { id: "m2", role: "assistant", parts: [{ type: "reasoning", text: "thought", durationMs: 1200, tokenCount: 30 }], createdAt: 0 },
    ] as Session["messages"],
  });
  assert.equal(rel.matches(reasoning), false);
});

test("cross-session fingerprints never collide", () => {
  assert.notEqual(sessionRenderFingerprint(session()), sessionRenderFingerprint(session({ id: "s2" })));
  // Message count is in the fingerprint, not just the joined sigs.
  assert.notEqual(
    sessionRenderFingerprint(session()),
    sessionRenderFingerprint(session({ messages: [] as Session["messages"] })),
  );
});
