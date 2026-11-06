import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  counterpartKind,
  counterpartSearchScope,
  pickCounterpartHit,
  pickCounterpartIndexHit,
  resolveCppCounterpart,
} from "./cppCounterpart.js";

describe("counterpartKind", () => {
  it("classifies the counterpart of headers, sources, and non-cpp paths", () => {
    assert.equal(counterpartKind("E:/Game/Private/Foo.cpp"), "header");
    assert.equal(counterpartKind("E:/Game/Classes/Foo.h"), "source");
    assert.equal(counterpartKind("E:/Game/Foo.txt"), null);
  });
});

describe("counterpartSearchScope", () => {
  it("cuts at the Private segment (engine source)", () => {
    const scope = counterpartSearchScope(
      "E:/Eng/Source/Runtime/Engine/Private/PlayerController.cpp",
    );
    assert.deepEqual(scope, {
      root: "E:/Eng/Source/Runtime/Engine",
      subPath: "",
    });
  });

  it("keeps the sub-path below the marker segment", () => {
    const scope = counterpartSearchScope(
      "E:/Eng/Source/Runtime/Engine/Private/GameFramework/Foo.cpp",
    );
    assert.deepEqual(scope, {
      root: "E:/Eng/Source/Runtime/Engine",
      subPath: "GameFramework",
    });
  });

  it("cuts at Classes for engine headers", () => {
    const scope = counterpartSearchScope(
      "E:/Eng/Source/Runtime/Engine/Classes/GameFramework/PlayerController.h",
    );
    assert.deepEqual(scope, {
      root: "E:/Eng/Source/Runtime/Engine",
      subPath: "GameFramework",
    });
  });

  it("flat layouts scope to the file's own directory", () => {
    const scope = counterpartSearchScope(
      "E:/Proj/Source/NF/Battle/Player/NFPlayerController.cpp",
    );
    assert.deepEqual(scope, {
      root: "E:/Proj/Source/NF/Battle/Player",
      subPath: "",
    });
  });

  it("normalizes backslashes and skips rejected dir names", () => {
    const scope = counterpartSearchScope(
      "E:\\Proj\\PublicStuff\\Modules\\Foo.cpp",
    );
    // "PublicStuff" is not a bare Public segment — no cut.
    assert.deepEqual(scope, { root: "E:/Proj/PublicStuff/Modules", subPath: "" });
  });

  it("returns null for a bare filename", () => {
    assert.equal(counterpartSearchScope("Foo.cpp"), null);
  });
});

describe("pickCounterpartHit", () => {
  const hits = (rels: string[]) =>
    rels.map((rel) => ({ path: `E:/Mod/${rel}`, rel }));

  it("filters by exact basename + counterpart extension", () => {
    const pick = pickCounterpartHit(
      hits([
        "Classes/PlayerController.h",
        "Private/SubPlayerController.h",
        "Private/PlayerController.cpp",
        "Private/PlayerController.hpp.bak",
      ]),
      "PlayerController",
      "header",
      "",
    );
    assert.equal(pick, "E:/Mod/Classes/PlayerController.h");
  });

  it("prefers the Classes tree over a wrong-tree hit", () => {
    const pick = pickCounterpartHit(
      hits(["Misc/PlayerController.h", "Classes/GameFramework/PlayerController.h"]),
      "PlayerController",
      "header",
      "GameFramework",
    );
    assert.equal(pick, "E:/Mod/Classes/GameFramework/PlayerController.h");
  });

  it("prefers a sub-path mirroring the source's nesting", () => {
    const pick = pickCounterpartHit(
      hits(["Classes/Misc/PlayerController.h", "Classes/GameFramework/PlayerController.h"]),
      "PlayerController",
      "header",
      "GameFramework",
    );
    assert.equal(pick, "E:/Mod/Classes/GameFramework/PlayerController.h");
  });

  it("prefers Private for a source counterpart and shallower paths on ties", () => {
    const pick = pickCounterpartHit(
      hits(["Classes/PlayerController.cpp", "Private/PlayerController.cpp"]),
      "PlayerController",
      "source",
      "",
    );
    assert.equal(pick, "E:/Mod/Private/PlayerController.cpp");

    const shallow = pickCounterpartHit(
      hits(["Public/A/B/PlayerController.h", "Public/PlayerController.h"]),
      "PlayerController",
      "header",
      "A/B",
    );
    // sub-path match (0) beats shallowness (2)
    assert.equal(shallow, "E:/Mod/Public/A/B/PlayerController.h");
  });

  it("is case-insensitive on basename and extension", () => {
    const pick = pickCounterpartHit(hits(["Classes/playercontroller.HPP"]), "PLAYERCONTROLLER", "header", "");
    assert.equal(pick, "E:/Mod/Classes/playercontroller.HPP");
  });
});

