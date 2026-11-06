import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  SCAN_BYTE_BUDGET,
  SCAN_FILE_BUDGET,
  TEXT_READ_CAP,
  claimScanBudget,
  countLinesIn,
  countTextLines,
  createScanBudget,
  readCappedText,
} from "./readCapped.js";

let dir = "";

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "jb-readcapped-"));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("readCappedText", () => {
  it("returns whole content for a small text file", async () => {
    const path = join(dir, "small.txt");
    await writeFile(path, "a\nb\nc\n");
    const result = await readCappedText(path);
    assert.deepEqual(result, {
      text: "a\nb\nc\n",
      truncated: false,
      binary: false,
    });
  });

  it("stops at the cap instead of loading the whole file", async () => {
    const path = join(dir, "big.txt");
    // Four times the cap: the old readFile-then-slice would allocate all of it.
    await writeFile(path, "x".repeat(TEXT_READ_CAP * 4));
    const result = await readCappedText(path);
    assert.ok(result);
    assert.equal(result.binary, false);
    assert.equal(result.truncated, true);
    assert.equal(result.text.length, TEXT_READ_CAP);
  });

  it("flags a NUL byte inside the inspected slice as binary", async () => {
    const path = join(dir, "bin.dat");
    await writeFile(path, Buffer.from([0x61, 0x00, 0x62]));
    const result = await readCappedText(path);
    assert.deepEqual(result, { text: "", truncated: false, binary: true });
  });

  it("treats an empty file as empty text, not binary", async () => {
    const path = join(dir, "empty.txt");
    await writeFile(path, "");
    const result = await readCappedText(path);
    assert.deepEqual(result, { text: "", truncated: false, binary: false });
  });

  it("returns null for a missing path", async () => {
    assert.equal(await readCappedText(join(dir, "nope.txt")), null);
  });
});

describe("countTextLines", () => {
  it("counts lines in a text file", async () => {
    const path = join(dir, "lines.txt");
    await writeFile(path, "one\ntwo\nthree\n");
    assert.equal(await countTextLines(path), 3);
  });

  it("counts a file with no trailing newline", async () => {
    const path = join(dir, "notrail.txt");
    await writeFile(path, "one\ntwo");
    assert.equal(await countTextLines(path), 2);
  });

  it("returns null for binary and missing paths", async () => {
    const path = join(dir, "bin2.dat");
    await writeFile(path, Buffer.from([0x00, 0x01]));
    assert.equal(await countTextLines(path), null);
    assert.equal(await countTextLines(join(dir, "gone.txt")), null);
  });
});

describe("countLinesIn", () => {
  it("does not double-count a trailing newline", () => {
    assert.equal(countLinesIn("a\nb\n"), 2);
    assert.equal(countLinesIn("a\nb"), 2);
    assert.equal(countLinesIn(""), 0);
  });
});

describe("scan budget", () => {
  it("charges each file at most the read cap", () => {
    const budget = createScanBudget();
    assert.equal(claimScanBudget(budget, TEXT_READ_CAP * 100), true);
    assert.equal(budget.filesLeft, SCAN_FILE_BUDGET - 1);
    assert.equal(budget.bytesLeft, SCAN_BYTE_BUDGET - TEXT_READ_CAP);
  });

  it("stops granting once the file count runs out", () => {
    const budget = { filesLeft: 1, bytesLeft: SCAN_BYTE_BUDGET };
    assert.equal(claimScanBudget(budget, 10), true);
    assert.equal(claimScanBudget(budget, 10), false);
  });

  it("stops granting once the byte budget runs out", () => {
    const budget = { filesLeft: SCAN_FILE_BUDGET, bytesLeft: 8 };
    assert.equal(claimScanBudget(budget, 8), true);
    assert.equal(claimScanBudget(budget, 8), false);
  });

  it("treats a negative size as zero cost", () => {
    const budget = createScanBudget();
    claimScanBudget(budget, -5);
    assert.equal(budget.bytesLeft, SCAN_BYTE_BUDGET);
  });
});
