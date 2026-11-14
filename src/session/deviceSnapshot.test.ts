import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readSessionDeviceSnapshot } from "./deviceSnapshot.js";

function freshRoot(): string {
  return mkdtempSync(join(tmpdir(), "jellybot-device-snapshot-"));
}

describe("readSessionDeviceSnapshot", () => {
  it("reuses the persisted remote relay identity", () => {
    const root = freshRoot();
    writeFileSync(
      join(root, "settings.json"),
      JSON.stringify({
        remote: { enabled: false, deviceId: "dev-1234-abcd", deviceName: "  Mac Studio  " },
      }),
    );
    const snap = readSessionDeviceSnapshot(root, "1.2.3");
    assert.equal(snap.deviceId, "dev-1234-abcd");
    assert.equal(snap.deviceName, "Mac Studio");
    assert.equal(snap.appVersion, "1.2.3");
    assert.match(snap.deviceOs, /^[a-z]+ [a-z0-9]+ \S+/);
  });

  it("falls back to hostname when remote.deviceName is empty/absent", () => {
    const root = freshRoot();
    writeFileSync(
      join(root, "settings.json"),
      JSON.stringify({ remote: { enabled: false, deviceId: "dev-1234-abcd" } }),
    );
    assert.equal(readSessionDeviceSnapshot(root, "").deviceName, os.hostname());
  });

  it("missing settings.json → empty deviceId (never mints), hostname name", () => {
    const root = freshRoot();
    const snap = readSessionDeviceSnapshot(root, "9.9.9");
    assert.equal(snap.deviceId, "");
    assert.equal(snap.deviceName, os.hostname());
    assert.equal(snap.appVersion, "9.9.9");
  });

  it("malformed JSON and non-object remote degrade to unknown device", () => {
    const root = freshRoot();
    writeFileSync(join(root, "settings.json"), "{not json");
    assert.equal(readSessionDeviceSnapshot(root, "").deviceId, "");
    writeFileSync(
      join(root, "settings.json"),
      JSON.stringify({ remote: "nonsense" }),
    );
    assert.equal(readSessionDeviceSnapshot(root, "").deviceId, "");
  });
});
