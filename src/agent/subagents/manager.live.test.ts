import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { StreamEvent } from "../../llm/streamEvents.js";
import type { Session } from "../../session/types.js";
import type { PermissionGateState } from "../../tools/types.js";
import type { RunAgentTurnInput, RunAgentTurnResult } from "../types.js";
import { SubagentManager } from "./manager.js";
import { SUBAGENT_LIVE_MAX_TEXT_CHARS } from "./constants.js";

/**
 * Live monitor forwarding (`subagent_live`): throttled text deltas, tool
 * call/finish lines, reasoning suppression, terminal flush. Uses a fake
 * runTurn that replays child stream events through the captured onEvent.
 */

let sessionSeq = 0;

function fakeParentSession(): Session {
  sessionSeq += 1;
  return {
    id: `parent-session-${sessionSeq}`,
    type: "agent",
    title: "parent",
    createdAt: 0,
    updatedAt: 0,
    status: "idle",
    progressText: "",
    messages: [],
    model: "test-model",
    providerId: "test-provider",
    workspaceId: "ws",
    workspacePath: "/tmp",
    pinned: false,
    archived: false,
    archivedAt: null,
    contextUsage: { usedTokens: 0 },
    plan: null,
  };
}

type LiveEvent = Extract<StreamEvent, { type: "subagent_live" }>;

type Harness = {
  manager: SubagentManager;
  events: StreamEvent[];
  onEvent: ((event: StreamEvent) => void) | undefined;
  finishRun: (status?: RunAgentTurnResult["status"]) => Promise<void>;
};

/**
 * Build a manager whose single child run stays in flight until finishRun().
 * `fire` runs against the captured child onEvent while the run is live.
 */
async function startLiveRun(
  name: string,
  fire: (emit: (event: StreamEvent) => void) => void,
): Promise<Harness> {
  const events: StreamEvent[] = [];
  let captured: ((event: StreamEvent) => void) | undefined;
  let finishRun!: (status?: RunAgentTurnResult["status"]) => void;
  const gate = { mode: "allow" } as unknown as PermissionGateState;
  const manager = new SubagentManager({
    parentSession: fakeParentSession(),
    client: {} as never,
    gate,
    createId: (() => {
      let n = 0;
      return () => `id-${(n += 1)}`;
    })(),
    subagentSystemPrompt: "test system prompt",
    onParentEvent: (event) => events.push(event),
    runTurn: async (input: RunAgentTurnInput) => {
      captured = input.onEvent;
      const status = await new Promise<RunAgentTurnResult["status"]>(
        (resolve) => {
          finishRun = (final) => resolve(final ?? "completed");
        },
      );
      return { status, modelIterations: 1 };
    },
  });
  const result = manager.dispatch({
    prompt: `do work for ${name}`,
    batchId: "batch-1",
    name,
    role: "general",
    parentToolCallId: "tc-1",
  });
  assert.equal(result.ok, true);
  assert.ok(captured, "child onEvent captured");
  fire(captured);
  return {
    manager,
    events,
    onEvent: captured,
    finishRun: (status) => Promise.resolve(finishRun(status)),
  };
}

function liveEvents(events: StreamEvent[]): LiveEvent[] {
  return events.filter(
    (event): event is LiveEvent => event.type === "subagent_live",
  );
}

