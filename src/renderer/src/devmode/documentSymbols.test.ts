import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  filterDocumentSymbols,
  outlineSignatureText,
  scanDocumentSymbols,
  scanQuickOpenSymbols,
  symbolIndexAtLine,
} from "./documentSymbols.js";

describe("scanDocumentSymbols", () => {
  it("nests TS methods under their class", () => {
    const text = [
      "export class EditorAreaController {",
      "  constructor() {}",
      "  async openFile(path: string): Promise<void> {",
      "    return;",
      "  }",
      "  private createEditor(): void {",
      "    this.editor = null;",
      "  }",
      "}",
      "export function loadMonaco(): Promise<void> {",
      "  return Promise.resolve();",
      "}",
    ].join("\n");
    const symbols = scanDocumentSymbols(text, { path: "editor.ts" });
    assert.deepEqual(
      symbols.map((s) => `${s.depth}:${s.kind}:${s.name}`),
      [
        "0:class:EditorAreaController",
        "1:function:constructor",
        "1:function:openFile",
        "1:function:createEditor",
        "0:function:loadMonaco",
      ],
    );
    const openFile = symbols.find((s) => s.name === "openFile");
    assert.equal(openFile?.params, "path: string");
    assert.equal(openFile?.returnType, "Promise<void>");
    const createEditor = symbols.find((s) => s.name === "createEditor");
    assert.equal(createEditor?.params, "");
    assert.equal(createEditor?.returnType, "void");
    const loadMonaco = symbols.find((s) => s.name === "loadMonaco");
    assert.equal(loadMonaco?.params, "");
    assert.equal(loadMonaco?.returnType, "Promise<void>");
  });

  it("joins multi-line parameter lists", () => {
    const text = [
      "export class EditorAreaController {",
      "  async revealFileLine(",
      "    path: string,",
      "    line?: number,",
      "  ): Promise<void> {",
      "    return;",
      "  }",
      "}",
    ].join("\n");
    const symbol = scanDocumentSymbols(text, { path: "editor.ts" }).find(
      (s) => s.name === "revealFileLine",
    );
    assert.equal(symbol?.name, "revealFileLine");
    assert.equal(symbol?.params, "path: string, line?: number");
    assert.equal(symbol?.returnType, "Promise<void>");
    assert.equal(
      outlineSignatureText(symbol!),
      "(path: string, line?: number): Promise<void>",
    );
  });

  it("picks up arrow fields and skips calls / control flow", () => {
    const text = [
      "class Host {",
      "  private readonly keydown = (event: KeyboardEvent): void => {",
      "    if (event.key === 's') this.save();",
      "  };",
      "  save(): void {",
      "    this.flush();",
      "  }",
      "}",
    ].join("\n");
    const symbols = scanDocumentSymbols(text, { path: "host.ts" });
    assert.deepEqual(
      symbols.map((s) => s.name),
      ["Host", "keydown", "save"],
    );
    const keydown = symbols.find((s) => s.name === "keydown");
    assert.equal(keydown?.params, "event: KeyboardEvent");
    assert.equal(keydown?.returnType, "void");
  });

  it("finds C++ Class::Method definitions", () => {
    const text = [
      "void AMyActor::BeginPlay()",
      "{",
      "    Super::BeginPlay();",
      "}",
      "",
      "FString UWidget::GetDisplayName() const",
      "{",
      "    return Name;",
      "}",
    ].join("\n");
    const symbols = scanDocumentSymbols(text);
    assert.deepEqual(
      symbols.map((s) => s.name),
      ["BeginPlay", "GetDisplayName"],
    );
    assert.equal(symbols[0]?.params, "");
    assert.equal(symbols[0]?.returnType, "void");
    assert.equal(symbols[1]?.params, "");
    assert.equal(symbols[1]?.returnType, "FString");
  });

  it("keeps C++ parameter lists with the leading return type", () => {
    const [symbol] = scanDocumentSymbols(
      "void AMyActor::Tick(float DeltaTime)\n{\n}\n",
    );
    assert.equal(symbol?.name, "Tick");
    assert.equal(symbol?.params, "float DeltaTime");
    assert.equal(symbol?.returnType, "void");
  });

  it("finds python class methods", () => {
    const text = [
      "class Scanner:",
      "    def run_scan(self, root: str) -> None:",
      "        pass",
      "",
      "def top_level():",
      "    return 1",
    ].join("\n");
    const symbols = scanDocumentSymbols(text);
    assert.deepEqual(
      symbols.map((s) => `${s.depth}:${s.name}`),
      ["0:Scanner", "1:run_scan", "0:top_level"],
    );
    const run = symbols.find((s) => s.name === "run_scan");
    assert.equal(run?.params, "self, root: str");
    assert.equal(run?.returnType, "None");
  });

  it("skips comments, forward declarations, and dotted calls", () => {
    const text = [
      "// class Commented",
      "class Foo;",
      "obj.method();",
      "if (ready) {",
      "  return classValue;",
      "}",
    ].join("\n");
    assert.deepEqual(scanDocumentSymbols(text, { path: "skip.ts" }), []);
  });

  it("omits locals and nested helpers inside TypeScript functions", () => {
    const text = [
      "export const MAX = 400;",
      "export type Id = string;",
      "export class Host {",
      "  private editor: string | null = null;",
      "  constructor() {}",
      "  start(): void {",
      "    const tmp = 1;",
      "    function helper() {}",
      "    signatureOf(",
      "      span,",
      "    );",
      "  }",
      "}",
      "export function boot(): void {",
      "  const inner = (): void => {",
      "    return;",
      "  };",
      "  function nest() {}",
      "}",
      "const load = async (): Promise<void> => {",
      "  const x = 1;",
      "};",
    ].join("\n");
    const symbols = scanDocumentSymbols(text, { path: "host.ts" });
    assert.deepEqual(
      symbols.map((s) => `${s.depth}:${s.kind}:${s.name}`),
      [
        "0:variable:MAX",
        "0:type:Id",
        "0:class:Host",
        "1:variable:editor",
        "1:function:constructor",
        "1:function:start",
        "0:function:boot",
        "0:function:load",
      ],
    );
    const editor = symbols.find((s) => s.name === "editor");
    assert.equal(editor?.returnType, "string | null");
  });
});