describe("pickCounterpartIndexHit", () => {
  const idxHits = (entries: Array<[string, string]>) =>
    entries.map(([rel, path]) => ({ rel, path }));

  it("re-scopes workspace-relative engine rels onto the module marker", () => {
    const pick = pickCounterpartIndexHit(
      idxHits([
        [
          "Engine/Source/Runtime/Engine/Classes/GameFramework/PlayerController.h",
          "E:/Eng/Engine/Source/Runtime/Engine/Classes/GameFramework/PlayerController.h",
        ],
        [
          "Engine/Source/Runtime/Engine/Classes/GameFramework/PlayerController.cpp",
          "E:/Eng/Engine/Source/Runtime/Engine/Classes/GameFramework/PlayerController.cpp",
        ],
      ]),
      "PlayerController",
      "header",
      "",
    );
    assert.equal(
      pick,
      "E:/Eng/Engine/Source/Runtime/Engine/Classes/GameFramework/PlayerController.h",
    );
  });

  it("prefers the mirrored sub-path across a Private→Classes hop", () => {
    const pick = pickCounterpartIndexHit(
      idxHits([
        [
          "Engine/Source/Runtime/Engine/Classes/Misc/PlayerController.h",
          "E:/Eng/Engine/Source/Runtime/Engine/Classes/Misc/PlayerController.h",
        ],
        [
          "Engine/Source/Runtime/Engine/Classes/GameFramework/PlayerController.h",
          "E:/Eng/Engine/Source/Runtime/Engine/Classes/GameFramework/PlayerController.h",
        ],
      ]),
      "PlayerController",
      "header",
      "GameFramework",
    );
    assert.equal(
      pick,
      "E:/Eng/Engine/Source/Runtime/Engine/Classes/GameFramework/PlayerController.h",
    );
  });

  it("plugin Public/Private hits rank by their module marker, not depth", () => {
    const pick = pickCounterpartIndexHit(
      idxHits([
        [
          "Plugins/X/Source/XCore/Public/XSettings.h",
          "E:/Game/Plugins/X/Source/XCore/Public/XSettings.h",
        ],
        [
          "Plugins/X/Source/XCore/Private/XSettings.cpp",
          "E:/Game/Plugins/X/Source/XCore/Private/XSettings.cpp",
        ],
      ]),
      "XSettings",
      "source",
      "",
    );
    assert.equal(
      pick,
      "E:/Game/Plugins/X/Source/XCore/Private/XSettings.cpp",
    );
  });
});

describe("resolveCppCounterpart", () => {
  it("returns the exact sibling candidate before searching", async () => {
    let searched = false;
    const target = await resolveCppCounterpart(
      "E:/Game/Private/Foo.cpp",
      () => {
        searched = true;
        return { ok: true, files: [] };
      },
      async () => ["E:/Game/Public/Foo.h"],
    );
    assert.equal(target, "E:/Game/Public/Foo.h");
    assert.equal(searched, false);
  });

  it("resolves via the loaded file index before walking", async () => {
    let walked = false;
    const target = await resolveCppCounterpart(
      "E:/Eng/Engine/Source/Runtime/Engine/Private/PlayerController.cpp",
      () => {
        walked = true;
        return { ok: true, files: [] };
      },
      async () => [],
      () => [
        {
          rel: "Engine/Source/Runtime/Engine/Classes/GameFramework/PlayerController.h",
          path: "E:/Eng/Engine/Source/Runtime/Engine/Classes/GameFramework/PlayerController.h",
        },
      ],
    );
    assert.equal(
      target,
      "E:/Eng/Engine/Source/Runtime/Engine/Classes/GameFramework/PlayerController.h",
    );
    assert.equal(walked, false);
  });

  it("never resolves a counterpart back onto the source itself", async () => {
    const self = "E:/Game/Source/Mod/Public/Foo.h";
    const target = await resolveCppCounterpart(
      self,
      () => ({ ok: true, files: [] }),
      async () => [],
      (base) => [
        {
          rel: `Source/Mod/Public/${base}.h`,
          path: "E:/Game/Source/Mod/Public/Foo.h",
        },
      ],
    );
    assert.equal(target, null);
  });

  it("falls back to the scoped search for engine-style nesting", async () => {
    const target = await resolveCppCounterpart(
      "E:/Eng/Source/Runtime/Engine/Private/PlayerController.cpp",
      (root, query) => {
        assert.equal(root, "E:/Eng/Source/Runtime/Engine");
        assert.equal(query, "PlayerController");
        return {
          ok: true,
          files: [
            { path: "E:/Eng/Source/Runtime/Engine/Private/PlayerController.h", rel: "Private/PlayerController.h" },
            {
              path: "E:/Eng/Source/Runtime/Engine/Classes/GameFramework/PlayerController.h",
              rel: "Classes/GameFramework/PlayerController.h",
            },
          ],
        };
      },
      async () => [],
    );
    assert.equal(
      target,
      "E:/Eng/Source/Runtime/Engine/Classes/GameFramework/PlayerController.h",
    );
  });

  it("returns null when nothing matches", async () => {
    const target = await resolveCppCounterpart(
      "E:/Game/Private/Foo.cpp",
      () => ({ ok: true, files: [{ path: "E:/Game/Foo.txt", rel: "Foo.txt" }] }),
      async () => [],
    );
    assert.equal(target, null);
  });

  it("returns null for non-cpp paths without touching the bridge", async () => {
    const target = await resolveCppCounterpart(
      "E:/Game/Foo.ts",
      () => {
        throw new Error("should not search");
      },
      async () => {
        throw new Error("should not stat");
      },
    );
    assert.equal(target, null);
  });
});
