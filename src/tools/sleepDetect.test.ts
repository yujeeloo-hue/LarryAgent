import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  detectSleepCommand,
  formatSleepDuration,
  parseSleepDuration,
} from "./sleepDetect.js";

describe("parseSleepDuration", () => {
  it("parses plain seconds, decimals and unit suffixes", () => {
    assert.equal(parseSleepDuration("8"), 8);
    assert.equal(parseSleepDuration("2.5"), 2.5);
    assert.equal(parseSleepDuration("90s"), 90);
    assert.equal(parseSleepDuration("2m"), 120);
    assert.equal(parseSleepDuration("1h"), 3600);
    assert.equal(parseSleepDuration("1m30s"), 90);
    assert.equal(parseSleepDuration("1 2"), null); // multi-arg handled upstream
  });

  it("rejects junk", () => {
    assert.equal(parseSleepDuration(""), null);
    assert.equal(parseSleepDuration("abc"), null);
    assert.equal(parseSleepDuration("-3"), null);
    assert.equal(parseSleepDuration("m"), null);
  });
});

describe("detectSleepCommand", () => {
  it("detects a plain sleep", () => {
    const info = detectSleepCommand("sleep 8");
    assert.equal(info.isSleep, true);
    assert.equal(info.seconds, 8);
    assert.equal(info.hasFollowUp, false);
    assert.equal(info.followUpCount, 0);
  });

  it("detects wait-then-check with && follow-up", () => {
    const info = detectSleepCommand(
      "sleep 8 && systemctl is-active jnote-web && curl -sf http://127.0.0.1:8787/api/health -o /dev/null",
    );
    assert.equal(info.isSleep, true);
    assert.equal(info.seconds, 8);
    assert.equal(info.hasFollowUp, true);
    assert.equal(info.followUpCount, 2);
    assert.equal(
      info.followUpText,
      "systemctl is-active jnote-web && curl -sf http://127.0.0.1:8787/api/health -o /dev/null",
    );
  });

  it("detects ; separators and sums leading sleeps", () => {
    const info = detectSleepCommand("sleep 2 && sleep 3 ; echo ok");
    assert.equal(info.isSleep, true);
    assert.equal(info.seconds, 5);
    assert.equal(info.followUpCount, 1);
    assert.equal(info.followUpText, "echo ok");
  });

  it("supports decimals, suffixes and multi-arg sums", () => {
    assert.equal(detectSleepCommand("sleep 2.5").seconds, 2.5);
    assert.equal(detectSleepCommand("sleep 90s").seconds, 90);
    assert.equal(detectSleepCommand("sleep 2m").seconds, 120);
    assert.equal(detectSleepCommand("sleep 1 2").seconds, 3);
  });

  it("joins line continuations", () => {
    const info = detectSleepCommand("sleep 5 \\\n  && curl -sf localhost:8787/health");
    assert.equal(info.isSleep, true);
    assert.equal(info.seconds, 5);
    assert.equal(info.followUpCount, 1);
  });

  it("keeps detection through redirects and || in the follow-up", () => {
    // Real-world case from session 354273ae: the old metachar filter used
    // to reject `||` and `2>/dev/null` — only backgrounding `&` breaks it.
    const info = detectSleepCommand(
      'sleep 4; cat /tmp/jt-demo/progress.json 2>/dev/null || echo "(still not ready)"',
    );
    assert.equal(info.isSleep, true);
    assert.equal(info.seconds, 4);
    assert.equal(info.hasFollowUp, true);
    assert.equal(info.followUpCount, 1);
  });

  it("rejects backgrounding, dynamic durations and non-leading sleeps", () => {
    for (const command of [
      "sleep 8 &",
      "sleep $(random)",
      "sleep 8 `wait`",
      "echo sleep 8", // sleep not leading
      "sleep", // no duration
      "sleep abc",
      "sleep 0",
      "sleep 99999", // over the card ceiling
      "echo hi",
    ]) {
      assert.equal(
        detectSleepCommand(command).isSleep,
        false,
        `expected ineligible: ${command}`,
      );
    }
  });
});

describe("formatSleepDuration", () => {
  it("formats compact durations", () => {
    assert.equal(formatSleepDuration(8), "8s");
    assert.equal(formatSleepDuration(2.5), "2.5s");
    assert.equal(formatSleepDuration(65), "1m05s");
    assert.equal(formatSleepDuration(120), "2m");
    assert.equal(formatSleepDuration(3600), "1h");
    assert.equal(formatSleepDuration(3660), "1h01m");
  });
});
