import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

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
    assert.doesNotMatch(viewSrc, /graph-editor-action-details/);
    assert.doesNotMatch(viewSrc, /onToggleActionHelp/);
    assert.doesNotMatch(viewSrc, /leadingBody/);
  });
});