/** Index access with a guaranteed-present assertion (noUncheckedIndexedAccess). */
function nth(events: StreamEvent[], index: number): LiveEvent {
  const event = liveEvents(events).at(index);
  assert.ok(event, `expected a subagent_live event at index ${index}`);
  return event;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("SubagentManager live forwarding", () => {
  it("flushes buffered text as one delta on run completion", async () => {
    const h = await startLiveRun("alpha", (emit) => {
      emit({ type: "text_delta", text: "hello " });
      emit({ type: "text_delta", text: "world" });
    });
    // Same 120ms window — nothing flushed while the run is mid-flight.
    await wait(30);
    assert.equal(liveEvents(h.events).length, 0);
    await h.finishRun("completed");
    // cleanupLive runs in the manager's finally block — one macrotask later.
    await wait(15);
    assert.equal(liveEvents(h.events).length, 1);
    const live = nth(h.events, 0);
    assert.equal(live.kind, "delta");
    assert.equal(live.text, "hello world");
    assert.equal(live.name, "alpha");
    // Tail flush happens in cleanupLive, after run.status turned terminal.
    assert.equal(live.status, "completed");
  });

  it("flushes on the ~120ms throttle timer mid-run, then again per window", async () => {
    const h = await startLiveRun("bravo", (emit) => {
      emit({ type: "text_delta", text: "one" });
    });
    await wait(180);
    assert.equal(liveEvents(h.events).length, 1);
    assert.equal(nth(h.events, 0).text, "one");
    h.onEvent?.({ type: "text_delta", text: "two" });
    await wait(180);
    assert.equal(liveEvents(h.events).length, 2);
    assert.equal(nth(h.events, 1).text, "two");
    await h.finishRun("completed");
    assert.equal(liveEvents(h.events).length, 2);
  });

  it("emits tool lines with summaries and finish flips", async () => {
    const h = await startLiveRun("charlie", (emit) => {
      emit({
        type: "tool_call",
        id: "tool-1",
        name: "read_file",
        arguments: { path: "/tmp/notes.md", offset: 1 },
        argumentsRaw: "",
      });
    });
    let live = nth(h.events, 0);
    assert.equal(live.kind, "tool");
    assert.equal(live.tool?.id, "tool-1");
    assert.equal(live.tool?.name, "read_file");
    assert.ok(live.tool?.summary.includes("/tmp/notes.md"));
    assert.equal(live.tool?.finished, false);
    h.onEvent?.({ type: "tool_finished", id: "tool-1", messageId: "m-1" });
    assert.equal(liveEvents(h.events).length, 2);
    live = nth(h.events, 1);
    assert.equal(live.tool?.id, "tool-1");
    assert.equal(live.tool?.finished, true);
    await h.finishRun("completed");
  });

  it("surfaces unknown tool finishes with a placeholder line", async () => {
    const h = await startLiveRun("delta", (emit) => {
      emit({ type: "tool_finished", id: "missed-tool", messageId: "m-1" });
    });
    const live = nth(h.events, 0);
    assert.equal(live.tool?.id, "missed-tool");
    assert.equal(live.tool?.finished, true);
    assert.equal(live.tool?.name, "");
    await h.finishRun("completed");
  });

  it("forwards reasoning_delta as a separate kind from prose", async () => {
    const h = await startLiveRun("echo", (emit) => {
      emit({ type: "reasoning_delta", text: "thinking..." });
      emit({ type: "text_delta", text: "answer" });
    });
    await wait(160);
    // Kind switch flushed reasoning before buffering the prose; prose rides
    // its own 120ms window (or the terminal flush below).
    await h.finishRun("completed");
    await wait(15);
    const live = liveEvents(h.events);
    assert.equal(live.length, 2);
    assert.equal(live[0]?.kind, "reasoning");
    assert.equal(live[0]?.text, "thinking...");
    assert.equal(live[1]?.kind, "delta");
    assert.equal(live[1]?.text, "answer");
  });

  it("caps a flushed delta payload at SUBAGENT_LIVE_MAX_TEXT_CHARS", async () => {
    const big = "a".repeat(SUBAGENT_LIVE_MAX_TEXT_CHARS + 500);
    const h = await startLiveRun("foxtrot", (emit) => {
      emit({ type: "text_delta", text: big });
    });
    await h.finishRun("error");
    await wait(15);
    const live = nth(h.events, 0);
    assert.equal(live.text?.length, SUBAGENT_LIVE_MAX_TEXT_CHARS);
    assert.ok(live.text?.endsWith("…"));
  });

  it("cleans up live state so a late timer cannot double-flush", async () => {
    const h = await startLiveRun("golf", (emit) => {
      emit({ type: "text_delta", text: "tail" });
    });
    await h.finishRun("cancelled");
    await wait(15);
    // Cleanup flushed the tail immediately; a stale 120ms timer must not
    // produce a second event.
    await wait(180);
    assert.equal(liveEvents(h.events).length, 1);
    assert.equal(nth(h.events, 0).text, "tail");
    h.manager.dispose();
  });
});
