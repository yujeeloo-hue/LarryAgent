import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SourceMapIndex, debugPathsReferToSameFile } from "./sourceMap.js";

describe("SourceMapIndex", () => {
  it("maps original TS lines to generated JS and back", () => {
    // Map lives at out/main/; electron-vite sources are usually ../../src/...
    // "AAAA" = generated (0,0) ← source 0, original (0,0)
    const map = SourceMapIndex.parse({
      version: 3,
      sources: ["../../src/main/app.ts"],
      mappings: "AAAA",
    }, "file:///E:/app/out/main/index.js.map");
    const generated = map.generatedPositionFor("file:///E:/app/src/main/app.ts", 1);
    assert.ok(generated);
    assert.equal(generated!.line, 0);
    const original = map.originalPositionFor(0, 0);
    assert.ok(original);
    assert.equal(original!.line, 1);
    assert.match(original!.source, /src\/main\/app\.ts$/);
  });

  it("matches Vite basename sources against the workspace file", () => {
    const map = SourceMapIndex.parse(
      {
        version: 3,
        sources: ["SettingController.ts"],
        mappings: "AAAA",
      },
      "http://localhost:5173/src/screens/setting/SettingController.ts",
    );
    const generated = map.generatedPositionFor(
      "E:/app/src/renderer/src/screens/setting/SettingController.ts",
      1,
    );
    assert.ok(generated);
    assert.equal(generated!.line, 0);
  });
});

describe("debugPathsReferToSameFile", () => {
  it("treats Vite /src/… URLs as files under src/renderer", () => {
    assert.equal(
      debugPathsReferToSameFile(
        "http://localhost:5173/src/screens/setting/SettingController.ts",
        "E:/app/src/renderer/src/screens/setting/SettingController.ts",
      ),
      true,
    );
    assert.equal(
      debugPathsReferToSameFile(
        "E:/app/src/main/index.ts",
        "E:/app/src/renderer/src/index.ts",
      ),
      false,
    );
  });
});
