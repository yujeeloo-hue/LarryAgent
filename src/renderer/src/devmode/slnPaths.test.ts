import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  baseNameOf,
  commonAncestorDirOf,
  isUeEngineProjectPath,
  parentDirOf,
  resolveWorkspaceFilePath,
  resolveSlnRelative,
  ueProjectRootOf,
} from "./slnPaths.js";

describe("resolveSlnRelative", () => {
  it("resolves backslash project paths against the sln dir", () => {
    assert.equal(
      resolveSlnRelative("/repos/App/App.sln", "src\\App.Web\\App.Web.csproj"),
      "/repos/App/src/App.Web/App.Web.csproj",
    );
  });

  it("walks parent segments (..)", () => {
    assert.equal(
      resolveSlnRelative("/repos/App/build/App.sln", "..\\src\\Lib\\L.csproj"),
      "/repos/App/src/Lib/L.csproj",
    );
  });

  it("ignores dot segments and duplicate slashes", () => {
    assert.equal(
      resolveSlnRelative("/r/sln", "./a//b\\c.cs"),
      "/r/a/b/c.cs",
    );
  });

  it("clamps at the root on too many ..", () => {
    assert.equal(resolveSlnRelative("/r/sln", "../../../../x.cs"), "/x.cs");
  });

  it("resolves solution-folder virtual files", () => {
    assert.equal(
      resolveSlnRelative("/r/App.sln", "docs\\architecture.md"),
      "/r/docs/architecture.md",
    );
  });
});

describe("baseNameOf / parentDirOf", () => {
  it("splits on both separators", () => {
    assert.equal(baseNameOf("/a/b/Cs.cs"), "Cs.cs");
    assert.equal(baseNameOf("C:\\x\\y\\S.sln"), "S.sln");
    assert.equal(parentDirOf("/a/b/c.txt"), "/a/b");
    assert.equal(parentDirOf("C:\\x\\y"), "C:/x");
  });

  it("degrades gracefully at the root", () => {
    assert.equal(parentDirOf("/root"), "/root");
    assert.equal(baseNameOf("file.ts"), "file.ts");
  });
});

describe("resolveWorkspaceFilePath", () => {
  it("joins relative agent tool paths onto the workspace root", () => {
    assert.equal(
      resolveWorkspaceFilePath("src\\main.ts", "E:/repos/App"),
      "E:/repos/App/src/main.ts",
    );
    assert.equal(
      resolveWorkspaceFilePath("docs/plans/x.md", "E:\\repos\\App\\"),
      "E:/repos/App/docs/plans/x.md",
    );
  });

  it("passes absolute paths through (normalized)", () => {
    assert.equal(
      resolveWorkspaceFilePath("E:\\other\\p\\a.ts", "E:/repos/App"),
      "E:/other/p/a.ts",
    );
    assert.equal(
      resolveWorkspaceFilePath("//server/share/a.ts", "E:/repos/App"),
      "//server/share/a.ts",
    );
    assert.equal(
      resolveWorkspaceFilePath("/Users/me/a.ts", null),
      "/Users/me/a.ts",
    );
  });

  it("returns null for relative paths without a root or blanks", () => {
    assert.equal(resolveWorkspaceFilePath("src/a.ts", null), null);
    assert.equal(resolveWorkspaceFilePath("   ", "E:/r"), null);
  });
});

describe("ueProjectRootOf", () => {
  it("redirects UBT-generated vcxproj two levels up", () => {
    assert.equal(
      ueProjectRootOf("E:/Game/Intermediate/ProjectFiles/NF.vcxproj"),
      "E:/Game",
    );
  });

  it("is case-insensitive on the Intermediate/ProjectFiles suffix", () => {
    assert.equal(
      ueProjectRootOf("E:/Game/intermediate/projectfiles/NF.vcxproj"),
      "E:/Game",
    );
  });

  it("returns null for regular project paths", () => {
    assert.equal(ueProjectRootOf("E:/Game/Source/NF/NF.vcxproj"), null);
    assert.equal(ueProjectRootOf("E:/repos/App/src/App.csproj"), null);
  });
});

describe("isUeEngineProjectPath", () => {
  it("flags the engine project UBT wrote under the game root", () => {
    // The two-levels-up rule would resolve this to E:/Game — game code.
    assert.equal(
      isUeEngineProjectPath("E:/Game/Intermediate/ProjectFiles/Engine.vcxproj"),
      true,
    );
    assert.equal(
      isUeEngineProjectPath("E:/Game/Intermediate/ProjectFiles/UE5.vcxproj"),
      true,
    );
    assert.equal(
      isUeEngineProjectPath("E:/Game/Intermediate/ProjectFiles/UE4.vcxproj"),
      true,
    );
  });

  it("flags the engine project in its own tree", () => {
    assert.equal(
      isUeEngineProjectPath(
        "E:/work/UnrealEngine/Engine/Intermediate/ProjectFiles/UE5.vcxproj",
      ),
      true,
    );
  });

  it("leaves game projects alone", () => {
    assert.equal(
      isUeEngineProjectPath("E:/Game/Intermediate/ProjectFiles/NF.vcxproj"),
      false,
    );
    assert.equal(
      isUeEngineProjectPath("E:/Game/Intermediate/ProjectFiles/Engineer.vcxproj"),
      false,
    );
  });

  it("ignores projects outside Intermediate/ProjectFiles", () => {
    // A hand-written project that happens to be named Engine keeps its own
    // directory — only the UBT-generated layout needs the redirect.
    assert.equal(isUeEngineProjectPath("E:/repos/App/Engine/Engine.vcxproj"), false);
  });
});

describe("commonAncestorDirOf", () => {
  it("finds the shallowest dir containing all inputs", () => {
    assert.equal(
      commonAncestorDirOf(["/a/b/c", "/a/b/d", "/a/b/e/f"]),
      "/a/b",
    );
  });

  it("returns the input when nested", () => {
    assert.equal(commonAncestorDirOf(["/a/b", "/a/b/c"]), "/a/b");
  });

  it("climbs to the drive root if needed", () => {
    assert.equal(commonAncestorDirOf(["/a/x", "/b/y"]), "/");
  });

  it("handles empty input", () => {
    assert.equal(commonAncestorDirOf([]), null);
  });
});
