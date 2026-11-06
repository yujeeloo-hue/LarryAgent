/** Pure tests for the Annotate gutter formatting. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BLAME_BAND_COUNT,
  blameAgeLabel,
  blameBandSlots,
  blameGutterLabel,
  blameHoverPlainText,
  blameHoverText,
  blameLabelColumns,
  isUncommitted,
  shortAuthor,
  type BlameEntry,
} from "./blameFormat.js";

const NOW = Date.UTC(2024, 0, 10, 12, 0, 0); // 2024-01-10T12:00:00Z
const DAY = 86_400_000;

const gitEntry = {
  line: 3,
  rev: "d29a7f1c0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b",
  author: "You Yee",
  time: (NOW - 3 * DAY) / 1000,
  summary: "Add editor area",
};

describe("blameAgeLabel", () => {
  it("buckets ages compactly", () => {
    assert.equal(blameAgeLabel(NOW / 1000, NOW), "now");
    assert.equal(blameAgeLabel((NOW - 5 * 60_000) / 1000, NOW), "5m");
    assert.equal(blameAgeLabel((NOW - 3 * 3_600_000) / 1000, NOW), "3h");
    assert.equal(blameAgeLabel((NOW - 2 * DAY) / 1000, NOW), "2d");
    assert.equal(blameAgeLabel((NOW - 45 * DAY) / 1000, NOW), "1mo");
    assert.equal(blameAgeLabel((NOW - 400 * DAY) / 1000, NOW), "1y");
  });

  it("empty for missing time", () => {
    assert.equal(blameAgeLabel(null, NOW), "");
  });
});

describe("blameGutterLabel", () => {
  it("git: author + age only (hash lives in the tooltip)", () => {
    assert.equal(blameGutterLabel(gitEntry, "git", NOW), "You Yee 3d");
  });

  it("git uncommitted: author + now", () => {
    const entry = {
      ...gitEntry,
      rev: "0".repeat(40),
      author: "Not Committed Yet",
      time: NOW / 1000,
    };
    assert.equal(blameGutterLabel(entry, "git", NOW), "you now");
  });

  it("svn: author + age when a date exists", () => {
    const entry = { ...gitEntry, rev: "12345", summary: null };
    assert.equal(blameGutterLabel(entry, "svn", NOW), "You Yee 3d");
    const noDate = { ...entry, time: null };
    assert.equal(blameGutterLabel(noDate, "svn", NOW), "You Yee");
  });

  it("svn locally modified line has no history — 'local'", () => {
    const entry = { ...gitEntry, rev: "M", author: "" };
    assert.equal(blameGutterLabel(entry, "svn", NOW), "local");
  });

  it("truncates long authors", () => {
    const entry = { ...gitEntry, author: "Very Long Author Name" };
    assert.equal(
      blameGutterLabel(entry, "git", NOW).startsWith("Very Long"),
      true,
    );
  });

  it("accounts for full-width author names in the gutter", () => {
    assert.equal(blameLabelColumns("张三 3d"), 7);
    assert.ok(blameLabelColumns(shortAuthor("一二三四五六七八")) <= 15);
  });

  it("counts latin and NBSP as single columns", () => {
    // The gutter joins the label with NBSP; counting those as wide would
    // over-reserve the column and push the code right.
    assert.equal(blameLabelColumns("Jos\u00e9\u00a03d"), 7);
    assert.equal(blameLabelColumns("yujeeloo-hue 10d"), 16);
  });
});

describe("blameBandSlots", () => {
  const at = (line: number, rev: string): BlameEntry => ({
    ...gitEntry,
    line,
    rev,
  });

  it("gives neighbouring commit batches different slots", () => {
    const slots = blameBandSlots([
      at(1, "aaa"),
      at(2, "aaa"),
      at(3, "bbb"),
      at(4, "aaa"),
    ]);
    assert.equal(slots.get("aaa"), 0);
    assert.equal(slots.get("bbb"), 1);
  });

  it("wraps around the palette and skips uncommitted revisions", () => {
    const entries = Array.from({ length: BLAME_BAND_COUNT + 1 }, (_, i) =>
      at(i + 1, `rev${i}`),
    );
    entries.push(at(99, "0000000000000000000000000000000000000000"));
    const slots = blameBandSlots(entries);
    assert.equal(slots.size, BLAME_BAND_COUNT + 1);
    assert.equal(slots.get(`rev${BLAME_BAND_COUNT}`), 0);
    assert.equal(
      slots.has("0000000000000000000000000000000000000000"),
      false,
    );
  });
});

describe("blameHoverText", () => {
  it("git: head line + commit message", () => {
    assert.equal(
      blameHoverText(gitEntry, "git", NOW),
      "You Yee · d29a7f1 · 2024-01-07\n\nAdd editor area",
    );
  });

  it("git: includes the commit body when present", () => {
    const entry = {
      ...gitEntry,
      summary: "Fix thing\n\nlonger explanation\nsecond line",
    };
    assert.equal(
      blameHoverText(entry, "git", NOW),
      "You Yee · d29a7f1 · 2024-01-07\n\nFix thing\n\nlonger explanation\nsecond line",
    );
  });

  it("escapes markdown-significant characters in the message", () => {
    const entry = { ...gitEntry, summary: "use `x` and *stars*" };
    assert.equal(
      blameHoverText(entry, "git", NOW),
      "You Yee · d29a7f1 · 2024-01-07\n\nuse \\`x\\` and \\*stars\\*",
    );
    assert.equal(
      blameHoverPlainText(entry, "git", NOW),
      "You Yee · d29a7f1 · 2024-01-07\n\nuse `x` and *stars*",
    );
  });

  it("git uncommitted note", () => {
    const entry = { ...gitEntry, rev: "0".repeat(40), author: "Not Committed Yet" };
    assert.equal(blameHoverText(entry, "git", NOW), "you — not committed yet");
  });

  it("svn: rev + author (+date) and the log message", () => {
    const entry = { ...gitEntry, rev: "9", summary: null };
    assert.equal(
      blameHoverText(entry, "svn", NOW),
      "r9 · You Yee · 2024-01-07",
    );
    const noDate = { ...entry, time: null };
    assert.equal(blameHoverText(noDate, "svn", NOW), "r9 · You Yee");
    const withMsg = { ...entry, summary: "Fix thing" };
    assert.equal(
      blameHoverText(withMsg, "svn", NOW),
      "r9 · You Yee · 2024-01-07\n\nFix thing",
    );
  });
});

describe("isUncommitted / shortAuthor", () => {
  it("detects zero-hash, M, empty revs", () => {
    assert.equal(isUncommitted({ ...gitEntry, rev: "0".repeat(40) }), true);
    assert.equal(isUncommitted({ ...gitEntry, rev: "M" }), true);
    assert.equal(isUncommitted({ ...gitEntry, rev: "" }), true);
    assert.equal(isUncommitted(gitEntry), false);
  });

  it("maps git's placeholder author", () => {
    assert.equal(shortAuthor("Not Committed Yet"), "you");
    assert.equal(shortAuthor(""), "—");
  });
});
