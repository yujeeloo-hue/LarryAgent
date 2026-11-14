import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatUploadBytes,
  formatUploadEta,
  parseUploadFinished,
  seedUploadLive,
  uploadInfoFromTool,
  uploadLiveFromPayload,
} from "./uploadCard.js";

describe("uploadInfoFromTool", () => {
  it("builds card info from upload_files arguments", () => {
    const info = uploadInfoFromTool("upload_files", {
      src: "web/dist",
      dest_host: "jnote-cloud",
      dest_path: "/opt/jnote-web",
      excludes: [".env"],
    });
    assert.ok(info);
    assert.equal(info.src, "web/dist");
    assert.equal(info.dest, "jnote-cloud:/opt/jnote-web");
    assert.deepEqual(info.excludes, [".env"]);
  });

  it("returns null for other tools and malformed arguments", () => {
    assert.equal(uploadInfoFromTool("run_shell", { command: "rsync -az a b:c" }), null);
    assert.equal(uploadInfoFromTool("upload_files", {}), null);
    assert.equal(uploadInfoFromTool("upload_files", null), null);
    assert.equal(
      uploadInfoFromTool("upload_files", { src: 1, dest_host: "h", dest_path: "/p" }),
      null,
    );
    // Non-string exclude entries are dropped silently.
    const info = uploadInfoFromTool("upload_files", {
      src: "a",
      dest_host: "h",
      dest_path: "/p",
      excludes: [".env", 42],
    });
    assert.ok(info);
    assert.deepEqual(info.excludes, [".env"]);
  });
});

describe("seedUploadLive", () => {
  it("seeds the connecting state from card info", () => {
    const state = seedUploadLive({
      src: "web/dist",
      dest: "jnote-cloud:/opt/jnote-web",
      excludes: [".env"],
    });
    assert.equal(state.phase, "connecting");
    assert.equal(state.filesDone, 0);
    assert.deepEqual(state.recentFiles, []);
    assert.equal(state.envAtRisk, undefined);
  });
});

describe("uploadLiveFromPayload", () => {
  it("narrows tool_live payloads and rejects junk", () => {
    const state = uploadLiveFromPayload({
      phase: "transferring",
      src: "web/dist",
      dest: "jnote-cloud:/opt/jnote-web",
      percent: 38.2,
      bytesSent: 4251232,
      speed: "4.90MB/s",
      filesDone: 89,
      recentFiles: [{ name: "index.js", bytes: 1234 }],
    });
    assert.ok(state);
    assert.equal(state.percent, 38.2);
    assert.equal(state.speed, "4.90MB/s");
    assert.equal(uploadLiveFromPayload(null), null);
    assert.equal(uploadLiveFromPayload("junk"), null);
  });
});

describe("parseUploadFinished", () => {
  it("restores stats from the finished result text", () => {
    const text = [
      "$ rsync -az --info=progress2 --out-format='%n|%b|%l' d h:/p",
      "cwd /w",
      "exit 0",
      "elapsed 9.4s",
      "--- stdout ---",
      "server/dist/index.js|18432|18432",
      "          44,878,387 100%  4.80MB/s    0:00:09 (xfr#214, to-chk=0/214)",
    ].join("\n");
    const stats = parseUploadFinished(text);
    assert.ok(stats);
    assert.equal(stats.files, 214);
    assert.equal(stats.elapsedSec, 9.4);
    assert.ok(stats.bytes !== null && stats.bytes > 40_000_000);
    assert.equal(stats.fileLines.length, 1);
  });

  it("keeps the most recent file rows up to the card list cap", () => {
    const rows = Array.from({ length: 45 }, (_, i) => `f${i}|${i}|${i}`);
    const stats = parseUploadFinished(
      ["--- stdout ---", ...rows].join("\n"),
    );
    assert.equal(stats.fileLines.length, 40);
    assert.equal(stats.fileLines[0]?.name, "f5");
    assert.equal(stats.fileLines[39]?.name, "f44");
  });

  it("returns nulls for non-upload text", () => {
    const stats = parseUploadFinished("$ echo hi\nexit 0");
    assert.equal(stats.files, null);
  });
});

describe("formatters", () => {
  it("formats bytes and ETA", () => {
    assert.equal(formatUploadBytes(0), "0 B");
    assert.equal(formatUploadBytes(1024), "1.0 KB");
    assert.equal(formatUploadBytes(44_878_387), "44.9 MB");
    assert.equal(formatUploadEta(null), "–");
    assert.equal(formatUploadEta(9), "9s");
    assert.equal(formatUploadEta(95), "1m35s");
  });
});
