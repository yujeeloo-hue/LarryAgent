import assert from "node:assert/strict";
import test from "node:test";
import { createBuildDiagnosticsParser, parseBuildDiagnostic } from "./buildDiagnostics.js";

test("MSVC paths, spaces, parentheses, prefixes, severity and one-based locations", () => {
  const item = parseBuildDiagnostic('1>\x1b[31mC:\\My Game (test)\\Source\\Actor.cpp(142,9): error C2065: undeclared identifier\x1b[0m')!;
  assert.equal(item.path, "C:/My Game (test)/Source/Actor.cpp");
  assert.equal(item.line, 142); assert.equal(item.column, 9);
  assert.equal(item.severity, "error"); assert.equal(item.code, "C2065");
  assert.equal(item.message, "undeclared identifier");
  const warning = parseBuildDiagnostic('[25/100] Source/Actor.cpp(208): warning C4189: unused variable')!;
  assert.equal(warning.severity, "warning"); assert.equal(warning.column, null);
  assert.equal(warning.path, "Source/Actor.cpp");
  const range = parseBuildDiagnostic('Program.cs(12,5,12,8): error CS1002: ; expected')!;
  assert.equal(range.line, 12); assert.equal(range.column, 5);
});

test("clang/GCC locations retain the line and column on POSIX and Windows", () => {
  for (const path of ["/Users/me/My Game/Actor.cpp", "D:/Game/Actor.cpp"]) {
    const item = parseBuildDiagnostic(`${path}:52:18: fatal error: missing header`)!;
    assert.equal(item.path, path); assert.equal(item.line, 52); assert.equal(item.column, 18);
    assert.equal(item.severity, "error");
  }
  const item = parseBuildDiagnostic("../Source/Actor.cpp:42: warning: unused variable [-Wunused-variable]")!;
  assert.equal(item.path, "../Source/Actor.cpp"); assert.equal(item.line, 42); assert.equal(item.column, null);
});

test("locationless linker failures remain errors without a fabricated code jump", () => {
  const item = parseBuildDiagnostic("LINK : fatal error LNK1104: cannot open file Game.lib")!;
  assert.equal(item.path, null); assert.equal(item.line, null); assert.equal(item.code, "LNK1104");
  assert.equal(item.severity, "error");
  assert.equal(parseBuildDiagnostic("cl : Command line warning D9002: ignoring unknown option")?.severity, "warning");
  for (const line of ["0 Error(s)", "3 Warning(s)", "Build succeeded.", "Actor.cpp(3): note: see previous declaration", "[1/5] Compile Actor.cpp"])
    assert.equal(parseBuildDiagnostic(line), null, line);
});

test("chunk boundaries, ANSI escapes, separate streams, CR and final unterminated lines", () => {
  const parser = createBuildDiagnosticsParser();
  assert.equal(parser.feed("Preparing targets").length, 0);
  assert.equal(parser.feed("\x1b[3", "stderr").length, 0);
  assert.equal(parser.feed("1mActor.cpp(5,2): error C2001: bad", "stderr").length, 0);
  assert.equal(parser.feed("\n").length, 0);
  const added = parser.feed(" input\x1b[0m\r", "stderr");
  assert.equal(added.length, 1); assert.equal(added[0]!.message, "bad input");
  assert.equal(parser.feed("\n", "stderr").length, 0);
  parser.feed("Actor.cpp(9): warning C4100: unused");
  assert.equal(parser.flush().length, 1); assert.equal(parser.flush().length, 0);
  assert.equal(parser.snapshot().length, 2);
});

test("build summaries deduplicate repeated diagnostics and a new run resets them", () => {
  const parser = createBuildDiagnosticsParser();
  parser.feed("C:\\Game\\Main.cs(4,2): warning CS0168: unused [C:\\Game\\Game.csproj]\n");
  assert.equal(parser.feed("c:/game/main.cs(4,2): warning CS0168: unused\n").length, 0);
  assert.equal(parser.feed("c:/game/main.cs(4,3): warning CS0168: unused\n").length, 1);
  parser.reset(); assert.equal(parser.snapshot().length, 0);
  assert.equal(parser.feed("c:/game/main.cs(4,2): warning CS0168: unused\n").length, 1);
});
