import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseTimelineExport } from "./TimelinePaneController.js";

const record = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "r1",
  sessionId: "s1",
  kind: "llm",
  startedAt: 1_000,
  endedAt: 2_000,
  durationMs: 1_000,
  model: "test-model",
  attempts: 1,
  messageCount: 2,
  toolDefCount: 0,
  stream: true,
  ...over,
});

describe("parseTimelineExport", () => {
  it("accepts a well-formed export and sorts by start time", () => {
    const text = JSON.stringify({
      kind: "jellybot.timeline",
      version: 1,
      truncatedCount: 3,
      records: [
        record({ id: "late", startedAt: 5_000 }),
        record({ id: "early", startedAt: 1_000 }),
      ],
    });
    const parsed = parseTimelineExport(text);
    assert.ok(parsed, "parsed");
    assert.equal(parsed.records.length, 2);
    assert.equal(parsed.records[0]?.id, "early");
    assert.equal(parsed.truncatedCount, 3);
  });

  it("rejects malformed JSON and foreign payloads", () => {
    assert.equal(parseTimelineExport("{not json"), null);
    assert.equal(parseTimelineExport(JSON.stringify({ foo: 1 })), null);
    assert.equal(parseTimelineExport(JSON.stringify([1, 2])), null);
  });

  it("keeps an empty export but rejects all-invalid records", () => {
    const empty = parseTimelineExport(
      JSON.stringify({ records: [], truncatedCount: 0 }),
    );
    assert.ok(empty, "empty export accepted");
    assert.equal(empty.records.length, 0);

    const junk = parseTimelineExport(
      JSON.stringify({ records: [{ id: 1 }, { kind: "nope" }] }),
    );
    assert.equal(junk, null, "no usable records → rejected");
  });

  it("drops individual records with an unknown kind or missing fields", () => {
    const parsed = parseTimelineExport(
      JSON.stringify({
        records: [
          record(),
          record({ id: "bad-kind", kind: "mystery" }),
          { id: "no-start", kind: "tool" },
        ],
      }),
    );
    assert.ok(parsed, "parsed");
    assert.equal(parsed.records.length, 1);
    assert.equal(parsed.records[0]?.id, "r1");
  });

  it("defaults truncatedCount when absent or invalid", () => {
    const parsed = parseTimelineExport(
      JSON.stringify({ records: [record()], truncatedCount: -5 }),
    );
    assert.ok(parsed, "parsed");
    assert.equal(parsed.truncatedCount, 0);
  });
});
