import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  candidateWorkspaceFiles,
  cdpBreakpointLocations,
  scriptUrlMatchesFile,
  urlRegexCandidates,
} from "./cdpBreakpointUrl.js";
import { SourceMapIndex } from "./sourceMap.js";

const root = "E:/app";
const file = "E:/app/src/renderer/src/screens/setting/SettingController.ts";
const viteUrl =
  "http://localhost:5173/src/screens/setting/SettingController.ts";

describe("scriptUrlMatchesFile", () => {
  it("matches Vite HTTP URLs under src/renderer", () => {
    assert.equal(scriptUrlMatchesFile(viteUrl, file), true);
    assert.equal(
      scriptUrlMatchesFile(
        "http://localhost:5173/@fs/E:/app/src/renderer/src/screens/setting/SettingController.ts",
        file,
      ),
      true,
    );
    assert.equal(
      scriptUrlMatchesFile("http://localhost:5173/src/screens/setting/Other.ts", file),
      false,
    );
  });
});

describe("cdpBreakpointLocations", () => {
  it("regex fallbacks include the Vite root-relative path", () => {
    const locs = cdpBreakpointLocations(file, 619, root, []);
    const patterns = locs.map((loc) => loc.urlRegex).filter(Boolean).join("\n");
    assert.match(patterns, /src\/screens\/setting\/SettingController\\.ts/);
    assert.equal(
      locs.every((loc) => loc.lineNumber === 618),
      true,
    );
  });

  it("uses the generated line on the live script URL", () => {
    const map = SourceMapIndex.parse(
      {
        version: 3,
        sources: ["SettingController.ts"],
        mappings: "AAAA",
      },
      viteUrl,
    );
    const locs = cdpBreakpointLocations(file, 1, root, [
      { url: viteUrl, map },
    ]);
    assert.deepEqual(locs, [{ url: viteUrl, lineNumber: 0 }]);
  });
});

describe("urlRegexCandidates", () => {
  it("does not use the bare filename as a pattern", () => {
    const patterns = urlRegexCandidates(file, root);
    assert.equal(
      patterns.some((p) => p === "SettingController\\.ts(?:\\?|#|$)"),
      false,
    );
  });
});

describe("candidateWorkspaceFiles", () => {
  it("prefers electron-vite renderer root for /src/… URLs", () => {
    const files = candidateWorkspaceFiles(viteUrl, root);
    assert.ok(
      files.some(
        (p) =>
          p.replace(/\\/g, "/") ===
          "E:/app/src/renderer/src/screens/setting/SettingController.ts",
      ),
    );
  });
});
