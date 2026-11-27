import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  findSvnConflict,
  selectSvnConflictSides,
  svnConflictChoiceError,
  type SvnConflictEntry,
} from "./conflicts.js";

describe("findSvnConflict", () => {
  const conflicts: SvnConflictEntry[] = [
    { path: "Content/Script/TopFunctionView_PC_BP.lua", kind: "text" },
    { path: "Content/Script/AceMomentItem_Mobile_BP.lua", kind: "tree" },
  ];

  it("matches the Windows backslash path the panel got from svn status", () => {
    const match = findSvnConflict(conflicts, "Content\\Script\\TopFunctionView_PC_BP.lua");
    assert.equal(match?.kind, "text");
  });

  it("matches POSIX paths, surrounding spaces and a ./ prefix", () => {
    assert.equal(
      findSvnConflict(conflicts, " ./Content/Script/AceMomentItem_Mobile_BP.lua ")?.kind,
      "tree",
    );
  });

  it("reports no match for a path that is not conflicted", () => {
    assert.equal(findSvnConflict(conflicts, "Content\\Script\\Other.lua"), null);
    assert.equal(findSvnConflict(conflicts, "   "), null);
  });
});

describe("svnConflictChoiceError", () => {
  it("refuses mine/theirs/both for a tree conflict", () => {
    for (const choice of ["mine", "theirs", "both"] as const) {
      assert.match(svnConflictChoiceError("tree", choice) ?? "", /tree conflict/);
    }
    assert.equal(svnConflictChoiceError("tree", "working"), null);
  });

  it("keeps the working-copy fallback for tree conflicts only", () => {
    assert.equal(svnConflictChoiceError("text", "theirs"), null);
    assert.equal(svnConflictChoiceError("text", "both"), null);
    assert.match(svnConflictChoiceError("text", "working") ?? "", /tree conflict/);
  });
});

describe("selectSvnConflictSides", () => {
  it("maps .mine and the two .rN copies onto base and incoming", () => {
    const sides = selectSvnConflictSides(
      ["NFGameplayAbility.cpp.mine", "NFGameplayAbility.cpp.r48213", "NFGameplayAbility.cpp.r48290"],
      "Source/NF/Private/Ability/NFGameplayAbility.cpp",
    );
    assert.deepEqual(sides, {
      mine: "Source/NF/Private/Ability/NFGameplayAbility.cpp.mine",
      base: "Source/NF/Private/Ability/NFGameplayAbility.cpp.r48213",
      incoming: "Source/NF/Private/Ability/NFGameplayAbility.cpp.r48290",
    });
  });

  it("orders the copies by revision, not by directory order", () => {
    const sides = selectSvnConflictSides(
      ["a.txt.r999", "a.txt.r12", "a.txt.mine", "b.txt.r12", "a.txt.r12"],
      "a.txt",
    );
    assert.equal(sides.base, "a.txt.r12");
    assert.equal(sides.incoming, "a.txt.r999");
  });

  it("reports missing copies instead of guessing", () => {
    assert.deepEqual(selectSvnConflictSides(["a.txt.mine"], "a.txt"), {
      mine: "a.txt.mine",
      base: null,
      incoming: null,
    });
    assert.deepEqual(selectSvnConflictSides(["a.txt.r1"], "a.txt"), {
      mine: null,
      base: "a.txt.r1",
      incoming: null,
    });
  });

  it("does not confuse a sibling file that shares the prefix", () => {
    const sides = selectSvnConflictSides(["a.txt.bak.mine", "a.txt.r7", "a.txt.r9"], "a.txt");
    assert.equal(sides.mine, null);
    assert.equal(sides.base, "a.txt.r7");
    assert.equal(sides.incoming, "a.txt.r9");
  });
});
