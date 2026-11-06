/**
 * Agent line flash — pure range math (clamp / EOF resolve / merge / cap)
 * and V4A patch hunk parsing. No DOM/Monaco.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AGENT_FLASH_MAX_RANGES,
  normalizeFlashRanges,
} from "./agentFlash.js";
import { patchChangedRangesFromText } from "../screens/conversation/cards/parsePartialWriteArgs.js";
import {
  matchFlashRanges,
  patchResultFlashRanges,
} from "../screens/conversation/cards/resultContent.js";

describe("normalizeFlashRanges", () => {
  it("resolves end:null to EOF and clamps to the real line count", () => {
    assert.deepEqual(
      normalizeFlashRanges([{ start: 3, end: null, kind: "read" }], 10),
      [{ start: 3, end: 10, kind: "read" }],
    );
    assert.deepEqual(
      normalizeFlashRanges([{ start: 8, end: 99, kind: "add" }], 10),
      [{ start: 8, end: 10, kind: "add" }],
    );
  });

  it("whole-file write wash: start 1 through EOF survives as one range", () => {
    // Replace-mode write_file sends exactly this — the opened file's
    // entire content washes once.
    assert.deepEqual(
      normalizeFlashRanges([{ start: 1, end: null, kind: "write" }], 42),
      [{ start: 1, end: 42, kind: "write" }],
    );
    // Empty file (lineCount clamped to 1): still a single line-1 wash.
    assert.deepEqual(
      normalizeFlashRanges([{ start: 1, end: null, kind: "write" }], 1),
      [{ start: 1, end: 1, kind: "write" }],
    );
  });

  it("drops non-positive starts and collapses inverted ranges", () => {
    assert.deepEqual(
      normalizeFlashRanges(
        [
          { start: 0, end: 5, kind: "del" },
          { start: 5, end: 2, kind: "del" },
        ],
        10,
      ),
      [{ start: 5, end: 5, kind: "del" }],
    );
  });

  it("merges same-kind touching runs but keeps kinds separate", () => {
    assert.deepEqual(
      normalizeFlashRanges(
        [
          { start: 2, end: 4, kind: "add" },
          { start: 5, end: 6, kind: "add" },
          { start: 5, end: 6, kind: "del" },
        ],
        10,
      ),
      [
        { start: 2, end: 6, kind: "add" },
        { start: 5, end: 6, kind: "del" },
      ],
    );
  });

  it("caps the decoration count", () => {
    const ranges = Array.from({ length: 40 }, (_, i) => ({
      start: i * 2 + 1,
      end: i * 2 + 1,
      kind: "add" as const,
    }));
    const out = normalizeFlashRanges(ranges, 100);
    assert.equal(out.length, AGENT_FLASH_MAX_RANGES);
  });
});

describe("patchChangedRangesFromText", () => {
  it("maps hunks to new-file add/del ranges per file", () => {
    const plan = patchChangedRangesFromText(
      [
        "*** Begin Patch",
        "*** Update File: src/a.ts",
        "@@ -10,4 +10,5 @@",
        " ctx",
        "-old",
        "-older",
        "+new",
        " ctx",
        "*** Update File: src/b.ts",
        "@@ -1 +1 @@",
        "-x",
        "+y",
        "*** End Patch",
      ].join("\n"),
    );
    assert.deepEqual(
      plan.map((f) => f.path),
      ["src/a.ts", "src/b.ts"],
    );
    // Deleted lines collapse onto the new-side line that replaced them —
    // the add and del flashes share that line (add reveals first).
    assert.deepEqual(plan[0]!.ranges, [
      { start: 11, end: 11, kind: "add" },
      { start: 11, end: 11, kind: "del" },
    ]);
    assert.deepEqual(plan[1]!.ranges, [
      { start: 1, end: 1, kind: "add" },
      { start: 1, end: 1, kind: "del" },
    ]);
  });

  it("multi-hunk coordinates follow the new-file line numbering", () => {
    // Hunk 1 replaces old 5-6 with two adds; hunk 2 deletes old 9.
    // New file after apply: 1,2,3,4,5a,6a,7,8,10,11,12 → the second
    // hunk's surviving context lands on new line 10 (+10,1 header).
    const plan = patchChangedRangesFromText(
      [
        "*** Update File: src/a.ts",
        "@@ -4,7 +4,8 @@",
        " line 4",
        "-line 5",
        "-line 6",
        "+line 5a",
        "+line 6a",
        " line 7",
        " line 8",
        "@@ -9,2 +10,1 @@",
        "-line 9",
        " line 10",
      ].join("\n"),
    );
    assert.deepEqual(plan[0]!.ranges, [
      { start: 5, end: 6, kind: "add" },
      { start: 5, end: 5, kind: "del" },
      { start: 10, end: 10, kind: "del" },
    ]);
  });

  it("flashes a whole-file Add through EOF via a plain end line", () => {
    const plan = patchChangedRangesFromText(
      [
        "*** Begin Patch",
        "*** Add File: docs/new.md",
        "+one",
        "+two",
        "*** End Patch",
      ].join("\n"),
    );
    assert.deepEqual(plan[0]!.ranges, [
      { start: 1, end: 2, kind: "add" },
    ]);
  });

  it("merges consecutive same-kind lines into one run", () => {
    const plan = patchChangedRangesFromText(
      [
        "*** Update File: c.ts",
        "@@ -5,3 +5,6 @@",
        " keep",
        "+a",
        "+b",
        "+c",
        " keep",
      ].join("\n"),
    );
    assert.deepEqual(plan[0]!.ranges, [{ start: 6, end: 8, kind: "add" }]);
  });

  it("opens Delete targets without flash ranges", () => {
    const plan = patchChangedRangesFromText(
      [
        "*** Begin Patch",
        "*** Delete File: gone.ts",
        "*** Update File: keep.ts",
        "@@ -1 +1 @@",
        "-a",
        "+b",
        "*** End Patch",
      ].join("\n"),
    );
    assert.deepEqual(
      plan.map((f) => f.path),
      ["keep.ts"],
    );
  });

  it("returns empty for bodies without V4A headers", () => {
    assert.deepEqual(patchChangedRangesFromText("nope\nnothing"), []);
  });
});

describe("patchResultFlashRanges", () => {
  const diffPart = (
    rows: Array<[string, number | null, number | null]>,
  ): Record<string, unknown> => ({
    type: "text",
    id: "file_diff",
    text: JSON.stringify(
      {
        lines: rows.map(([kind, oldLine, newLine]) => ({
          kind,
          oldLine,
          newLine,
          text: kind,
        })),
      },
    ),
  });
  const reportPart = (lines: string[]): Record<string, unknown> => ({
    type: "text",
    text: lines.join("\n"),
  });

  it("anchors adds and replacements on true new-side lines", () => {
    const map = patchResultFlashRanges([
      reportPart(["Patching file src/a.ts"]),
      diffPart([
        ["equal", 9, 9],
        ["del", 10, null],
        ["add", null, 10],
        ["add", null, 11],
        ["equal", 11, 12],
      ]),
    ]);
    assert.deepEqual(map.get("src/a.ts"), [
      { start: 10, end: 10, kind: "del" },
      { start: 10, end: 11, kind: "add" },
    ]);
  });

  it("anchors pure deletions on the next surviving line", () => {
    const map = patchResultFlashRanges([
      reportPart(["Patching file b.ts"]),
      diffPart([
        ["equal", 4, 4],
        ["del", 5, null],
        ["equal", 6, 5],
      ]),
    ]);
    assert.deepEqual(map.get("b.ts"), [
      { start: 5, end: 5, kind: "del" },
    ]);
  });

  it("anchors an EOF deletion on the last surviving line", () => {
    const map = patchResultFlashRanges([
      reportPart(["Patching file c.ts"]),
      diffPart([
        ["equal", 7, 7],
        ["del", 8, null],
      ]),
    ]);
    assert.deepEqual(map.get("c.ts"), [
      { start: 7, end: 7, kind: "del" },
    ]);
  });

  it("zips multiple diffs with their report lines", () => {
    const map = patchResultFlashRanges([
      reportPart(["Patching file one.ts", "Patching file two.ts"]),
      diffPart([["add", null, 3]]),
      diffPart([
        ["add", null, 8],
        ["add", null, 9],
      ]),
    ]);
    assert.deepEqual(map.get("one.ts"), [
      { start: 3, end: 3, kind: "add" },
    ]);
    assert.deepEqual(map.get("two.ts"), [
      { start: 8, end: 9, kind: "add" },
    ]);
  });

  it("returns an empty map without diff parts", () => {
    assert.equal(patchResultFlashRanges(undefined).size, 0);
    assert.equal(
      patchResultFlashRanges([{ type: "text", text: "nope" }]).size,
      0,
    );
  });

  it("matches absolute report paths to relative plan paths", () => {
    const map = new Map([
      ["/Users/you/dev/app/src/a.ts", [{ start: 3, end: 4, kind: "add" }]],
      ["pkg/b.ts", [{ start: 9, end: 9, kind: "del" }]],
    ]);
    // Absolute report key vs relative plan path.
    assert.deepEqual(matchFlashRanges(map, "src/a.ts"), [
      { start: 3, end: 4, kind: "add" },
    ]);
    // Relative report key vs absolute plan path.
    assert.deepEqual(matchFlashRanges(map, "/repo/pkg/b.ts"), [
      { start: 9, end: 9, kind: "del" },
    ]);
    // Exact hit.
    assert.deepEqual(matchFlashRanges(map, "pkg/b.ts"), [
      { start: 9, end: 9, kind: "del" },
    ]);
    // No hit — undefined (caller keeps the args-parsed ranges).
    assert.equal(matchFlashRanges(map, "other.ts"), undefined);
  });

  it("prefers the explicit part.path over the report-text zip", () => {
    const map = patchResultFlashRanges([
      reportPart(["Patching file one.ts"]),
      { ...diffPart([["add", null, 5]]), path: "/abs/two.ts" },
    ]);
    assert.equal(map.has("one.ts"), false);
    assert.deepEqual(map.get("/abs/two.ts"), [
      { start: 5, end: 5, kind: "add" },
    ]);
  });

  it("legacy zip ignores 'Deleting file' lines (no diff part behind them)", () => {
    const map = patchResultFlashRanges([
      reportPart(["Deleting file gone.ts", "Patching file kept.ts"]),
      diffPart([["add", null, 2]]),
    ]);
    assert.equal(map.has("gone.ts"), false);
    assert.deepEqual(map.get("kept.ts"), [
      { start: 2, end: 2, kind: "add" },
    ]);
  });

  it("skips diffs the clipped report can no longer pair — never guesses", () => {
    const map = patchResultFlashRanges([
      reportPart(["Patching file one.ts", "[…truncated…]"]),
      diffPart([["add", null, 3]]),
      diffPart([["add", null, 8]]),
    ]);
    assert.deepEqual(map.get("one.ts"), [
      { start: 3, end: 3, kind: "add" },
    ]);
    assert.equal(map.size, 1);
  });

  it("refuses ambiguous suffix matches", () => {
    const map = new Map([
      ["/ws/a.ts", [{ start: 1, end: 1, kind: "add" }]],
      ["/ws/x/a.ts", [{ start: 9, end: 9, kind: "add" }]],
    ]);
    assert.equal(matchFlashRanges(map, "a.ts"), undefined);
    // Unambiguous suffix still resolves.
    assert.deepEqual(matchFlashRanges(map, "x/a.ts"), [
      { start: 9, end: 9, kind: "add" },
    ]);
  });
});
