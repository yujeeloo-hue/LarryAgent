import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("./EditorAreaController.ts", import.meta.url),
  "utf8",
);

function escapeCommand(): string {
  const match = source.match(
    /addCommand\(monaco\.KeyCode\.Escape, \(\) => \{([\s\S]*?)\n {4}\}\);/,
  );
  assert.ok(match, "Escape is bound on the editor");
  return match[1]!;
}

test("Escape closes an open completion list before any other editor escape", () => {
  const body = escapeCommand();
  assert.match(
    body,
    /^\s*\n\s*if \(this\.dismissSuggest\(this\.editor\)\) return;/,
    "the suggest session owns Escape when it is open",
  );
  const dismissAt = body.indexOf("dismissSuggest");
  assert.ok(dismissAt >= 0, "the completion list is consulted");
  assert.ok(
    dismissAt < body.indexOf("onEscape"),
    "closing the list must not also close the find widget",
  );
  assert.ok(
    dismissAt < body.indexOf("inlineSuggest.hide"),
    "closing the list comes before hiding the inline suggestion",
  );
});
