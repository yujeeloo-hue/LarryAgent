import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createUbtProgressParser,
  estimateEtaMs,
  isTailLinking,
  rollingActionsPerSecond,
  type UbtRateSample,
} from "./buildProgress.js";

describe("createUbtProgressParser", () => {
  it("starts in analyzing with no counts", () => {
    const p = createUbtProgressParser();
    assert.deepEqual(p.snapshot(), {
      phase: "analyzing",
      totalActions: null,
      doneActions: null,
      currentAction: null,
      linkingSeen: false,
    });
  });

  it("parses the Building N action(s) total line", () => {
    const p = createUbtProgressParser();
    p.feed("------ Building 5293 action(s) started ------\n");
    const s = p.snapshot();
    assert.equal(s.totalActions, 5293);
    assert.equal(s.phase, "compiling");
    assert.equal(s.doneActions, null);
  });

  it("parses plain action lines", () => {
    const p = createUbtProgressParser();
    p.feed("[3/10] Compile Module.NFGame.cpp\n[4/10] Compile Module.NFHUD.cpp\n");
    const s = p.snapshot();
    assert.equal(s.doneActions, 4);
    assert.equal(s.totalActions, 10);
    assert.equal(s.phase, "compiling");
    assert.equal(s.currentAction, "Compile Module.NFHUD.cpp");
  });

  it("strips target details and compilation-time segments", () => {
    const p = createUbtProgressParser();
    p.feed(
      "[11/5293][NFEditor Win64 DebugGame] (Wall: 1.50s CPU: 3.00s Mem: 512MB) Compile Module.Engine.cpp\n",
    );
    const s = p.snapshot();
    assert.equal(s.doneActions, 11);
    assert.equal(s.currentAction, "Compile Module.Engine.cpp");
  });

  it("keeps max done across canceled-action gaps", () => {
    const p = createUbtProgressParser();
    // Action 5 canceled → counter jumps 4 → 6; both lines share total 10.
    p.feed("[4/10] Compile A.cpp\n[6/10] Compile C.cpp\n");
    const s = p.snapshot();
    assert.equal(s.doneActions, 6);
  });

  it("switches to generating on UHT status text", () => {
    const p = createUbtProgressParser();
    p.feed("Parsing headers for NFEditor\n");
    assert.equal(p.snapshot().phase, "generating");
    p.feed("Generating code... 12%");
    assert.equal(p.snapshot().phase, "generating");
  });

  it("generating yields to compiling once actions start", () => {
    const p = createUbtProgressParser();
    p.feed("Parsing headers for NFEditor\n");
    p.feed("------ Building 12 action(s) started ------\r\n");
    p.feed("[1/12] Compile A.cpp\n");
    assert.equal(p.snapshot().phase, "compiling");
  });

  it("link description is sticky", () => {
    const p = createUbtProgressParser();
    p.feed("------ Building 10 action(s) started ------\n");
    p.feed("[8/10] Compile A.cpp\n");
    assert.equal(p.snapshot().phase, "compiling");
    p.feed("[9/10] Link NFEditor.dll\n");
    assert.equal(p.snapshot().phase, "linking");
    assert.equal(p.snapshot().linkingSeen, true);
    // Later non-link lines must not flip the phase back.
    p.feed("[10/10] Compile B.cpp\n");
    assert.equal(p.snapshot().phase, "linking");
  });

  it("@progress markup (when UBT runs -Progress) sets phases", () => {
    const p = createUbtProgressParser();
    p.feed("@progress push 5%\n");
    assert.equal(p.snapshot().phase, "generating");
    p.feed("@progress 'Generating code...' 40%\n");
    assert.equal(p.snapshot().phase, "generating");
    p.feed("@progress 'Compiling C++ source code...' 42%\n");
    assert.equal(p.snapshot().phase, "compiling");
  });

  it("reassembles chunks split mid-line and splits on lone \\r", () => {
    const p = createUbtProgressParser();
    p.feed("[31/5293] Compile Modu");
    assert.equal(p.snapshot().doneActions, null);
    p.feed("le.NFGame.cpp\n");
    assert.equal(p.snapshot().doneActions, 31);
    p.feed("[32/5293] Compile Module.NFHUD.cpp\r");
    assert.equal(p.snapshot().doneActions, 32);
    p.feed("[33/5293] Compile Module.NFAI.cpp\n");
    assert.equal(p.snapshot().doneActions, 33);
  });

  it("tolerates no-newline UHT status flushes", () => {
    const p = createUbtProgressParser();
    p.feed("Parsing headers for NFEditor");
    assert.equal(p.snapshot().phase, "analyzing"); // not a line yet
    p.feed("\nGenerating code... 12%\n");
    assert.equal(p.snapshot().phase, "generating");
  });

  it("ignores unrelated output", () => {
    const p = createUbtProgressParser();
    p.feed(
      "Determining max actions to execute in parallel (24 physical cores)\n" +
        "   Creating library foo.lib and object foo.exp\n" +
        "SomeModule.cpp(142): warning C4996: something\n",
    );
    const s = p.snapshot();
    assert.equal(s.phase, "analyzing");
    assert.equal(s.totalActions, null);
    assert.equal(s.doneActions, null);
  });

  it("empty description keeps the previous currentAction", () => {
    const p = createUbtProgressParser();
    p.feed("[1/5] Compile A.cpp\n");
    p.feed("[2/5] \n");
    assert.equal(p.snapshot().currentAction, "Compile A.cpp");
    assert.equal(p.snapshot().doneActions, 2);
  });

  it("reset drops state", () => {
    const p = createUbtProgressParser();
    p.feed("------ Building 7 action(s) started ------\n[1/7] Compile A.cpp\n");
    p.reset();
    assert.equal(p.snapshot().phase, "analyzing");
    assert.equal(p.snapshot().doneActions, null);
  });
});

