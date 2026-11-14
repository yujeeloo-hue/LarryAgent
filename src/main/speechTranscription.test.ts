import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseSpeechEventLine,
  type SpeechHelperEvent,
} from "./speechTranscription.js";

describe("parseSpeechEventLine", () => {
  it("parses waiting / ready events", () => {
    assert.deepEqual(parseSpeechEventLine('{"type":"waiting","message":"Downloading speech model…"}'), {
      type: "waiting",
      message: "Downloading speech model…",
    } satisfies SpeechHelperEvent);
    assert.deepEqual(parseSpeechEventLine('{"type":"ready"}'), {
      type: "ready",
    } satisfies SpeechHelperEvent);
  });

  it("parses partial and final events with lang", () => {
    assert.deepEqual(
      parseSpeechEventLine('{"type":"partial","text":"你好","lang":"ZH"}'),
      { type: "partial", text: "你好", lang: "ZH" } satisfies SpeechHelperEvent,
    );
    assert.deepEqual(
      parseSpeechEventLine('{"type":"final","text":"hello world","lang":"EN"}'),
      { type: "final", text: "hello world", lang: "EN" } satisfies SpeechHelperEvent,
    );
  });

  it("parses level events and clamps out-of-range values", () => {
    assert.deepEqual(parseSpeechEventLine('{"type":"level","value":0.42}'), {
      type: "level",
      value: 0.42,
    } satisfies SpeechHelperEvent);
    assert.deepEqual(parseSpeechEventLine('{"type":"level","value":7}'), {
      type: "level",
      value: 1,
    } satisfies SpeechHelperEvent);
    assert.deepEqual(parseSpeechEventLine('{"type":"level","value":-0.3}'), {
      type: "level",
      value: 0,
    } satisfies SpeechHelperEvent);
  });

  it("parses error events", () => {
    assert.deepEqual(
      parseSpeechEventLine('{"type":"error","message":"Microphone access is required."}'),
      {
        type: "error",
        message: "Microphone access is required.",
      } satisfies SpeechHelperEvent,
    );
  });

  it("rejects malformed lines without throwing", () => {
    assert.equal(parseSpeechEventLine(""), null);
    assert.equal(parseSpeechEventLine("   \n "), null);
    assert.equal(parseSpeechEventLine("not json"), null);
    assert.equal(parseSpeechEventLine("[1,2,3]"), null);
    assert.equal(parseSpeechEventLine('{"type":"unknown"}'), null);
    // wrong payload shapes
    assert.equal(parseSpeechEventLine('{"type":"waiting"}'), null);
    assert.equal(parseSpeechEventLine('{"type":"error","message":""}'), null);
    assert.equal(parseSpeechEventLine('{"type":"partial","text":"x","lang":"FR"}'), null);
    assert.equal(parseSpeechEventLine('{"type":"level","value":"loud"}'), null);
  });

  it("allows empty final text but not empty partial text", () => {
    assert.deepEqual(parseSpeechEventLine('{"type":"final","text":"","lang":"ZH"}'), {
      type: "final",
      text: "",
      lang: "ZH",
    } satisfies SpeechHelperEvent);
    assert.equal(parseSpeechEventLine('{"type":"partial","text":"","lang":"ZH"}'), null);
  });
});
