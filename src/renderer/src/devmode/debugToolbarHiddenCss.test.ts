import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("./devmode.css", import.meta.url), "utf8");

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`(^|\\n)${escaped}\\s*\\{([\\s\\S]*?)\\}`));
  assert.ok(match, `missing rule: ${selector}`);
  return match[2];
}

function token(block: string, name: string): string {
  const match = block.match(new RegExp(`(^|[;{\\s])${name}:\\s*([^;]+);`));
  assert.ok(match, `missing token: ${name}`);
  return match[2].replace(/\s+/g, " ").trim();
}

test("debug toolbar actions keep the hidden attribute effective", () => {
  // The base rule is an author-level display, which outranks the UA [hidden] rule.
  assert.equal(token(rule(".devmode-debug-action"), "display"), "inline-flex");
  assert.equal(token(rule(".devmode-debug-action[hidden]"), "display"), "none");
});
