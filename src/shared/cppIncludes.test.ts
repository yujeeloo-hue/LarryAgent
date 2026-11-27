import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  alreadyIncluded,
  existingIncludes,
  includeDirsFromArgs,
  includeInsertionLine,
  includeSpecifierFor,
  normalizeFsPath,
  planAutoImport,
  planIncludeInsertion,
} from "./cppIncludes.js";

describe("normalizeFsPath", () => {
  it("turns backslashes into slashes and drops trailing ones", () => {
    assert.equal(normalizeFsPath("E:\\NF\\Source\\A.h"), "E:/NF/Source/A.h");
    assert.equal(normalizeFsPath("/Users/dev/proj/"), "/Users/dev/proj");
    assert.equal(normalizeFsPath("//server/share/dir//"), "/server/share/dir");
  });

  it("keeps a bare drive root usable as a directory", () => {
    assert.equal(normalizeFsPath("E:"), "E:/");
    assert.equal(normalizeFsPath("/"), "/");
  });
});

describe("includeDirsFromArgs", () => {
  it("reads MSVC and clang include flags in both spellings", () => {
    const dirs = includeDirsFromArgs(
      ["clang-cl.exe", "/IE:/NF/Engine/Source/Runtime/Core/Public", "/I", "E:/NF/Engine/Public",
        "-isystem", "E:/SDK/Include", "-iquoteE:/Quoted", "-IE:/NF/Engine/Public"],
      "E:/NF",
    );
    assert.deepEqual(dirs, [
      "E:/NF/Engine/Source/Runtime/Core/Public",
      "E:/NF/Engine/Public",
      "E:/SDK/Include",
      "E:/Quoted",
    ], "duplicates collapse case-insensitively, order preserved");
  });

  it("resolves relative directories against the compile-db directory", () => {
    assert.deepEqual(includeDirsFromArgs(["-I../Runtime/Core/Public", "/I", "./Local"], "E:/NF/Source/NF"),
      ["E:/NF/Source/Runtime/Core/Public", "E:/NF/Source/NF/Local"]);
  });

  it("ignores forced includes and unrelated flags", () => {
    assert.deepEqual(
      includeDirsFromArgs(["-include", "E:/NF/SharedPCH.Engine.h", "/FI", "X.h", "/YuX", "-D_ALLOWED"], "E:/NF"),
      [],
    );
  });
});

describe("includeSpecifierFor", () => {
  const dirs = [
    "E:/NF/Source/NF",
    "E:/NF/Source/NF/Public",
    "E:/NF/Engine/Source/Runtime/Engine/Public",
  ];

  it("picks the longest include directory so the spelling is shortest", () => {
    assert.equal(
      includeSpecifierFor("E:/NF/Engine/Source/Runtime/Engine/Public/Components/StaticMeshComponent.h", dirs),
      "Components/StaticMeshComponent.h",
    );
    assert.equal(
      includeSpecifierFor("E:/NF/Source/NF/Public/NFCharacter.h", dirs),
      "NFCharacter.h",
    );
  });

  it("matches case-insensitively (Windows compile databases)", () => {
    assert.equal(
      includeSpecifierFor("e:/nf/Engine/source/runtime/engine/public/GameFramework/Actor.h", dirs),
      "GameFramework/Actor.h",
    );
  });

  it("uses the bare name for a header next to the edited file", () => {
    assert.equal(
      includeSpecifierFor("E:/NF/Source/NF/Private/NFActorHelper.h", dirs, "E:/NF/Source/NF/Private/NFActor.cpp"),
      "NFActorHelper.h",
    );
  });

  it("refuses generated headers, sources and headers outside every include dir", () => {
    assert.equal(includeSpecifierFor("E:/NF/Source/NF/Public/NFCharacter.generated.h", dirs), null);
    assert.equal(includeSpecifierFor("E:/NF/Source/NF/Private/NFCharacter.cpp", dirs), null);
    assert.equal(includeSpecifierFor("D:/Elsewhere/Thing.h", dirs), null);
    assert.equal(includeSpecifierFor("E:/NF/Intermediate/Build/Win64/X.generated.h", dirs), null);
  });
});

