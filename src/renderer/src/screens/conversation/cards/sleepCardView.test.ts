import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isCompactSleepFollowUp,
  parseSleepResultOutput,
  sleepFinishedHint,
  sleepHint,
  sleepInfoFromArgs,
} from "./sleepCardFormat.js";

describe("sleepInfoFromArgs", () => {
  it("detects a leading sleep command", () => {
    const info = sleepInfoFromArgs({ command: "sleep 8 && echo ok" });
    assert.ok(info);
    assert.equal(info.seconds, 8);
    assert.equal(info.hasFollowUp, true);
    assert.equal(info.followUpCount, 1);
  });

  it("returns null for non-sleep shell and malformed args", () => {
    assert.equal(sleepInfoFromArgs({ command: "echo hi" }), null);
    assert.equal(sleepInfoFromArgs({ command: "sleep 8 &" }), null);
    assert.equal(sleepInfoFromArgs({}), null);
    assert.equal(sleepInfoFromArgs(null), null);
  });
});

describe("sleepHint / sleepFinishedHint", () => {
  it("formats the running and finished summary hints", () => {
    const info = sleepInfoFromArgs({ command: "sleep 8 && echo ok" })!;
    assert.equal(sleepHint(info), "sleep 8s · then: echo ok");
    assert.equal(sleepFinishedHint(info, true, false), "waited 8s · then: check");
    assert.equal(sleepFinishedHint(info, false, false), "waited 8s · follow-up failed");
    assert.equal(
      sleepFinishedHint(info, false, true),
      "stopped during 8s wait · follow-up not run",
    );
  });

  it("omits follow-up copy for a plain sleep", () => {
    const info = sleepInfoFromArgs({ command: "sleep 2.5" })!;
    assert.equal(sleepHint(info), "sleep 2.5s");
    assert.equal(sleepFinishedHint(info, true, false), "waited 2.5s");
  });
});

describe("parseSleepResultOutput", () => {
  it("strips the $ cmd / cwd / exit envelope", () => {
    const parsed = parseSleepResultOutput(
      [
        "$ sleep 4 && echo ready",
        "cwd /tmp/project",
        "exit 0",
        "--- stdout ---",
        "ready",
      ].join("\n"),
    );
    assert.equal(parsed.stdout, "ready");
    assert.equal(parsed.stderr, "");
  });

  it("captures stderr separately", () => {
    const parsed = parseSleepResultOutput(
      [
        "$ sleep 1 && false",
        "cwd /tmp",
        "exit 1",
        "--- stderr ---",
        "boom",
      ].join("\n"),
    );
    assert.equal(parsed.stdout, "");
    assert.equal(parsed.stderr, "boom");
  });

  it("returns empty bodies when the command produced no output", () => {
    const parsed = parseSleepResultOutput("$ sleep 8\ncwd /tmp\nexit 0");
    assert.equal(parsed.stdout, "");
    assert.equal(parsed.stderr, "");
  });
});

describe("isCompactSleepFollowUp", () => {
  it("accepts a short single line", () => {
    assert.equal(isCompactSleepFollowUp("ready"), true);
    assert.equal(isCompactSleepFollowUp("active"), true);
  });

  it("rejects dumps and multiline output", () => {
    assert.equal(isCompactSleepFollowUp(""), false);
    assert.equal(isCompactSleepFollowUp("ready\nextra"), false);
    assert.equal(isCompactSleepFollowUp("x".repeat(49)), false);
  });
});