describe("rollingActionsPerSecond", () => {
  const S = (done: number, atMs: number): UbtRateSample => ({ done, atMs });

  it("needs two samples spanning minSpan", () => {
    assert.equal(rollingActionsPerSecond([], 30_000, 100_000), null);
    assert.equal(
      rollingActionsPerSecond([S(10, 100_000)], 30_000, 100_000),
      null,
    );
    assert.equal(
      rollingActionsPerSecond([S(10, 100_000), S(20, 100_500)], 30_000, 100_000),
      null, // 0.5s span < 2s min
    );
  });

  it("computes window rate from first/last samples", () => {
    const samples = [
      S(100, 60_000),
      S(150, 70_000),
      S(220, 80_000),
      S(300, 90_000),
    ];
    // Window covers all: (300-100)/(30s) = 6.67/s
    const rate = rollingActionsPerSecond(samples, 30_000, 90_000);
    assert.ok(rate);
    assert.ok(Math.abs(rate - 200 / 30) < 1e-9);
  });

  it("drops samples outside the window", () => {
    const samples = [S(0, 0), S(50, 10_000), S(80, 20_000)];
    // Window 10s at t=20s keeps the last two: (80-50)/10s = 3/s
    const rate = rollingActionsPerSecond(samples, 10_000, 20_000);
    assert.ok(rate);
    assert.ok(Math.abs(rate - 3) < 1e-9);
  });

  it("null when no forward progress", () => {
    const samples = [S(50, 10_000), S(50, 20_000)];
    assert.equal(rollingActionsPerSecond(samples, 30_000, 20_000), null);
  });
});

describe("estimateEtaMs", () => {
  it("divides remaining by rate", () => {
    assert.equal(estimateEtaMs(100, 5), 20_000);
  });
  it("null on non-positive inputs", () => {
    assert.equal(estimateEtaMs(0, 5), null);
    assert.equal(estimateEtaMs(10, 0), null);
    assert.equal(estimateEtaMs(10, Number.NaN), null);
  });
});

describe("isTailLinking", () => {
  it("near-done small tail counts as linking", () => {
    assert.equal(isTailLinking(5288, 5293), true); // 5 left, 99.9%
    assert.equal(isTailLinking(98, 100), true); // 2 left, 98%
  });
  it("early progress is not linking", () => {
    assert.equal(isTailLinking(5000, 5293), false); // 293 left
    assert.equal(isTailLinking(90, 100), false); // 10 left, 90%
    assert.equal(isTailLinking(0, 100), false);
    assert.equal(isTailLinking(100, 100), false); // complete
  });
});
