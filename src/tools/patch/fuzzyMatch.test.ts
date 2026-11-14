import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { diffChars } from "diff";
import {
  fuzzyFindAndReplace,
  isAlreadyApplied,
  formatNoMatchHint,
  similarityRatio,
} from "./fuzzyMatch.js";

describe("fuzzyFindAndReplace", () => {
  it("exact unique replace", () => {
    const r = fuzzyFindAndReplace("one\ntwo\nthree\n", "two", "TWO");
    assert.equal(r.error, null);
    assert.equal(r.matchCount, 1);
    assert.equal(r.strategy, "exact");
    assert.equal(r.content, "one\nTWO\nthree\n");
  });

  it("line-trimmed indent match and reindent write-back", () => {
    const file = "function f() {\n    return 1;\n}\n";
    const r = fuzzyFindAndReplace(
      file,
      "function f() {\n  return 1;\n}",
      "function f() {\n  return 2;\n}",
    );
    assert.equal(r.error, null);
    assert.ok(r.strategy === "line_trimmed" || r.strategy === "indentation_flexible");
    assert.match(r.content, /return 2/);
  });

  it("rejects identical strings", () => {
    const r = fuzzyFindAndReplace("abc", "abc", "abc");
    assert.match(r.error ?? "", /identical/);
  });

  it("ambiguous without replace_all", () => {
    const r = fuzzyFindAndReplace("foo\nbar\nfoo\n", "foo", "baz");
    assert.equal(r.matchCount, 0);
    assert.match(r.error ?? "", /Found 2 matches/);
  });

  it("replace_all", () => {
    const r = fuzzyFindAndReplace("foo\nbar\nfoo\n", "foo", "baz", true);
    assert.equal(r.content, "baz\nbar\nbaz\n");
    assert.equal(r.matchCount, 2);
  });
});

/** Reference implementation this metric replaced (character-level Myers). */
function ratioViaDiffChars(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  let same = 0;
  for (const part of diffChars(a, b)) {
    if (!part.added && !part.removed) same += part.value.length;
  }
  return (2 * same) / (a.length + b.length);
}

describe("similarityRatio", () => {
  it("handles identical, empty and disjoint inputs", () => {
    assert.equal(similarityRatio("abc", "abc"), 1);
    assert.equal(similarityRatio("", ""), 1);
    assert.equal(similarityRatio("abc", ""), 0);
    assert.equal(similarityRatio("", "abc"), 0);
    assert.equal(similarityRatio("aaaa", "bbbb"), 0);
  });

  it("matches the character-diff reference on random inputs", () => {
    // Deterministic PRNG: a flaky similarity metric would silently change
    // which fuzzy patch candidates are accepted.
    let seed = 0x2f6e2b1;
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const alphabet = "ab c\n{}();xyz_1";
    const randomString = (maxLen: number): string => {
      const len = Math.floor(rand() * maxLen);
      let out = "";
      for (let i = 0; i < len; i += 1) {
        out += alphabet[Math.floor(rand() * alphabet.length)];
      }
      return out;
    };

    for (let i = 0; i < 400; i += 1) {
      const a = randomString(60);
      const b = randomString(60);
      assert.equal(
        similarityRatio(a, b),
        ratioViaDiffChars(a, b),
        `mismatch for ${JSON.stringify(a)} vs ${JSON.stringify(b)}`,
      );
    }
  });

  it("matches the reference on realistic code lines", () => {
    const pairs: Array<[string, string]> = [
      ["  const a = compute(1);", "  const a = compute(2);"],
      ["function handle(req, res) {", "function handle(request, response) {"],
      ["\t\treturn value;", "    return value;"],
      ["第三方模型返回的内容", "第三方模型返回的中文内容"],
      ["}", "});"],
    ];
    for (const [a, b] of pairs) {
      assert.equal(similarityRatio(a, b), ratioViaDiffChars(a, b), `${a} vs ${b}`);
    }
  });

  it("stays fast on large blocks that used to take seconds", () => {
    const block = (salt: string): string => {
      const lines: string[] = [];
      for (let i = 0; i < 400; i += 1) {
        lines.push(`  const value${i}${salt} = compute(${i}, "${salt}");`);
      }
      return lines.join("\n");
    };
    const a = block("alpha");
    const b = block("beta_variant");
    const startedAt = Date.now();
    const ratio = similarityRatio(a, b);
    const elapsed = Date.now() - startedAt;
    assert.ok(ratio > 0 && ratio < 1);
    assert.ok(elapsed < 1_000, `large-block similarity took ${elapsed}ms`);
  });

  it("rejects size-mismatched candidates via minRatio without diffing", () => {
    const short = "abc";
    const long = "abc".repeat(200);
    assert.ok(similarityRatio(short, long, 0.8) < 0.8);
    // Without the hint the true ratio is still returned.
    assert.equal(similarityRatio(short, long), ratioViaDiffChars(short, long));
  });
});

describe("isAlreadyApplied", () => {
  it("detects a landed unique replacement", () => {
    assert.equal(
      isAlreadyApplied("hello world and more", "hello there and more", "hello world and more"),
      true,
    );
  });

  it("rejects when old_string is still present", () => {
    assert.equal(isAlreadyApplied("hello there and more", "hello there and more", "hello world and more"), false);
  });
});

describe("formatNoMatchHint", () => {
  it("appends a closest-section snippet", () => {
    const hint = formatNoMatchHint(
      "Could not find a match for old_string in the file",
      0,
      "bravo line here",
      "alpha\nzebra\ncharlie\n",
    );
    assert.match(hint, /Did you mean/);
    assert.match(hint, /zebra/);
  });
});
