import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { ensureProjectCompileDatabase } from "./compileDbGenerate.js";
import { LspConnection } from "./lsp.js";
import { findClangdBinary } from "./locate.js";

const binary = findClangdBinary();

test("complete database preserves engine definitions and references in generated and vendor TUs", {
  skip: !binary && "clangd is not installed",
  timeout: 30_000,
}, async () => {
  const temporaryDir = await realpath(tmpdir());
  const root = await mkdtemp(join(temporaryDir, "jb-clangd-semantic-"));
  let conn: LspConnection | undefined;
  let exited: Promise<void> | undefined;
  try {
    const project = join(root, "Game"), engine = join(root, "Engine");
    await mkdir(join(project, "Source"), { recursive: true });
    await mkdir(join(project, "Intermediate"));
    await mkdir(join(project, "Plugins", "ThirdParty"), { recursive: true });
    await mkdir(engine);
    await writeFile(join(project, "Game.uproject"), "{}");
    const header = join(engine, "EngineApi.h");
    const impl = join(engine, "EngineApi.cpp");
    const main = join(project, "Source", "Main.cpp");
    const generated = join(project, "Source", "Messages.pb.cc");
    const uht = join(project, "Intermediate", "Module.Game.gen.cpp");
    const vendor = join(project, "Plugins", "ThirdParty", "Codec.cpp");
    const mainText = '#include "EngineApi.h"\nint Main() { return EngineApi(); }\n';
    await writeFile(header, "int EngineApi();\n");
    await writeFile(impl, '#include "EngineApi.h"\nint EngineApi() { return 7; }\n');
    await writeFile(main, mainText);
    await writeFile(generated, '#include "EngineApi.h"\nint GeneratedCaller() { return EngineApi(); }\n');
    await writeFile(uht, '#include "EngineApi.h"\nint UhtCaller() { return EngineApi(); }\n');
    await writeFile(vendor, '#include "EngineApi.h"\nint VendorCaller() { return EngineApi(); }\n');
    const compiler = join(dirname(binary!), process.platform === "win32" ? "clang++.exe" : "clang++");
    const commands = [impl, main, generated, uht, vendor].map(file => ({
      file, directory: root, arguments: [compiler, "-std=c++20", "-I" + engine, "-c", file],
    }));
    await writeFile(join(project, "compile_commands.json"), JSON.stringify(commands));
    const prepared = await ensureProjectCompileDatabase(project);
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    let onExit!: () => void;
    exited = new Promise<void>(resolve => { onExit = resolve; });
    conn = await LspConnection.start(binary!, [
      "--compile-commands-dir=" + dirname(prepared.outputFile), "--background-index",
      "--clang-tidy=false", "--pch-storage=disk", "-j=2", "--log=error",
    ], { rootUri: pathToFileURL(project).href, onExit }, root);
    let indexed = false;
    conn.onNotification = (method, params) => {
      if (method === "$/progress" && (params as { value?: { kind?: string } })?.value?.kind === "end") indexed = true;
    };
    const uri = pathToFileURL(main).href;
    conn.notify("textDocument/didOpen", { textDocument: { uri, languageId: "cpp", version: 1, text: mainText } });
    const position = { line: 1, character: 21 };
    await conn.request("textDocument/hover", { textDocument: { uri }, position }, 15_000);
    const deadline = Date.now() + 15_000;
    while (!indexed && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(indexed, true, "background indexing must finish before checking cross-TU results");
    const definitions = await conn.request("textDocument/definition", { textDocument: { uri }, position }) as { uri: string }[];
    assert.equal(definitions[0]?.uri, pathToFileURL(impl).href);
    const refs = await conn.request("textDocument/references", {
      textDocument: { uri }, position, context: { includeDeclaration: true },
    }) as { uri: string }[];
    for (const file of [impl, main, header, generated, uht, vendor]) {
      assert.ok(refs.some(ref => ref.uri === pathToFileURL(file).href), "missing references in " + file);
    }
  } finally {
    conn?.dispose();
    if (exited && conn) await exited;
    assert.ok(resolve(root).startsWith(resolve(temporaryDir) + sep));
    await rm(root, { recursive: true, force: true });
  }
});
