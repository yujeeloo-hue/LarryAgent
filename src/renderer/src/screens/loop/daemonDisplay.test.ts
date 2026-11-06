/**
 * Daemon status-row mapping: the Start/Stop button semantics.
 *
 * Running (fresh heartbeat) → Stop. Heartbeat stale → Stop (a hung daemon
 * must be stoppable; Start brings it back clean). Installed but stopped →
 * Start, with a distinct copy when the stop was deliberate (stoppedByUser).
 * Missing install → Install & Enable.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { daemonToDisplay } from "./daemonDisplay.js";

function baseStatus(
  overrides: Partial<LoopsDaemonView> = {},
): LoopsDaemonView {
  return {
    loaded: true,
    state: "running",
    pid: 123,
    plistExists: true,
    plistStale: false,
    lastError: null,
    heartbeatAt: Date.now() - 1_000,
    heartbeatPid: 123,
    daemonVersion: "0.0.1",
    heartbeatStale: false,
    stoppedByUser: false,
    appVersion: "0.6.3",
    ...overrides,
  };
}

describe("daemonToDisplay", () => {
  it("running with fresh heartbeat offers Stop", () => {
    const display = daemonToDisplay(baseStatus());
    assert.equal(display.tone, "running");
    assert.equal(display.action, "stop");
    assert.equal(display.actionLabel, "Stop");
    assert.ok(display.detail.includes("pid 123"));
    assert.ok(display.detail.includes("v0.0.1"));
  });

  it("stale heartbeat keeps the Stop action", () => {
    const display = daemonToDisplay(
      baseStatus({ heartbeatStale: true, heartbeatAt: Date.now() - 600_000 }),
    );
    assert.equal(display.tone, "stale");
    assert.equal(display.label, "Heartbeat stale");
    assert.equal(display.action, "stop");
  });

  it("installed but not running offers Start; deliberate stop gets its copy", () => {
    const auto = daemonToDisplay(
      baseStatus({
        state: null,
        loaded: false,
        pid: null,
        stoppedByUser: false,
      }),
    );
    assert.equal(auto.tone, "stopped");
    assert.equal(auto.action, "ensure");
    assert.equal(auto.actionLabel, "Start");

    const deliberate = daemonToDisplay(
      baseStatus({
        state: null,
        loaded: false,
        pid: null,
        stoppedByUser: true,
      }),
    );
    assert.equal(deliberate.action, "ensure");
    assert.equal(deliberate.actionLabel, "Start");
    assert.ok(
      deliberate.detail.includes("Stopped from the app"),
      `expected deliberate-stop copy, got: ${deliberate.detail}`,
    );
  });

  it("missing install offers Install & Enable", () => {
    const display = daemonToDisplay(
      baseStatus({
        state: null,
        loaded: false,
        pid: null,
        plistExists: false,
        heartbeatAt: null,
      }),
    );
    assert.equal(display.tone, "missing");
    assert.equal(display.action, "ensure");
    assert.equal(display.actionLabel, "Install & Enable");
  });
});

describe("daemonToDisplay (in-app scheduler, Windows)", () => {
  it("running with fresh heartbeat offers Stop", () => {
    const display = daemonToDisplay(baseStatus({ inApp: true }));
    assert.equal(display.tone, "running");
    assert.equal(display.label, "Running");
    assert.equal(display.action, "stop");
    assert.equal(display.actionLabel, "Stop");
    assert.ok(display.detail.includes("pid 123"));
    assert.ok(display.detail.includes("v0.0.1"));
    assert.ok(display.detail.includes("heartbeat"));
  });

  it("running before the first heartbeat reports no heartbeat yet", () => {
    const display = daemonToDisplay(
      baseStatus({ inApp: true, heartbeatAt: null }),
    );
    assert.equal(display.tone, "running");
    assert.ok(display.detail.includes("no heartbeat yet"));
  });

  it("stale heartbeat keeps the Stop action", () => {
    const display = daemonToDisplay(
      baseStatus({ inApp: true, heartbeatStale: true, heartbeatAt: Date.now() - 600_000 }),
    );
    assert.equal(display.tone, "stale");
    assert.equal(display.label, "Heartbeat stale");
    assert.equal(display.action, "stop");
  });

  it("stopped offers Start; deliberate stop gets its copy", () => {
    const deliberate = daemonToDisplay(
      baseStatus({
        inApp: true,
        state: null,
        loaded: false,
        pid: null,
        heartbeatAt: null,
        stoppedByUser: true,
      }),
    );
    assert.equal(deliberate.tone, "stopped");
    assert.equal(deliberate.action, "ensure");
    assert.equal(deliberate.actionLabel, "Start");
    assert.ok(
      deliberate.detail.includes("Stopped from the app"),
      `expected deliberate-stop copy, got: ${deliberate.detail}`,
    );

    const boot = daemonToDisplay(
      baseStatus({
        inApp: true,
        state: null,
        loaded: false,
        pid: null,
        heartbeatAt: null,
        stoppedByUser: false,
      }),
    );
    assert.equal(boot.tone, "stopped");
    assert.equal(boot.action, "ensure");
    assert.ok(
      boot.detail.includes("loops will start when JellyBot is open"),
      `expected boot-state copy, got: ${boot.detail}`,
    );
  });

  it("never renders the missing-install row", () => {
    const display = daemonToDisplay(
      baseStatus({
        inApp: true,
        state: null,
        loaded: false,
        pid: null,
        plistExists: false,
        heartbeatAt: null,
      }),
    );
    assert.notEqual(display.tone, "missing");
    assert.notEqual(display.actionLabel, "Install & Enable");
  });
});
