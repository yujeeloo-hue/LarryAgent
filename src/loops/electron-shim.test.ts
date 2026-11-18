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
    assert.ok(script.startsWith('display notification "'));
    assert.ok(script.endsWith('"'));
    assert.ok(script.includes('" with title "'));
    assert.ok(script.includes('b\\\\ody\\nnext'));
    assert.ok(script.includes('t\\"itle'));
  });
});

describe("Notification shim surface", () => {
  it("isSupported is true on macOS with osascript present", () => {
    assert.equal(Notification.isSupported(), process.platform === "darwin");
  });

  it("constructor defaults and builder-style on()", () => {
    const n = new Notification();
    assert.equal(n.on("click", () => {}), n);
    assert.doesNotThrow(() => n.close());
  });
});
