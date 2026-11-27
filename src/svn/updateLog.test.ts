import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isSvnUpdateReceivedLetter,
  parseSvnUpdateLogLine,
  parseSvnUpdateRevisionLine,
} from "./updateLog.js";

describe("parseSvnUpdateLogLine", () => {
  it("reads the action letter and the path from a padded line", () => {
    assert.deepEqual(parseSvnUpdateLogLine("U    Content/UI/T_Hero.uasset"), {
      letter: "U",
      path: "Content/UI/T_Hero.uasset",
      propertyOnly: false,
    });
    assert.deepEqual(parseSvnUpdateLogLine("A    Source/New.cpp"), {
      letter: "A",
      path: "Source/New.cpp",
      propertyOnly: false,
    });
    assert.deepEqual(parseSvnUpdateLogLine("D    Config/Old.ini"), {
      letter: "D",
      path: "Config/Old.ini",
      propertyOnly: false,
    });
    assert.deepEqual(parseSvnUpdateLogLine("G    Source/Merged.cpp"), {
      letter: "G",
      path: "Source/Merged.cpp",
      propertyOnly: false,
    });
    assert.deepEqual(parseSvnUpdateLogLine("C    Content/Maps/NF_Hub.umap"), {
      letter: "C",
      path: "Content/Maps/NF_Hub.umap",
      propertyOnly: false,
    });
  });

  it("flags a property-only change and still reports its letter", () => {
    const entry = parseSvnUpdateLogLine(" U   Config/DefaultGame.ini");
    assert.deepEqual(entry, {
      letter: "U",
      path: "Config/DefaultGame.ini",
      propertyOnly: true,
    });
  });

  it("keeps spaces inside a path but trims the CR of a CRLF stream", () => {
    assert.equal(parseSvnUpdateLogLine("U    Content/My Map.umap\r")?.path, "Content/My Map.umap");
  });

  it("ignores headers, revision lines and the conflict summary block", () => {
    const noise = [
      "Updating '.':",
      "Fetching external item into 'Vendor/lib':",
      "Restored 'Content/Old.uasset'",
      "Skipped 'Vendor/lib' -- An obstructing working copy was found",
      "At revision 48290.",
      "Updated to revision 48290.",
      "Summary of conflicts:",
      "  Text conflicts: 1",
      "svn: E155027: Tree conflict can only be resolved to 'working' state",
      "",
      "   ",
    ];
    for (const line of noise) {
      assert.equal(parseSvnUpdateLogLine(line), null, `noise: ${line}`);
    }
  });
});

describe("parseSvnUpdateRevisionLine", () => {
  it("separates an update from an already-current checkout", () => {
    assert.deepEqual(parseSvnUpdateRevisionLine("Updated to revision 48290."), {
      revision: "48290",
      alreadyCurrent: false,
    });
    assert.deepEqual(parseSvnUpdateRevisionLine("At revision 48290."), {
      revision: "48290",
      alreadyCurrent: true,
    });
    assert.equal(parseSvnUpdateRevisionLine("U    a.txt"), null);
  });
});

describe("isSvnUpdateReceivedLetter", () => {
  it("counts only letters that bring content down", () => {
    for (const letter of ["A", "U", "G", "R", "B"] as const) {
      assert.equal(isSvnUpdateReceivedLetter(letter), true, letter);
    }
    for (const letter of ["D", "C"] as const) {
      assert.equal(isSvnUpdateReceivedLetter(letter), false, letter);
    }
  });
});
