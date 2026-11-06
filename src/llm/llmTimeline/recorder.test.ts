import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { StreamEvent } from "../streamEvents.js";
import {
  beginLlmTimelineEntry,
  beginToolTimelineEntry,
  clearLlmTimeline,
  listLlmTimeline,
  recordUserPrompt,
  setLlmTimelineCapacity,
  subscribeLlmTimeline,
} from "./recorder.js";

const SESSION = "session-timeline-test";

afterEach(() => {
  clearLlmTimeline();
  setLlmTimelineCapacity(5_000);
});

function begin(
  partial?: { sessionId?: string; stream?: boolean; reqRaw?: string },
) {
  const entry = beginLlmTimelineEntry({
    sessionId: partial?.sessionId ?? SESSION,
    purpose: "chat",
    iteration: 2,
    model: "deepseek-v4-pro",
    stream: partial?.stream ?? true,
    messageCount: 7,
    toolDefCount: 3,
    ...(partial?.reqRaw !== undefined ? { reqRaw: partial.reqRaw } : {}),
  });
  assert.ok(entry, "entry should be created for a non-empty sessionId");
  return entry;
}

function firstRecord(sessionId = SESSION) {
  const snapshot = listLlmTimeline(sessionId);
  const record = snapshot.records[0];
  assert.ok(record, "snapshot should contain the record");
  if (record.kind !== "llm") {
    throw new Error(`expected an llm record, got ${record.kind}`);
  }
  return record;
}

