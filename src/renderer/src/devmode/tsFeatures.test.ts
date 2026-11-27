import assert from "node:assert/strict";
import { test } from "node:test";
import { languageForPath } from "./languages.js";
import {
  isTypeScriptPath,
  registerTsProviders,
  TS_WORKER_MODE_CONFIGURATION,
  tsDefinition,
  type TsModel,
} from "./tsFeatures.js";

type Provider = Record<string, (...args: unknown[]) => Promise<unknown>>;

function harness(bridge: Record<string, unknown>) {
  const providers = new Map<string, Provider>();
  const registered: string[] = [];
  const disposed: string[] = [];
  const register = (kind: string) => (languageId: string, provider: Provider) => {
    registered.push(`${languageId}:${kind}`);
    providers.set(kind, provider);
    return { dispose: () => disposed.push(`${languageId}:${kind}`) };
  };
  (globalThis as { window?: unknown }).window = { jellybot: bridge };
  const notices: string[] = [];
  const handle = registerTsProviders(
    {
      languages: {
        registerCompletionItemProvider: register("completion"),
        registerHoverProvider: register("hover"),
        registerSignatureHelpProvider: register("signature"),
        registerDefinitionProvider: register("definition"),
        registerReferenceProvider: register("references"),
      },
      Uri: { file: (path: string) => ({ file: path }) },
    },
    { getWorkspaceRoot: () => "E:/App", onUnavailable: (message) => notices.push(message) },
  );
  const model: TsModel = {
    getValue: () => "const v = addVec(a, b);\nv.",
    getWordUntilPosition: () => ({ startColumn: 3, endColumn: 3 }),
    uri: { scheme: "file", path: "/E:/App/src/main.ts" },
  };
  return { providers, registered, disposed, notices, handle, model };
}

function withWindow(run: () => Promise<void>): () => Promise<void> {
  return async () => {
    try {
      await run();
    } finally {
      delete (globalThis as { window?: unknown }).window;
    }
  };
}

test("every JS / TS extension routes to the language server", () => {
  for (const path of ["a.ts", "a.tsx", "a.mts", "a.cts", "a.js", "a.jsx", "a.mjs", "a.cjs", "a.d.ts"]) {
    assert.ok(isTypeScriptPath(`E:/App/${path}`), path);
    assert.match(languageForPath(`E:/App/${path}`).languageId, /^(typescript|javascript)$/);
  }
  assert.ok(!isTypeScriptPath("E:/App/a.json"));
  assert.ok(!isTypeScriptPath("E:/App/a.lua"));
});

test("Monaco's own worker keeps only syntax-level features", () => {
  for (const key of ["completionItems", "hovers", "definitions", "references", "diagnostics", "signatureHelp", "rename", "codeActions"] as const) {
    assert.equal(TS_WORKER_MODE_CONFIGURATION[key], false, key);
  }
  for (const key of ["documentSymbols", "documentHighlights", "documentRangeFormattingEdits", "onTypeFormattingEdits"] as const) {
    assert.equal(TS_WORKER_MODE_CONFIGURATION[key], true, key);
  }
});

test("providers register for TypeScript and JavaScript and dispose together", withWindow(async () => {
  const h = harness({});
  const kinds = ["completion", "hover", "signature", "definition", "references"];
  assert.deepEqual(h.registered, [...kinds.map((k) => `typescript:${k}`), ...kinds.map((k) => `javascript:${k}`)]);
  h.handle.dispose();
  assert.deepEqual(h.disposed, h.registered);
}));

