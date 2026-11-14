import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/** Gate for the Outline row icon ink.
 *
 * Every symbol kind the view can render must reach a kind-driven color, so a
 * new `DocumentSymbolKind` (or a dropped `data-kind`) can't silently fall back
 * to the flat `--fg-muted` default. Types, functions and variables stay
 * distinct in both themes.
 */
const css = readFileSync(new URL("./devmode.css", import.meta.url), "utf8");

const KIND_GROUPS = {
  type: ["class", "interface", "struct", "enum", "type"],
  function: ["function"],
  variable: ["variable"],
} as const;

function inkFor(kind: string): string | null {
  const match = css.match(
    new RegExp(
      `\\.devmode-doc-outline-icon\\[data-kind="${kind}"\\][^{]*\\{[^}]*color:\\s*var\\((--[a-z-]+)\\)`,
    ),
  );
  return match ? match[1] : null;
}

test("every outline symbol kind maps to a kind color", () => {
  const inks = new Map<string, string>();
  for (const kinds of Object.values(KIND_GROUPS)) {
    const first = inkFor(kinds[0]);
    assert.ok(first, `missing icon ink for kind: ${kinds[0]}`);
    for (const kind of kinds) {
      assert.equal(inkFor(kind), first, `kind ${kind} drifted from ${kinds[0]}`);
    }
    inks.set(kinds[0], first);
  }
  assert.equal(new Set(inks.values()).size, 3, "types / functions / variables must differ");
});

test("outline kind colors are theme-aware", () => {
  // The card chrome rule is also `.devmode-doc-outline { … }`, so anchor on the
  // ink declaration instead of the first block with that selector.
  const dark = css.match(/\.devmode-doc-outline\s*\{([^}]*--outline-kind-type[^}]*)\}/);
  assert.ok(dark, "missing .devmode-doc-outline scope");
  const light = css.match(/:root\[data-theme="light"\] \.devmode-doc-outline\s*\{([^}]*)\}/);
  assert.ok(light, "missing light-theme outline ink override");
  for (const name of ["--outline-kind-type", "--outline-kind-fn", "--outline-kind-var"]) {
    assert.match(dark[1], new RegExp(`${name}:\\s*#[0-9a-f]{6}`));
    assert.match(light[1], new RegExp(`${name}:\\s*#[0-9a-f]{6}`));
  }
});

test("access rows stay iconless, so no ink rule is needed for them", () => {
  assert.equal(inkFor("access"), null);
});
