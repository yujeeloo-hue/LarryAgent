import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  definitionTargetFromOpener,
  disableCtrlClickGoto,
  isUhtGeneratedPath,
  pickJumpTarget,
  pickUhtHandwrittenTarget,
  uhtRedirectQuery,
} from "./goToDefinition.js";

describe("disableCtrlClickGoto", () => {
  it("disposes Monaco's Ctrl+click go-to-definition contribution", () => {
    let disposed = false;
    disableCtrlClickGoto({
      getContribution(id) {
        assert.equal(id, "editor.contrib.gotodefinitionatposition");
        return {
          dispose() {
            disposed = true;
          },
        };
      },
    });
    assert.equal(disposed, true);
  });

  it("does nothing when the contribution is absent", () => {
    disableCtrlClickGoto({ getContribution: () => null });
    disableCtrlClickGoto(null);
  });
});

describe("pickJumpTarget", () => {
  const header = "E:/NF/Source/NF/NFCharacter.h";
  const source = "E:/NF/Source/NF/NFCharacter.cpp";
  const generated = "E:/NF/Intermediate/Inc/NF/UHT/NFCharacter.gen.cpp";

  it("skips the declaration under the caret so F12 reaches the implementation", () => {
    const targets = [
      { path: "e:\\NF\\Source\\NF\\NFCharacter.h", line: 212 },
      { path: source, line: 980 },
    ];
    assert.deepEqual(pickJumpTarget(targets, { path: header, line: 212 }), { path: source, line: 980 });
  });

  it("keeps a nearby target on another line (local variable above its use)", () => {
    assert.deepEqual(
      pickJumpTarget([{ path: source, line: 41 }], { path: source, line: 42 }),
      { path: source, line: 41 },
    );
  });

  it("returns null when every answer is the caret itself", () => {
    assert.equal(pickJumpTarget([{ path: source, line: 7 }], { path: source, line: 7 }), null);
    assert.equal(pickJumpTarget(null, { path: source, line: 7 }), null);
  });

  it("skips UHT output and lands on the handwritten file", () => {
    assert.deepEqual(
      pickJumpTarget(
        [{ path: generated, line: 400 }, { path: source, line: 980 }],
        { path: header, line: 212 },
      ),
      { path: source, line: 980 },
    );
    assert.equal(
      pickJumpTarget([{ path: generated, line: 400 }], { path: header, line: 212 }),
      null,
    );
  });
});