test("completion uses the server range, carries auto-import edits and resolves lazily", withWindow(async () => {
  const requests: unknown[] = [];
  const h = harness({
    tsLsCompletion: async (root: string, request: unknown) => {
      requests.push([root, request]);
      return {
        ok: true,
        isIncomplete: false,
        items: [
          {
            label: "x",
            kind: 5,
            insertText: "x",
            isSnippet: false,
            range: { startLine: 2, startColumn: 3, endLine: 2, endColumn: 3 },
            resolveId: "1:0",
          },
          {
            label: "ORIGIN",
            kind: 2,
            insertText: "ORIGIN",
            isSnippet: false,
            range: { startLine: 9, startColumn: 1, endLine: 9, endColumn: 4 },
            additionalEdits: [{ range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 }, text: "import { ORIGIN } from \"./math\";\n" }],
          },
        ],
      };
    },
    tsLsResolveCompletion: async (root: string, request: unknown) => {
      requests.push([root, request]);
      return { ok: true, detail: "(property) Vec.x: number", documentation: "X axis" };
    },
  });
  const result = (await h.providers.get("completion")!.provideCompletionItems!(
    h.model,
    { lineNumber: 2, column: 3 },
    { triggerCharacter: "." },
  )) as { suggestions: Record<string, unknown>[] };
  assert.deepEqual(requests[0], [
    "E:/App",
    { path: "E:/App/src/main.ts", line: 2, column: 3, text: "const v = addVec(a, b);\nv.", triggerCharacter: "." },
  ]);
  const [x, origin] = result.suggestions;
  assert.deepEqual(x!.range, { startLineNumber: 2, startColumn: 3, endLineNumber: 2, endColumn: 3 });
  assert.deepEqual(x!.tsResolve, { root: "E:/App", path: "E:/App/src/main.ts", resolveId: "1:0" });
  assert.deepEqual(origin!.range, { startLineNumber: 2, endLineNumber: 2, startColumn: 3, endColumn: 3 });
  assert.deepEqual(origin!.additionalTextEdits, [
    { range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, text: "import { ORIGIN } from \"./math\";\n" },
  ]);
  const resolved = (await h.providers.get("completion")!.resolveCompletionItem!(x)) as Record<string, unknown>;
  assert.deepEqual(requests[1], ["E:/App", { path: "E:/App/src/main.ts", resolveId: "1:0" }]);
  assert.equal(resolved.detail, "(property) Vec.x: number");
  assert.deepEqual(resolved.documentation, { value: "X axis" });
}));

test("definitions and references open as file locations; F12 reads the same answer", withWindow(async () => {
  const locations = [{ path: "E:/App/src/math.ts", line: 4, column: 17 }];
  const h = harness({
    tsLsDefinition: async () => ({ ok: true, locations }),
    tsLsReferences: async () => ({ ok: true, locations }),
  });
  const expected = [{ uri: { file: "E:/App/src/math.ts" }, range: { startLineNumber: 4, startColumn: 17, endLineNumber: 4, endColumn: 17 } }];
  assert.deepEqual(await h.providers.get("definition")!.provideDefinition!(h.model, { lineNumber: 1, column: 12 }), expected);
  assert.deepEqual(await h.providers.get("references")!.provideReferences!(h.model, { lineNumber: 1, column: 12 }), expected);
  assert.deepEqual(await tsDefinition("E:/App", h.model, { lineNumber: 1, column: 12 }), locations);
}));

test("a missing server is reported once and every feature degrades to empty", withWindow(async () => {
  const missing = async () => ({ ok: false, reason: "not_found", message: "TypeScript language server is not bundled." });
  const h = harness({ tsLsCompletion: missing, tsLsHover: missing, tsLsDefinition: missing, tsLsSignatureHelp: missing });
  const pos = { lineNumber: 1, column: 12 };
  assert.deepEqual(await h.providers.get("completion")!.provideCompletionItems!(h.model, pos, {}), { suggestions: [] });
  assert.equal(await h.providers.get("hover")!.provideHover!(h.model, pos), null);
  assert.equal(await h.providers.get("definition")!.provideDefinition!(h.model, pos), null);
  assert.equal(await h.providers.get("signature")!.provideSignatureHelp!(h.model, pos), null);
  assert.deepEqual(h.notices, ["TypeScript language server is not bundled."]);
}));