describe("symbolIndexAtLine", () => {
  it("highlights the innermost symbol at or before the caret", () => {
    const symbols = scanDocumentSymbols(
      [
        "class Foo {",
        "  bar(): void {}",
        "  baz(): void {}",
        "}",
      ].join("\n"),
      { path: "foo.ts" },
    );
    assert.equal(symbolIndexAtLine(symbols, 1), 0);
    assert.equal(symbolIndexAtLine(symbols, 2), 1);
    assert.equal(symbolIndexAtLine(symbols, 3), 2);
    assert.equal(symbolIndexAtLine(symbols, 99), 2);
  });
});

describe("filterDocumentSymbols", () => {
  it("keeps matching members and their ancestor rows", () => {
    const symbols = scanDocumentSymbols(
      [
        "export class Host {",
        "  start(): void {}",
        "  boot(): number {}",
        "}",
        "export function load() {}",
      ].join("\n"),
      { path: "host.ts" },
    );
    assert.deepEqual(
      filterDocumentSymbols(symbols, "boot").map((s) => s.name),
      ["Host", "boot"],
    );
    assert.deepEqual(
      filterDocumentSymbols(symbols, "load").map((s) => s.name),
      ["load"],
    );
    assert.deepEqual(
      filterDocumentSymbols(symbols, "void").map((s) => s.name),
      ["Host", "start"],
    );
  });
});

describe("scanQuickOpenSymbols", () => {
  it("indexes TypeScript class methods and module functions", () => {
    const text = [
      "export class EditorAreaController {",
      "  async openFile(path: string): Promise<void> {",
      "    return;",
      "  }",
      "  private createEditor(): void {",
      "    function helper() {}",
      "  }",
      "}",
      "export function loadMonaco(): Promise<void> {",
      "  return Promise.resolve();",
      "}",
    ].join("\n");
    const hits = scanQuickOpenSymbols(text, "editor.ts");
    assert.deepEqual(
      hits.map((s) => `${s.kind}:${s.container ?? ""}:${s.name}`),
      [
        "class::EditorAreaController",
        "function:EditorAreaController:openFile",
        "function:EditorAreaController:createEditor",
        "function::loadMonaco",
      ],
    );
    assert.equal(hits.some((s) => s.name === "helper"), false);
  });

  it("indexes C++ header member functions and skips fields", () => {
    const text = [
      "class AMyActor : public AActor",
      "{",
      "public:",
      "    int32 Health;",
      "    void BeginPlay();",
      "    void Tick(float DeltaTime);",
      "private:",
      "    void TickInternal();",
      "};",
    ].join("\n");
    const hits = scanQuickOpenSymbols(text, "MyActor.h");
    assert.deepEqual(
      hits.map((s) => `${s.kind}:${s.container ?? ""}:${s.name}`),
      [
        "class::AMyActor",
        "function:AMyActor:BeginPlay",
        "function:AMyActor:Tick",
        "function:AMyActor:TickInternal",
      ],
    );
  });

  it("indexes C++ Class::Method definitions in .cpp sources", () => {
    const text = [
      "void AMyActor::BeginPlay()",
      "{",
      "}",
      "void AMyActor::Tick(float DeltaTime)",
      "{",
      "}",
    ].join("\n");
    assert.deepEqual(scanDocumentSymbols(text, { path: "MyActor.cpp" }), []);
    const hits = scanQuickOpenSymbols(text, "MyActor.cpp");
    assert.deepEqual(
      hits.map((s) => `${s.name}:${s.line}`),
      ["BeginPlay:1", "Tick:4"],
    );
  });

  it("indexes python defs and rust fn heads", () => {
    const py = scanQuickOpenSymbols(
      "class Scanner:\n    def run_scan(self, root: str) -> None:\n        pass\n",
      "scan.py",
    );
    assert.deepEqual(
      py.map((s) => s.name),
      ["Scanner", "run_scan"],
    );
    const rs = scanQuickOpenSymbols(
      "pub async fn fetch_all(&self) -> Vec<Entry> {\n}\n",
      "lib.rs",
    );
    assert.deepEqual(
      rs.map((s) => s.name),
      ["fetch_all"],
    );
  });
});