describe("UHT RPC thunks", () => {
  const header = "E:/NF/Source/NFGame/Public/NFCharacter.h";
  const source = "E:/NF/Source/NFGame/Private/NFCharacter.cpp";
  const generated = "E:/NF/Intermediate/Build/Win64/UnrealEditor/Inc/NFGame/UHT/NFCharacter.gen.cpp";
  const impl = {
    name: "Server_PlayAudio_Implementation",
    path: source,
    line: 640,
    container: "ANFCharacter",
    isImpl: true,
  };
  const decl = {
    name: "Server_PlayAudio",
    path: header,
    line: 88,
    container: "ANFCharacter",
  };
  const otherImpl = {
    name: "Server_PlayAudio_Implementation",
    path: "E:/NF/Source/NFGame/Private/Enemy.cpp",
    line: 12,
    container: "AEnemy",
    isImpl: true,
  };

  it("treats .gen.cpp and .generated.h as UHT output", () => {
    assert.equal(isUhtGeneratedPath(generated), true);
    assert.equal(isUhtGeneratedPath("E:/NF/Source/NFCharacter.generated.h"), true);
    assert.equal(isUhtGeneratedPath("E:/NF/Source/NFCharacter.generated.cpp"), true);
    assert.equal(isUhtGeneratedPath(source), false);
    assert.equal(isUhtGeneratedPath(header), false);
  });

  it("asks for _Implementation when F12 would open the generated thunk", () => {
    const targets = [
      { path: header, line: 88 },
      { path: generated, line: 400 },
    ];
    assert.equal(
      uhtRedirectQuery("Server_PlayAudio", targets, { path: header, line: 88 }, { path: generated, line: 400 }),
      "Server_PlayAudio_Implementation",
    );
    assert.equal(
      uhtRedirectQuery(
        "Server_PlayAudio_Implementation",
        [{ path: generated, line: 400 }],
        { path: source, line: 640 },
        { path: generated, line: 400 },
      ),
      "Server_PlayAudio",
    );
  });

  it("asks for _Implementation from a call site whose jump lands on the header declaration", () => {
    const caller = "E:/NF/Source/NFGame/Private/NFPlayerController.cpp";
    assert.equal(
      uhtRedirectQuery("Server_PlayAudio", [{ path: header, line: 88 }], { path: caller, line: 30 }, { path: header, line: 88 }),
      "Server_PlayAudio_Implementation",
    );
    assert.equal(
      uhtRedirectQuery("Server_PlayAudio", [], { path: header, line: 88 }, null),
      "Server_PlayAudio_Implementation",
    );
    assert.equal(
      uhtRedirectQuery("Server_PlayAudio", [], { path: source, line: 30 }, null),
      null,
    );
  });

  it("from another file, pairs by the declaration header's stem", () => {
    const caller = { path: "E:/NF/Source/NFGame/Private/NFPlayerController.cpp", line: 30 };
    assert.deepEqual(
      pickUhtHandwrittenTarget({
        word: "Server_PlayAudio",
        caret: caller,
        generatedPath: header,
        candidates: [otherImpl, impl],
      }),
      { path: source, line: 640 },
    );
    assert.equal(
      pickUhtHandwrittenTarget({ word: "Server_PlayAudio", caret: caller, candidates: [impl, otherImpl] }),
      null,
    );
  });

  it("keeps a handwritten .cpp target for an ordinary function", () => {
    assert.equal(
      uhtRedirectQuery(
        "BeginPlay",
        [{ path: source, line: 20 }],
        { path: header, line: 10 },
        { path: source, line: 20 },
      ),
      null,
    );
  });

  it("jumps to the .cpp _Implementation instead of the .gen.cpp thunk", () => {
    assert.deepEqual(
      pickUhtHandwrittenTarget({
        word: "Server_PlayAudio",
        caret: { path: header, line: 88 },
        container: "ANFCharacter",
        generatedPath: generated,
        candidates: [impl, otherImpl, { ...impl, path: generated, line: 400 }],
      }),
      { path: source, line: 640 },
    );
  });

  it("uses the generated file stem when the call has no qualifier", () => {
    assert.deepEqual(
      pickUhtHandwrittenTarget({
        word: "Server_PlayAudio",
        caret: { path: "E:/NF/Source/NFGame/Private/Enemy.cpp", line: 30 },
        generatedPath: generated,
        candidates: [otherImpl, impl],
      }),
      { path: source, line: 640 },
    );
  });

  it("from the implementation, lands on the header declaration", () => {
    assert.deepEqual(
      pickUhtHandwrittenTarget({
        word: "Server_PlayAudio_Implementation",
        caret: { path: source, line: 640 },
        container: "ANFCharacter",
        generatedPath: "E:/NF/Intermediate/NFCharacter.generated.h",
        candidates: [decl, impl],
      }),
      { path: header, line: 88 },
    );
  });

  it("returns null when the only body belongs to another class", () => {
    assert.equal(
      pickUhtHandwrittenTarget({
        word: "Server_PlayAudio",
        caret: { path: header, line: 88 },
        generatedPath: generated,
        candidates: [otherImpl],
      }),
      null,
    );
    assert.equal(
      pickUhtHandwrittenTarget({
        word: "Server_PlayAudio",
        caret: { path: "E:/NF/Source/Other/Caller.cpp", line: 4 },
        candidates: [impl, otherImpl],
      }),
      null,
    );
  });
});

describe("definitionTargetFromOpener", () => {
  it("maps a file URI range to a path + line/column", () => {
    assert.deepEqual(
      definitionTargetFromOpener(
        { scheme: "file", fsPath: "E:\\src\\foo.ts" },
        { startLineNumber: 12, startColumn: 4 },
      ),
      { path: "E:/src/foo.ts", line: 12, column: 4 },
    );
  });

  it("accepts a caret position instead of a range", () => {
    assert.deepEqual(
      definitionTargetFromOpener(
        { scheme: "file", path: "/tmp/bar.ts" },
        { lineNumber: 3, column: 8 },
      ),
      { path: "/tmp/bar.ts", line: 3, column: 8 },
    );
  });

  it("rejects non-file schemes and empty paths", () => {
    assert.equal(
      definitionTargetFromOpener({ scheme: "inmemory", path: "model" }),
      null,
    );
    assert.equal(definitionTargetFromOpener({ scheme: "file", path: "" }), null);
  });

  it("rejects UHT-generated paths", () => {
    assert.equal(
      definitionTargetFromOpener(
        { scheme: "file", fsPath: "E:\\NF\\Intermediate\\Inc\\NF\\UHT\\NFCharacter.gen.cpp" },
        { startLineNumber: 12, startColumn: 4 },
      ),
      null,
    );
  });
});