describe("existingIncludes / alreadyIncluded", () => {
  const text = [
    '#include "CoreMinimal.h"',
    '#include "Components/StaticMeshComponent.h"',
    "#include <string>",
  ].join("\n");

  it("collects angle and quoted includes", () => {
    const { specifiers, names } = existingIncludes(text);
    assert.deepEqual([...specifiers].sort(), [
      "components/staticmeshcomponent.h",
      "coreminimal.h",
      "string",
    ]);
    assert.equal(names.has("string"), true);
  });

  it("treats a same-named header as already present", () => {
    assert.equal(alreadyIncluded(text, "Components/StaticMeshComponent.h"), true);
    assert.equal(alreadyIncluded(text, "Components\\StaticMeshComponent.h"), true);
    assert.equal(alreadyIncluded(text, "Other/StaticMeshComponent.h"), true, "basename match");
    assert.equal(alreadyIncluded(text, "GameFramework/Actor.h"), false);
  });
});

describe("planIncludeInsertion", () => {
  it("appends after the include block of a source file", () => {
    const text = [
      '#include "NFCharacter.h"',
      '#include "GameFramework/Character.h"',
      "",
      "void ANFCharacter::BeginPlay() {}",
    ].join("\n");
    const insertion = planIncludeInsertion(text, "Components/StaticMeshComponent.h", "E:/NF/Source/NF/NFCharacter.cpp");
    assert.deepEqual(insertion, { line: 3, text: '#include "Components/StaticMeshComponent.h"\n' });
  });

  it("inserts before the generated header (UHT keeps it last)", () => {
    const text = [
      "#pragma once",
      "",
      '#include "CoreMinimal.h"',
      '#include "NFCharacter.generated.h"',
      "",
      "class ANFCharacter {};",
    ].join("\n");
    const insertion = planIncludeInsertion(text, "Components/StaticMeshComponent.h", "E:/NF/Source/NF/NFCharacter.h");
    assert.deepEqual(insertion, { line: 4, text: '#include "Components/StaticMeshComponent.h"\n' });
  });

  it("falls back to the end of the prologue when there is no include", () => {
    const text = ["// Copyright Epic Games, Inc.", "", "#pragma once", "", "class UThing {};"].join("\n");
    assert.deepEqual(planIncludeInsertion(text, "CoreMinimal.h", "E:/NF/Source/NF/Thing.h"),
      { line: 4, text: '#include "CoreMinimal.h"\n' });
  });

  it("starts at line 1 when the file is empty", () => {
    assert.deepEqual(planIncludeInsertion("", "CoreMinimal.h"), { line: 1, text: '#include "CoreMinimal.h"\n' });
  });

  it("does nothing when the include is already there", () => {
    const text = '#include "CoreMinimal.h"\n';
    assert.equal(planIncludeInsertion(text, "CoreMinimal.h"), null);
    assert.equal(planIncludeInsertion(text, '"CoreMinimal.h"'), null);
  });
});

describe("planAutoImport", () => {
  const dirs = ["E:/NF/Source/NF/Public", "E:/NF/Engine/Source/Runtime/Engine/Public"];
  const forFile = "E:/NF/Source/NF/Private/NFActor.cpp";

  it("pairs the header spelling with the insertion point", () => {
    const text = ['#include "NFActor.h"', ""].join("\n");
    assert.equal(includeInsertionLine(text), 2);
    assert.deepEqual(
      planAutoImport(
        "E:/NF/Engine/Source/Runtime/Engine/Public/Components/StaticMeshComponent.h",
        dirs,
        forFile,
        existingIncludes(text),
        includeInsertionLine(text),
      ),
      {
        specifier: "Components/StaticMeshComponent.h",
        insertion: { line: 2, text: '#include "Components/StaticMeshComponent.h"\n' },
      },
    );
  });

  it("stays silent for an included header, a missing one and generated headers", () => {
    const text = '#include "Components/StaticMeshComponent.h"\n';
    const header = "E:/NF/Engine/Source/Runtime/Engine/Public/Components/StaticMeshComponent.h";
    const included = existingIncludes(text);
    assert.equal(planAutoImport(header, dirs, forFile, included, 2), null);
    assert.equal(planAutoImport(undefined, dirs, forFile, included, 2), null);
    assert.equal(
      planAutoImport("E:/NF/Source/NF/Public/NFActor.generated.h", dirs, forFile, included, 2),
      null,
    );
  });
});
