import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { LanguageServerProgressEvent } from "../lsp/progressTypes.js";
import { findTypeScriptServer } from "./locate.js";
import { TypeScriptLanguageService } from "./service.js";

const binary = findTypeScriptServer();

const MATH = [
  "export interface Vec { x: number; y: number }",
  "",
  "/** Adds two vectors. */",
  "export function addVec(a: Vec, b: Vec): Vec {",
  "  return { x: a.x + b.x, y: a.y + b.y };",
  "}",
  "",
  "export const ORIGIN: Vec = { x: 0, y: 0 };",
  "",
].join("\n");

const MAIN = [
  'import { addVec, ORIGIN } from "./math.js";',
  "",
  "const moved = addVec(ORIGIN, { x: 1, y: 2 });",
  "moved.x;",
  "",
].join("\n");

async function put(root: string, rel: string, text: string): Promise<string> {
  const file = join(root, rel);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
  return file;
}

function lineCol(text: string, needle: string, delta = 0): { line: number; column: number } {
  const offset = text.indexOf(needle) + delta;
  const before = text.slice(0, offset).split("\n");
  return { line: before.length, column: before.at(-1)!.length + 1 };
}

test("the bundled TypeScript server resolves an unopened module, references, hover and completion", {
  skip: !binary && "bundled TypeScript server is not extracted (node prepare-typescript-ls.mjs)",
  timeout: 90_000,
}, async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "jb-ts-ls-"));
  const progress: LanguageServerProgressEvent[] = [];
  const service = new TypeScriptLanguageService(undefined, event => progress.push(event));
  try {
    await put(root, "tsconfig.json", JSON.stringify({
      compilerOptions: { target: "es2022", module: "nodenext", moduleResolution: "nodenext", strict: true, jsx: "preserve" },
      include: ["src"],
    }));
    const mathFile = await put(root, "src/math.ts", MATH);
    const mainFile = await put(root, "src/main.ts", MAIN);
    const appText = "export function App() { return <div className=\"a\">hi</div>; }\n";
    const appFile = await put(root, "src/App.tsx", appText);

    const def = await service.definition(root, { path: mainFile, ...lineCol(MAIN, "addVec(ORIGIN", 2), text: MAIN });
    assert.ok(def.ok, def.ok ? "" : def.message);
    assert.deepEqual(def.locations.map(l => [l.path, l.line]), [[mathFile, 4]]);

    const refs = await service.references(root, { path: mathFile, ...lineCol(MATH, "function addVec", 10), text: MATH });
    assert.ok(refs.ok, refs.ok ? "" : refs.message);
    assert.ok(refs.locations.some(l => l.path === mainFile && l.line === 3), JSON.stringify(refs.locations));
    assert.ok(refs.locations.some(l => l.path === mathFile && l.line === 4), JSON.stringify(refs.locations));

    const hover = await service.hover(root, { path: mainFile, ...lineCol(MAIN, "moved =", 1), text: MAIN });
    assert.ok(hover.ok);
    assert.match(hover.markdown ?? "", /Vec/);

    const callText = MAIN.replace("moved.x;", "addVec(");
    const sig = await service.signatureHelp(root, { path: mainFile, ...lineCol(callText, "addVec(\n", 7), text: callText });
    assert.ok(sig.ok);
    assert.match(sig.signatures[0]?.label ?? "", /a: Vec, b: Vec/);

    const dotText = MAIN.replace("moved.x;", "moved.");
    const members = await service.completion(root, {
      path: mainFile, ...lineCol(dotText, "moved.\n", 6), text: dotText, triggerCharacter: ".",
    });
    assert.ok(members.ok, members.ok ? "" : members.message);
    assert.deepEqual(members.items.map(i => i.label).sort(), ["x", "y"]);

    const wordText = MAIN.replace("moved.x;", "addV");
    const words = await service.completion(root, { path: mainFile, ...lineCol(wordText, "addV\n", 4), text: wordText });
    assert.ok(words.ok);
    const resolveId = words.items.find(i => i.label === "addVec")?.resolveId;
    assert.ok(resolveId, words.items.slice(0, 20).map(i => i.label).join(", "));
    const resolved = await service.resolveCompletion(root, { path: mainFile, resolveId });
    assert.ok(resolved.ok);
    assert.match(`${resolved.detail ?? ""} ${resolved.documentation ?? ""}`, /Adds two vectors|Vec/);

    const otherText = "export const start = ORIG\n";
    const otherFile = await put(root, "src/other.ts", otherText);
    const auto = await service.completion(root, { path: otherFile, ...lineCol(otherText, "ORIG\n", 4), text: otherText });
    assert.ok(auto.ok);
    const origin = auto.items.find(i => i.label === "ORIGIN");
    assert.ok(origin?.resolveId, auto.items.slice(0, 20).map(i => i.label).join(", "));
    const imported = await service.resolveCompletion(root, { path: otherFile, resolveId: origin.resolveId });
    assert.ok(imported.ok);
    const edits = [...(origin.additionalEdits ?? []), ...(imported.additionalEdits ?? [])];
    assert.ok(edits.some(edit => /import \{ ORIGIN \} from "\.\/math(?:\.js)?"/.test(edit.text)), JSON.stringify(edits));

    const jsx = await service.hover(root, { path: appFile, ...lineCol(appText, "App()", 1), text: appText });
    assert.ok(jsx.ok);
    assert.match(jsx.markdown ?? "", /App/);

    service.docClosed(root, mainFile);
    assert.equal(progress[0]?.phase, "starting");
    assert.ok(progress.every(event => event.server === "typescript" && event.rootPath === root));
    service.stop();
    assert.equal(progress.at(-1)?.phase, "idle");
  } finally {
    service.stop();
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

test("a missing TypeScript server is reported as not_found", async () => {
  const service = new TypeScriptLanguageService(() => null);
  const res = await service.definition("/ws", { path: "/ws/a.ts", line: 1, column: 1, text: "" });
  assert.equal(res.ok, false);
  assert.equal(res.ok ? null : res.reason, "not_found");
});