describe("llm timeline recorder", () => {
  it("returns null without a sessionId and records nothing", () => {
    assert.equal(beginLlmTimelineEntry({ sessionId: "", model: "m", stream: true, messageCount: 1, toolDefCount: 0 }), null);
    assert.equal(listLlmTimeline(SESSION).records.length, 0);
  });

  it("stores an in-flight record at begin and emits updates", () => {
    const events: string[] = [];
    const unsubscribe = subscribeLlmTimeline((sessionId) => {
      events.push(sessionId);
    });
    const entry = begin();
    const record = firstRecord();
    assert.equal(record.endedAt, null);
    assert.equal(record.durationMs, null);
    assert.equal(record.attempts, 1);
    assert.equal(record.purpose, "chat");
    assert.equal(record.iteration, 2);
    assert.equal(record.stream, true);
    assert.equal(record.messageCount, 7);
    assert.equal(record.toolDefCount, 3);
    assert.deepEqual(events, [SESSION]);

    entry.finish({ doneReason: "completed" });
    unsubscribe();
    assert.equal(events.length, 2);
    const sealed = firstRecord();
    assert.equal(sealed.doneReason, "completed");
    assert.notEqual(sealed.endedAt, null);
    assert.equal(sealed.durationMs, sealed.endedAt! - sealed.startedAt);
  });

  it("accumulates stream event stats via observe()", () => {
    const entry = begin();
    const events: StreamEvent[] = [
      { type: "text_delta", text: "hello " },
      { type: "text_delta", text: "world" },
      { type: "reasoning_delta", text: "thinking" },
      {
        type: "tool_call",
        id: "call-1",
        name: "read_file",
        arguments: {},
        argumentsRaw: "{}",
      },
      {
        type: "tool_call",
        id: "call-2",
        name: "run_shell",
        arguments: {},
        argumentsRaw: "{}",
      },
      {
        type: "usage",
        promptTokens: 100,
        completionTokens: 40,
        totalTokens: 140,
        cachedTokens: 60,
        cacheWriteTokens: 10,
      },
    ];
    for (const event of events) entry.observe(event);
    entry.observe({ type: "error", message: "boom" });
    entry.observe({ type: "done", reason: "error" });
    entry.finish();

    const record = firstRecord();
    assert.equal(record.textChars, 11);
    assert.equal(record.reasoningChars, 8);
    assert.equal(record.toolCallCount, 2);
    assert.deepEqual(record.toolNames, ["read_file", "run_shell"]);
    assert.equal(record.promptTokens, 100);
    assert.equal(record.completionTokens, 40);
    assert.equal(record.totalTokens, 140);
    assert.equal(record.cachedTokens, 60);
    assert.equal(record.cacheWriteTokens, 10);
    assert.equal(record.error, "boom");
    assert.equal(record.doneReason, "error");
  });

  it("finish patch fields win over observed ones and finish is idempotent", () => {
    const entry = begin();
    entry.observe({ type: "text_delta", text: "abc" });
    entry.observe({ type: "done", reason: "paused" });
    entry.finish({ doneReason: "completed", textChars: 999, httpStatus: 200 });
    const before = listLlmTimeline(SESSION);
    entry.finish({ doneReason: "cancelled" });
    const after = listLlmTimeline(SESSION);

    const record = after.records[0];
    assert.ok(record);
    if (record.kind !== "llm") throw new Error("expected an llm record");
    assert.equal(record.doneReason, "completed");
    assert.equal(record.textChars, 999);
    assert.equal(record.httpStatus, 200);
    assert.equal(after.records.length, before.records.length);
    assert.equal(after.truncatedCount, 0);
  });

  it("noteRetry keeps the max attempt and noteHttpStatus records the status", () => {
    const entry = begin();
    entry.noteRetry(2);
    entry.noteRetry(3);
    entry.noteRetry(2); // out-of-order / duplicate must not go backwards
    entry.noteHttpStatus(429);
    entry.finish({});
    const record = firstRecord();
    assert.equal(record.attempts, 3);
    assert.equal(record.httpStatus, 429);
  });

  it("ignores observe/notes after finish", () => {
    const entry = begin();
    entry.finish({ doneReason: "completed" });
    entry.observe({ type: "text_delta", text: "late" });
    entry.noteRetry(9);
    entry.noteHttpStatus(500);
    const record = firstRecord();
    assert.equal(record.textChars, undefined);
    assert.equal(record.attempts, 1);
    assert.equal(record.httpStatus, undefined);
  });

  it("captures phase timestamps while observing stream events", () => {
    const entry = begin();
    entry.observe({ type: "status", status: "streaming" }); // local, ignored
    entry.observe({ type: "reasoning_delta", text: "think" });
    entry.observe({ type: "text_delta", text: "answer" });
    entry.observe({ type: "text_delta", text: "!" });
    entry.finish({ doneReason: "completed" });

    const record = firstRecord();
    assert.notEqual(record.firstEventAt, undefined);
    assert.notEqual(record.reasoningStartAt, undefined);
    assert.notEqual(record.reasoningEndAt, undefined);
    assert.notEqual(record.contentStartAt, undefined);
    assert.notEqual(record.contentEndAt, undefined);
    assert.ok(record.firstEventAt! >= record.startedAt);
    assert.ok(record.reasoningStartAt! <= record.contentStartAt!);
    assert.ok(record.contentStartAt! <= record.contentEndAt!);
    assert.ok(record.reasoningEndAt! <= record.endedAt!);
  });

  it("caps raw payloads and strips them once aged out of the recent window", () => {
    const session = "session-raw-test";
    for (let i = 0; i < 305; i++) {
      const entry = begin({ sessionId: session, reqRaw: "x".repeat(40_000) });
      entry.finish();
    }
    const { records } = listLlmTimeline(session);
    assert.equal(records.length, 305);
    const first = records[0];
    assert.ok(first, "first record exists");
    if (first.kind !== "llm") throw new Error("expected an llm record");
    assert.equal(first.reqRaw, undefined, "oldest raw stripped");
    const last = records[records.length - 1];
    assert.ok(last, "last record exists");
    if (last.kind !== "llm") throw new Error("expected an llm record");
    assert.equal(last.reqRaw?.length, 32_768, "newest raw capped at 32KB");
  });

  it("accumulates streamed text raw with the cap", () => {
    const entry = begin();
    for (let i = 0; i < 900; i++) {
      entry.observe({ type: "text_delta", text: "x".repeat(64) });
    }
    entry.finish();
    const record = firstRecord();
    assert.ok(record.textRaw, "textRaw accumulated");
    assert.ok(record.textRaw.length <= 32_768 + 64, "textRaw capped");
    assert.equal(record.textChars, 900 * 64);
  });

  it("stores raw payloads for tool executions and user prompts", () => {
    const session = "session-toolraw-test";
    recordUserPrompt({
      sessionId: session,
      label: "hi",
      promptRaw: "x".repeat(40_000),
    });
    const tool = beginToolTimelineEntry({
      sessionId: session,
      name: "run_shell",
      argsRaw: JSON.stringify({ command: "echo hi" }),
    });
    assert.ok(tool, "tool entry created");
    tool.finish({ status: "success", resultRaw: "hi\n" });
    const { records } = listLlmTimeline(session);
    const toolRecord = records.find((r) => r.kind === "tool");
    assert.ok(toolRecord, "tool record exists");
    if (toolRecord.kind !== "tool") throw new Error("expected a tool record");
    assert.equal(toolRecord.argsRaw, '{"command":"echo hi"}');
    assert.equal(toolRecord.resultRaw, "hi\n");
    const userRecord = records.find((r) => r.kind === "user");
    assert.ok(userRecord, "user record exists");
    if (userRecord.kind !== "user") throw new Error("expected a user record");
    assert.equal(userRecord.promptRaw?.length, 32_768, "promptRaw capped");
  });

  it("keeps isolation between sessions", () => {
    const other = begin({ sessionId: "other-session" });
    begin();
    other.finish({ doneReason: "completed" });
    assert.equal(listLlmTimeline(SESSION).records.length, 1);
    assert.equal(listLlmTimeline("other-session").records.length, 1);
    assert.equal(listLlmTimeline("missing").records.length, 0);
    clearLlmTimeline("other-session");
    assert.equal(listLlmTimeline("other-session").records.length, 0);
  });

  it("clears previous records when a new turn starts", () => {
    const session = "session-turn-reset";
    recordUserPrompt({ sessionId: session, label: "turn 1" });
    const entry = begin({ sessionId: session });
    entry.finish();
    assert.equal(listLlmTimeline(session).records.length, 2);
    recordUserPrompt({ sessionId: session, label: "turn 2" });
    const { records } = listLlmTimeline(session);
    assert.equal(records.length, 1, "previous turn dropped");
    const only = records[0];
    assert.ok(only, "new turn record exists");
    assert.equal(only.kind, "user");
    assert.equal(only.label, "turn 2");
  });

  it("keeps records when a steer prompt lands mid-turn", () => {
    const session = "session-steer";
    recordUserPrompt({ sessionId: session, label: "turn 1" });
    const entry = begin({ sessionId: session });
    entry.finish();
    recordUserPrompt({
      sessionId: session,
      label: "steer · go faster",
      clearPrevious: false,
    });
    assert.equal(
      listLlmTimeline(session).records.length,
      3,
      "turn start + llm + steer all present",
    );
  });

  it("drops the oldest records past the capacity and counts truncation", () => {
    setLlmTimelineCapacity(3);
    for (let i = 0; i < 5; i += 1) {
      const entry = beginLlmTimelineEntry({
        sessionId: SESSION,
        model: `model-${i}`,
        stream: false,
        messageCount: 1,
        toolDefCount: 0,
      });
      assert.ok(entry);
      entry.finish({ doneReason: "completed" });
    }
    const snapshot = listLlmTimeline(SESSION);
    assert.equal(snapshot.records.length, 3);
    assert.equal(snapshot.truncatedCount, 2);
    const oldest = snapshot.records[0];
    assert.ok(oldest);
    if (oldest.kind !== "llm") {
      throw new Error("expected an llm record");
    }
    assert.equal(oldest.model, "model-2");
  });

  it("records tool executions with kind tool, live then sealed", () => {
    const events: string[] = [];
    const unsubscribe = subscribeLlmTimeline((sessionId) => {
      events.push(sessionId);
    });
    const entry = beginToolTimelineEntry({
      sessionId: SESSION,
      name: "run_shell",
      toolCallId: "call-42",
    });
    assert.ok(entry);

    let snapshot = listLlmTimeline(SESSION);
    const live = snapshot.records[0];
    assert.ok(live);
    if (live.kind !== "tool") throw new Error("expected a tool record");
    assert.equal(live.name, "run_shell");
    assert.equal(live.toolCallId, "call-42");
    assert.equal(live.endedAt, null);
    assert.deepEqual(events, [SESSION]);

    entry.finish({ status: "success", returnCode: 0 });
    entry.finish({ status: "success" }); // idempotent
    snapshot = listLlmTimeline(SESSION);
    const sealed = snapshot.records[0];
    assert.ok(sealed);
    if (sealed.kind !== "tool") throw new Error("expected a tool record");
    assert.equal(sealed.status, "success");
    assert.equal(sealed.returnCode, 0);
    assert.notEqual(sealed.endedAt, null);
    assert.equal(sealed.durationMs, sealed.endedAt! - sealed.startedAt);
    assert.equal(events.length, 2);
    unsubscribe();

    assert.equal(beginToolTimelineEntry({ sessionId: "", name: "x" }), null);
  });

  it("records user prompts as sealed zero-duration markers", () => {
    const events: string[] = [];
    const unsubscribe = subscribeLlmTimeline((sessionId) => {
      events.push(sessionId);
    });
    recordUserPrompt({ sessionId: SESSION, label: "帮我看看这个 bug" });
    const snapshot = listLlmTimeline(SESSION);
    const record = snapshot.records[0];
    assert.ok(record);
    if (record.kind !== "user") throw new Error("expected a user record");
    assert.equal(record.label, "帮我看看这个 bug");
    assert.equal(record.endedAt, record.startedAt);
    assert.equal(record.durationMs, 0);
    assert.deepEqual(events, [SESSION]);
    unsubscribe();

    recordUserPrompt({ sessionId: "", label: "no session" }); // no-op
  });

  it("shares one ring buffer across record kinds", () => {
    setLlmTimelineCapacity(3);
    recordUserPrompt({ sessionId: SESSION, label: "p1" });
    for (const name of ["tool-a", "tool-b"]) {
      const entry = beginToolTimelineEntry({ sessionId: SESSION, name });
      assert.ok(entry);
      entry.finish({ status: "success" });
    }
    begin(); // llm record, still in flight

    const snapshot = listLlmTimeline(SESSION);
    assert.equal(snapshot.records.length, 3);
    assert.equal(snapshot.truncatedCount, 1);
    assert.deepEqual(
      snapshot.records.map((record) => record.kind),
      ["tool", "tool", "llm"],
    );
  });
});
