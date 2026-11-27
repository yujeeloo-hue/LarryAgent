import assert from "node:assert/strict";
import test from "node:test";
import { globToRegExp, includeMatches } from "./glob.js";

test("glob patterns map to the paths rule authors expect", () => {
  const cases: Array<[string, string, boolean]> = [
    ["**/*.ts", "src/lint/engine.ts", true],
    ["**/*.ts", "engine.ts", true],
    ["src/**/*.ts", "src/lint/engine.ts", true],
    ["src/**/*.ts", "src/engine.ts", true],
    ["src/**/*.ts", "relay/web/src/a.ts", false],
    ["src/*.ts", "src/engine.ts", true],
    ["src/*.ts", "src/lint/engine.ts", false],
    ["*.{ts,mjs}", "lint.mjs", true],
    ["*.{ts,mjs}", "lint.js", false],
    ["src/**", "src/lint/engine.ts", true],
    ["a?c.ts", "abc.ts", true],
    ["a?c.ts", "ac.ts", false],
    ["src/lint/engine.ts", "src/lint/engine.ts", true],
  ];
  for (const [pattern, path, expected] of cases) {
    assert.equal(globToRegExp(pattern).test(path), expected, `${pattern} vs ${path}`);
  }
});

test("a rule without include covers every file and include entries are OR-ed", () => {
  assert.equal(includeMatches("src/a.ts", undefined), true);
  assert.equal(includeMatches("src/a.ts", []), true);
  assert.equal(includeMatches("src/a.ts", ["**/*.mjs"]), false);
  assert.equal(includeMatches("src/a.ts", ["**/*.mjs", "src/*.ts"]), true);
});
