import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

describe("SettingView Remote Control card", () => {
  it("keeps connection and sync controls after removing server deployment", () => {
    // SettingView imports Vite `?raw` SVG modules, which the plain Node test
    // loader cannot evaluate. Assert the critical DOM wiring at source level:
    // the deploy-only block is gone, while every normal Relay section is
    // still appended to the card body.
    const source = readFileSync(
      new URL("./SettingView.ts", import.meta.url),
      "utf8",
    );

    assert.match(
      source,
      /body\.append\(\s*toggleRow,\s*fieldRow\("Server URL", serverUrlInput\),\s*gridTop,\s*gridBottom,\s*pushHint,\s*connLine,\s*msSection,\s*\)/,
    );
    assert.doesNotMatch(source, /deployRelay|onRelayDeployProgress|setting-deploy/);
  });
});
