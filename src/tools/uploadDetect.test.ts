import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  collapseProgressLines,
  parseRsyncFileLine,
  parseRsyncProgressLine,
  parseRsyncStartingLine,
} from "./uploadDetect.js";

describe("parseRsyncStartingLine", () => {
  it("parses the openrsync file-count line", () => {
    assert.equal(parseRsyncStartingLine("Transfer starting: 214 files"), 214);
    assert.equal(parseRsyncStartingLine("transfer starting: 1 file"), 1);
    assert.equal(parseRsyncStartingLine("Transfer starting: nope"), null);
  });
});

describe("parseRsyncProgressLine", () => {
  it("parses GNU progress2 whole-transfer snapshots", () => {
    const s = parseRsyncProgressLine(
      "          4,251,232   38%  4.90MB/s    0:00:04  xfr#89, ir-chk=1021/1235",
    );
    assert.ok(s);
    assert.equal(s.bytesSent, 4251232);
    assert.equal(s.percent, 38);
    assert.equal(s.speed, "4.90MB/s");
    assert.equal(s.etaSeconds, 4);
    assert.equal(s.filesTransferred, 89);
    assert.deepEqual(s.check, { done: 1021, total: 1235 });
  });

  it("parses openrsync xfer# and to-check variants", () => {
    const s = parseRsyncProgressLine(
      "   65536  100%  0.00kB/s   00:00:00 (xfer#12, to-check=5/200)",
    );
    assert.ok(s);
    assert.equal(s.percent, 100);
    assert.equal(s.filesTransferred, 12);
    assert.deepEqual(s.check, { done: 5, total: 200 });
  });

  it("parses legacy per-file mid-transfer lines (no counters)", () => {
    const s = parseRsyncProgressLine("    131072    45%  1.20MB/s    0:00:02");
    assert.ok(s);
    assert.equal(s.percent, 45);
    assert.equal(s.filesTransferred, null);
    assert.equal(s.check, null);
  });

  it("rejects non-progress lines", () => {
    assert.equal(parseRsyncProgressLine("index.js|1234|4321"), null);
    assert.equal(parseRsyncProgressLine(""), null);
  });
});

describe("parseRsyncFileLine", () => {
  it("parses --out-format name|bytes|size events", () => {
    const f = parseRsyncFileLine("server/dist/index.js|18432|18432");
    assert.ok(f);
    assert.equal(f.name, "server/dist/index.js");
    assert.equal(f.transferred, 18432);
    assert.equal(f.bytes, 18432);
  });

  it("rejects lines without the 3-field shape", () => {
    assert.equal(parseRsyncFileLine("a|b"), null);
    assert.equal(parseRsyncFileLine("a|b|c|d"), null);
  });
});

describe("collapseProgressLines", () => {
  it("keeps the final \\r-rewritten line and drops repaints", () => {
    const stdout = [
      "building file list\n",
      "1,048,576  10%  1MB/s    0:00:09\r",
      "5,242,880  50%  1MB/s    0:00:05\r",
      "10,485,760 100%  1MB/s    0:00:00\n",
      "sent 10,485,760 bytes",
    ].join("");
    const collapsed = collapseProgressLines(stdout);
    assert.match(collapsed, /100%  1MB\/s/);
    assert.doesNotMatch(collapsed, /50%/);
    assert.match(collapsed, /building file list/);
    assert.match(collapsed, /sent 10,485,760 bytes/);
  });
});
