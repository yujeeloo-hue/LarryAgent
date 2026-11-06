import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyV4aOperations, parseV4aPatch } from "./v4a.js";

describe("parseV4aPatch", () => {
  it("parses Update / Add / Delete / Move", () => {
    const text = [
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "@@ fn @@",
      " keep",
      "-old",
      "+new",
      "*** Add File: src/b.ts",
      "+hello",
      "*** Delete File: src/c.ts",
      "*** Move File: src/d.ts -> src/e.ts",
      "*** End Patch",
    ].join("\n");
    const { operations, error } = parseV4aPatch(text);
    assert.equal(error, null);
    assert.equal(operations.length, 4);
    assert.equal(operations[0]?.kind, "update");
    assert.equal(operations[0]?.filePath, "src/a.ts");
    assert.equal(operations[0]?.hunks[0]?.contextHint, "fn");
    assert.equal(operations[1]?.kind, "add");
    assert.equal(operations[2]?.kind, "delete");
    assert.equal(operations[3]?.kind, "move");
    assert.equal(operations[3]?.newPath, "src/e.ts");
  });

  it("treats unprefixed lines as context", () => {
    const { operations, error } = parseV4aPatch(
      "*** Update File: x.ts\nkeep\n-old\n+new\nkeep\n",
    );
    assert.equal(error, null);
    const prefixes = operations[0]?.hunks[0]?.lines.map((l) => l.prefix);
    assert.deepEqual(prefixes, [" ", "-", "+", " "]);
  });
});

describe("applyV4aOperations", () => {
  it("updates a file in memory", () => {
    const files: Record<string, string> = { "a.txt": "one\ntwo\nthree\n" };
    const parsed = parseV4aPatch(
      "*** Update File: a.txt\n one\n-two\n+TWO\n three\n",
    );
    const result = applyV4aOperations(parsed.operations, (p) => files[p] ?? null);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.files[0]?.after, "one\nTWO\nthree\n");
  });

  it("skips an already-applied hunk and still applies the rest", () => {
    const files: Record<string, string> = { "a.txt": "one\nTWO\nthree\nfour\n" };
    const parsed = parseV4aPatch(
      [
        "*** Update File: a.txt",
        " one",
        "-two",
        "+TWO",
        " three",
        "@@",
        " three",
        "-four",
        "+FOUR",
      ].join("\n"),
    );
    const result = applyV4aOperations(parsed.operations, (p) => files[p] ?? null);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.files[0]?.after, "one\nTWO\nthree\nFOUR\n");
  });

  it("fails without mutating when a hunk is missing", () => {
    const files: Record<string, string> = { "a.txt": "alpha\nzebra\n" };
    const parsed = parseV4aPatch("*** Update File: a.txt\n alpha\n-bravo\n+BRAVO\n");
    const result = applyV4aOperations(parsed.operations, (p) => files[p] ?? null);
    assert.equal(result.ok, false);
  });
});
