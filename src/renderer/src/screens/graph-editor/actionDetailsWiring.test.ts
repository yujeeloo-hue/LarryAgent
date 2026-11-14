import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * Text-scan regression (same pattern as fsmGraphTool port wiring): object
 * spreads skip excess-property checks, so a dropped `details` / `helpOpen`
 * hop between catalog → controller → view would typecheck clean and
 * silently vanish. These assertions pin the wiring in place.
 */
describe("graph editor action details wiring", () => {
  const controllerSrc = readFileSync(
    new URL("./GraphEditorController.ts", import.meta.url),
    "utf8",
  );
  const viewSrc = readFileSync(
    new URL("./GraphEditorView.ts", import.meta.url),
    "utf8",
  );

  it("controller reads schema details and threads them to overlay + shell", () => {
    assert.match(controllerSrc, /import \{ schemaDetails \} from "\.\/actionDetails\.js"/);
    assert.match(controllerSrc, /details: catalogDetails\(entry\)/);
    assert.match(controllerSrc, /details: catalogDetails\(catalog\)/);
  });

  it("view shows the [?] help as the same rich float, no in-card panel", () => {
    assert.match(viewSrc, /bindDetailsTip,/);
    assert.match(viewSrc, /bindDetailsTip\(row, \{/);
    assert.match(viewSrc, /bindDetailsTip\(\s*chip,\s*\{ title: action\.label, subtitle: action\.type, body: details \},\s*\{ pinOnClick: true \},/s);
    // The card must not embed a collapsible panel (it changes card height).
    assert.doesNotMatch(viewSrc, /graph-editor-action-details/);
    assert.doesNotMatch(viewSrc, /onToggleActionHelp/);
    assert.doesNotMatch(viewSrc, /leadingBody/);
  });
});
