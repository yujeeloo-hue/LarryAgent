import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildProjectFileTree, type ProjectFileNode } from "./projectItemTree.js";

const ROOT = "E:/Game";

function collectFiles(nodes: ProjectFileNode[]): string[] {
  const out: string[] = [];
  const walk = (list: ProjectFileNode[]): void => {
    for (const n of list) {
      if (n.isDir) walk(n.children);
      else out.push(n.path);
    }
  };
  walk(nodes);
  return out;
}

describe("buildProjectFileTree", () => {
  it("nests files under dirs, dirs-first, sorted", () => {
    const tree = buildProjectFileTree(ROOT, [
      `${ROOT}/Source/Game/Main.cpp`,
      `${ROOT}/Readme.md`,
      `${ROOT}/Source/Game/Util.h`,
      `${ROOT}/Source/Zeta.cpp`,
    ]);
    assert.ok(tree);
    assert.deepEqual(
      tree.map((n) => n.name),
      ["Source", "Readme.md"],
    );
    const source = tree[0]!;
    assert.deepEqual(
      source.children.map((n) => n.name),
      ["Game", "Zeta.cpp"],
    );
    assert.deepEqual(
      source.children[0]!.children.map((n) => n.name),
      ["Main.cpp", "Util.h"],
    );
  });

  it("attaches direct children of projectDir (regression: orphaned Source/)", () => {
    // Old bug: ensureDir only attached when parent was strictly *under*
    // projectDir — Source/Plugins never attached, tree came back empty.
    const tree = buildProjectFileTree(ROOT, [
      `${ROOT}/Source/NF/NF.Build.cs`,
      `${ROOT}/Plugins/Wwise/Wwise.Build.cs`,
    ]);
    assert.ok(tree);
    assert.deepEqual(
      tree.map((n) => n.name),
      ["Plugins", "Source"],
    );
    assert.equal(collectFiles(tree).length, 2);
  });

  it("drops paths outside the project root", () => {
    const tree = buildProjectFileTree(ROOT, [
      `${ROOT}/Source/NF/NF.Build.cs`,
      "E:/Elsewhere/Other.cpp",
    ]);
    assert.ok(tree);
    assert.deepEqual(collectFiles(tree), [`${ROOT}/Source/NF/NF.Build.cs`]);
  });

  it("returns null for empty / no-under-root input", () => {
    assert.equal(buildProjectFileTree(ROOT, []), null);
    assert.equal(buildProjectFileTree("", [`${ROOT}/a.cpp`]), null);
    assert.equal(
      buildProjectFileTree(ROOT, ["E:/Elsewhere/Other.cpp"]),
      null,
    );
  });

  it("handles NF-scale item lists without pathological behavior", () => {
    const paths: string[] = [];
    for (let i = 0; i < 9000; i++) {
      paths.push(`${ROOT}/Source/Module${Math.floor(i / 100)}/File${i}.cpp`);
    }
    const start = performance.now();
    const tree = buildProjectFileTree(ROOT, paths);
    const ms = performance.now() - start;
    assert.ok(tree);
    assert.equal(tree.length, 1);
    assert.equal(tree[0]!.children.length, 90);
    assert.equal(collectFiles(tree).length, 9000);
    assert.ok(ms < 500, `took ${ms}ms`);
  });

  it("sorts mixed-case names with localeCompare semantics", () => {
    const tree = buildProjectFileTree(ROOT, [
      `${ROOT}/apple.cpp`,
      `${ROOT}/Banana.cpp`,
      `${ROOT}/zebra.cpp`,
    ]);
    assert.ok(tree);
    assert.deepEqual(
      tree.map((n) => n.name),
      ["apple.cpp", "Banana.cpp", "zebra.cpp"],
    );
  });
});
