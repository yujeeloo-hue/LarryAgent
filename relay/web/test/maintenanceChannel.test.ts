/**
 * Per-channel release resolution: which downloads.json entry a device's
 * Maintenance card reads, and which version a package filename carries.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  maintenanceChannel,
  releaseChannelOfFile,
  releaseMatchesChannel,
  releaseVersionFromFile,
} from "../src/maintenanceChannel.js";

test("device platform string maps to exactly one release channel", () => {
  assert.equal(maintenanceChannel("darwin arm64"), "mac");
  assert.equal(maintenanceChannel("win32 x64"), "win");
  assert.equal(maintenanceChannel("linux arm64"), "agentd");
  assert.equal(maintenanceChannel("WIN32 ia32"), "win", "case-insensitive");
  assert.equal(maintenanceChannel("freebsd x64"), null, "unknown platform has no channel");
  assert.equal(maintenanceChannel(""), null);
  assert.equal(maintenanceChannel(null), null);
});

test("version is read from every channel's filename — never from an arch", () => {
  assert.equal(releaseVersionFromFile("Larry-Agent-1.5.3-win-x64-setup.exe"), "1.5.3");
  assert.equal(releaseVersionFromFile("Larry-Agent-1.5.2-mac-arm64.zip"), "1.5.2");
  assert.equal(releaseVersionFromFile("Larry-Agent-1.5.2-mac-arm64.dmg"), "1.5.2");
  assert.equal(releaseVersionFromFile("jellybot-agentd-1.5.1-linux-arm64.tar.gz"), "1.5.1");
  assert.equal(
    releaseVersionFromFile("https://dl.test/download/Larry-Agent-1.5.4-win-x64-setup.exe?cache=1"),
    "1.5.4",
  );
  assert.equal(releaseVersionFromFile("/opt/releases/Larry-Agent-v1.6.0-mac-arm64.zip"), "1.6.0");
  assert.equal(releaseVersionFromFile("release.zip"), undefined, "no dotted version → no guess");
  assert.equal(releaseVersionFromFile("jellybot-agentd-linux-arm64.tar.gz"), undefined);
});

test("package filenames resolve to their channel", () => {
  assert.equal(releaseChannelOfFile("Larry-Agent-1.5.3-win-x64-setup.exe"), "win");
  assert.equal(releaseChannelOfFile("Larry-Agent-1.5.2-mac-arm64.zip"), "mac");
  assert.equal(releaseChannelOfFile("Larry-Agent-1.5.2-mac-arm64.dmg"), "mac");
  assert.equal(releaseChannelOfFile("jellybot-agentd-1.5.1-linux-arm64.tar.gz"), "agentd");
  assert.equal(releaseChannelOfFile("/opt/build/output.tar.gz"), "agentd");
  assert.equal(releaseChannelOfFile("/tmp/whatever"), null, "custom names claim nothing");
});

test("a package from another platform is refused, custom names pass", () => {
  const win = "Larry-Agent-1.5.3-win-x64-setup.exe";
  const mac = "Larry-Agent-1.5.2-mac-arm64.zip";
  const agentd = "jellybot-agentd-1.5.1-linux-arm64.tar.gz";
  assert.equal(releaseMatchesChannel(win, "win"), true);
  assert.equal(releaseMatchesChannel(win, "mac"), false);
  assert.equal(releaseMatchesChannel(win, "agentd"), false);
  assert.equal(releaseMatchesChannel(mac, "mac"), true);
  assert.equal(releaseMatchesChannel(mac, "win"), false);
  assert.equal(releaseMatchesChannel(mac, "agentd"), false);
  assert.equal(releaseMatchesChannel(agentd, "agentd"), true);
  assert.equal(releaseMatchesChannel(agentd, "win"), false);
  assert.equal(releaseMatchesChannel("/tmp/custom-release", "mac"), true, "operator's own source");
});
