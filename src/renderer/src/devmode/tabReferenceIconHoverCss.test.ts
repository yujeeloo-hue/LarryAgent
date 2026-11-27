import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("./devmode.css", import.meta.url), "utf8");
const hoverCapableCss = css.slice(0, css.indexOf("@media (hover: none)"));

function visibilityRules(section: string): Array<{ selector: string; visibility: string }> {
  const rules: Array<{ selector: string; visibility: string }> = [];
  for (const match of section.matchAll(/(^|\n)([^{}\n][^{}]*?)\{([^{}]*?)\}/g)) {
    const selector = match[2].replace(/\s+/g, " ").trim();
    if (!selector.includes(".devmode-tab")) continue;
    const visibility = /visibility:\s*(hidden|visible)/.exec(match[3])?.[1];
    if (visibility) rules.push({ selector, visibility });
  }
  return rules;
}

test("the tab icon swap is scoped to the reference button, not the whole tab", () => {
  const rules = visibilityRules(hoverCapableCss);
  assert.ok(!rules.some((rule) => rule.selector.includes(".devmode-tab:hover")));
  assert.ok(
    rules.some(
      (rule) =>
        rule.selector.startsWith(".devmode-tab-reference:hover") &&
        rule.selector.includes("> .devmode-tab-icon") &&
        rule.visibility === "hidden",
    ),
    "hovering the reference button hides the language icon",
  );
  assert.ok(
    rules.some(
      (rule) =>
        rule.selector.startsWith(".devmode-tab-reference:hover") &&
        rule.selector.includes("> .devmode-tab-reference-icon") &&
        rule.visibility === "visible",
    ),
    "hovering the reference button reveals the reference icon",
  );
});

test("keyboard focus keeps the same icon swap without a tab hover", () => {
  const rules = visibilityRules(hoverCapableCss);
  assert.ok(
    rules.some(
      (rule) =>
        rule.selector.includes(".devmode-tab-reference:focus-visible") &&
        rule.selector.includes("> .devmode-tab-icon") &&
        rule.visibility === "hidden",
    ),
  );
  assert.ok(
    rules.some(
      (rule) =>
        rule.selector.includes(".devmode-tab-reference:focus-visible") &&
        rule.selector.includes("> .devmode-tab-reference-icon") &&
        rule.visibility === "visible",
    ),
  );
});
