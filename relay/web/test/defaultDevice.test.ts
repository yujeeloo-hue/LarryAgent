/**
 * Default device pick for the home session list.
 *
 * Regression: the first-load auto-pick took the first online device only,
 * so the console could open on an idle machine while another device had a
 * session mid-turn. The pick must prefer the online device with a running
 * session; offline devices never win (even with a stale running count);
 * null only when nothing is online.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { pickDefaultDevice, pickRecentActivityDevice, pickRecentRunningDevice } from "../src/defaultDevice.js";
import type { DeviceSummary, SessionSummary } from "../src/types.js";

function device(overrides: Partial<DeviceSummary> & { deviceId: string }): DeviceSummary {
  return {
    name: overrides.deviceId,
    platform: "mac",
    version: "1.5.8",
    online: true,
    firstSeen: 0,
    lastSeen: 0,
    blocked: false,
    ...overrides,
  };
}

test("prefers the online device with a running session over an earlier idle one", () => {
  const list = [
    device({ deviceId: "idle-mac" }),
    device({ deviceId: "busy-pi", runningSessions: 2 }),
  ];
  assert.equal(pickDefaultDevice(list)?.deviceId, "busy-pi");
});

test("first online device wins when nobody is running", () => {
  const list = [
    device({ deviceId: "a", online: false }),
    device({ deviceId: "b" }),
    device({ deviceId: "c" }),
  ];
  assert.equal(pickDefaultDevice(list)?.deviceId, "b");
});

test("a running count on an offline device does not count", () => {
  const list = [
    device({ deviceId: "ghost", online: false, runningSessions: 3 }),
    device({ deviceId: "idle" }),
  ];
  assert.equal(pickDefaultDevice(list)?.deviceId, "idle");
});

test("devices without a runningSessions field (old builds) behave as idle", () => {
  const list = [device({ deviceId: "legacy" }), device({ deviceId: "modern", runningSessions: 1 })];
  assert.equal(pickDefaultDevice(list)?.deviceId, "modern");
});

test("null when no device is online", () => {
  const list = [device({ deviceId: "a", online: false }), device({ deviceId: "b", online: false })];
  assert.equal(pickDefaultDevice(list), null);
});

test("empty list → null", () => {
  assert.equal(pickDefaultDevice([]), null);
});

// ── pickRecentRunningDevice ──────────────────────────────────
// Refinement pass: with several busy devices, the sync list-order pick may
// land on the wrong one — the device whose running session is most recently
// active should win.

function session(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    title: overrides.id,
    updatedAt: 0,
    status: "idle",
    progressText: "",
    type: "agent",
    messageCount: 0,
    archived: false,
    archivedAt: null,
    workspaceId: "/ws",
    ...overrides,
  };
}

test("device with the most recently updated running session wins", () => {
  const winner = pickRecentRunningDevice([
    { deviceId: "mac", sessions: [session({ id: "a", status: "running", updatedAt: 100 })] },
    { deviceId: "pi", sessions: [session({ id: "b", status: "running", updatedAt: 500 })] },
  ]);
  assert.equal(winner, "pi");
});

test("a newer idle/completed timestamp does not outrank a running session", () => {
  const winner = pickRecentRunningDevice([
    { deviceId: "mac", sessions: [session({ id: "a", status: "running", updatedAt: 100 })] },
    { deviceId: "pi", sessions: [session({ id: "b", status: "completed", updatedAt: 900 })] },
  ]);
  assert.equal(winner, "mac");
});

test("ties keep the earlier device (device list order)", () => {
  const winner = pickRecentRunningDevice([
    { deviceId: "mac", sessions: [session({ id: "a", status: "running", updatedAt: 300 })] },
    { deviceId: "pi", sessions: [session({ id: "b", status: "running", updatedAt: 300 })] },
  ]);
  assert.equal(winner, "mac");
});

test("newest running session per device represents it", () => {
  const winner = pickRecentRunningDevice([
    {
      deviceId: "mac",
      sessions: [
        session({ id: "a1", status: "running", updatedAt: 700 }),
        session({ id: "a2", status: "running", updatedAt: 100 }),
      ],
    },
    { deviceId: "pi", sessions: [session({ id: "b", status: "running", updatedAt: 500 })] },
  ]);
  assert.equal(winner, "mac");
});

test("archived running sessions do not count", () => {
  const winner = pickRecentRunningDevice([
    { deviceId: "mac", sessions: [session({ id: "a", status: "running", updatedAt: 100 })] },
    { deviceId: "pi", sessions: [session({ id: "b", status: "running", updatedAt: 900, archived: true })] },
  ]);
  assert.equal(winner, "mac");
});

test("null when no candidate has a running session", () => {
  const winner = pickRecentRunningDevice([
    { deviceId: "mac", sessions: [session({ id: "a", status: "idle", updatedAt: 100 })] },
    { deviceId: "pi", sessions: [] },
  ]);
  assert.equal(winner, null);
});

// ── pickRecentActivityDevice ─────────────────────────────────
// Idle fallback: nobody is running — list order is registration order and
// says nothing about where the user last was. Any session status counts;
// the device whose most recent session activity is newest wins.

test("idle devices: the one with the most recent session activity wins", () => {
  const winner = pickRecentActivityDevice([
    { deviceId: "mac", sessions: [session({ id: "a", status: "completed", updatedAt: 500 })] },
    { deviceId: "pi", sessions: [session({ id: "b", status: "idle", updatedAt: 900 })] },
  ]);
  assert.equal(winner, "pi");
});

test("a running session also counts as activity", () => {
  const winner = pickRecentActivityDevice([
    { deviceId: "mac", sessions: [session({ id: "a", status: "running", updatedAt: 900 })] },
    { deviceId: "pi", sessions: [session({ id: "b", status: "completed", updatedAt: 500 })] },
  ]);
  assert.equal(winner, "mac");
});

test("archived sessions do not count as activity", () => {
  const winner = pickRecentActivityDevice([
    { deviceId: "mac", sessions: [session({ id: "a", status: "completed", updatedAt: 100 })] },
    { deviceId: "pi", sessions: [session({ id: "b", status: "completed", updatedAt: 900, archived: true })] },
  ]);
  assert.equal(winner, "mac");
});

test("newest session per device represents it, any status", () => {
  const winner = pickRecentActivityDevice([
    {
      deviceId: "mac",
      sessions: [
        session({ id: "a1", status: "idle", updatedAt: 700 }),
        session({ id: "a2", status: "error", updatedAt: 300 }),
      ],
    },
    { deviceId: "pi", sessions: [session({ id: "b", status: "idle", updatedAt: 500 })] },
  ]);
  assert.equal(winner, "mac");
});

test("ties keep the earlier device (device list order)", () => {
  const winner = pickRecentActivityDevice([
    { deviceId: "mac", sessions: [session({ id: "a", status: "idle", updatedAt: 300 })] },
    { deviceId: "pi", sessions: [session({ id: "b", status: "idle", updatedAt: 300 })] },
  ]);
  assert.equal(winner, "mac");
});

test("null when no candidate has any session", () => {
  const winner = pickRecentActivityDevice([
    { deviceId: "mac", sessions: [] },
    { deviceId: "pi", sessions: [] },
  ]);
  assert.equal(winner, null);
});
