/**
 * Loops daemon Electron-shim — Notification (osascript) contract tests.
 *
 * The daemon runs under ELECTRON_RUN_AS_NODE=1, so the shim's Notification is
 * the only desktop-toast channel on macOS (backed by /usr/bin/osascript).
 * show() itself is fire-and-forget against the real binary — these tests
 * cover the pure parts: AppleScript escaping, script assembly, and the
 * Electron-API-parity surface the bundled code relies on.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildDisplayNotificationScript,
  escapeAppleScriptString,
  Notification,
} from "./electron-shim.js";

describe("escapeAppleScriptString", () => {
  it("escapes backslashes first, then quotes", () => {
    assert.equal(escapeAppleScriptString('a\\b"c'), 'a\\\\b\\"c');
  });

  it("escapes newlines and carriage returns", () => {
    assert.equal(escapeAppleScriptString("a\nb\rc"), "a\\nb\\rc");
  });

  it("leaves plain text untouched", () => {
    assert.equal(escapeAppleScriptString("Task finished · 12m"), "Task finished · 12m");
  });
});

describe("buildDisplayNotificationScript", () => {
  it("includes title when present", () => {
    assert.equal(
      buildDisplayNotificationScript("Task finished", "Demo · 12m"),
      'display notification "Demo · 12m" with title "Task finished"',
    );
  });

  it("omits title when empty", () => {
    assert.equal(
      buildDisplayNotificationScript("", "body only"),
      'display notification "body only"',
    );
  });

  it("survives hostile body text (quotes, backslashes, newlines)", () => {
    const script = buildDisplayNotificationScript('t"itle', 'b\\ody\nnext');
    // Well-formed single command line: quotes/backslashes/newlines inside the
    // literals must all be escaped.
    assert.ok(script.startsWith('display notification "'));
    assert.ok(script.endsWith('"'));
    assert.ok(script.includes('" with title "'));
    assert.ok(script.includes('b\\\\ody\\nnext'));
    assert.ok(script.includes('t\\"itle'));
  });
});

describe("Notification shim surface", () => {
  it("isSupported is true on macOS with osascript present", () => {
    // The suite runs on macOS in CI/dev (Loops is macOS-only in v1); on any
    // other platform this would assert false.
    assert.equal(Notification.isSupported(), process.platform === "darwin");
  });

  it("constructor defaults and builder-style on()", () => {
    const n = new Notification();
    assert.equal(n.on("click", () => {}), n);
    assert.doesNotThrow(() => n.close());
  });
});
