import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { LUA_SEMANTIC_TOKEN_TYPES } from "../../../shared/luaSemanticLegend.js";
import { languageForPath } from "./languages.js";
import { isLuaPath, LUA_SEMANTIC_RETRY_MS, registerLuaProviders, type LuaModel } from "./luaFeatures.js";

type Provider = Record<string, (...args: unknown[]) => Promise<unknown>>;

function harness(bridge: Record<string, unknown>) {
  const providers = new Map<string, Provider>();
  const disposed: string[] = [];
  const register = (kind: string) => (languageId: string, provider: Provider) => {
    assert.equal(languageId, "lua");
    providers.set(kind, provider);
    return { dispose: () => disposed.push(kind) };
  };
  (globalThis as { window?: unknown }).window = { jellybot: bridge };
  const notices: string[] = [];
  const handle = registerLuaProviders(
    {
      languages: {
        registerCompletionItemProvider: register("completion") as never,
        registerHoverProvider: register("hover") as never,
        registerSignatureHelpProvider: register("signature") as never,
        registerDocumentSemanticTokensProvider: register("semantic") as never,
      },
    },
    { getWorkspaceRoot: () => "E:/NF", onUnavailable: (message) => notices.push(message) },
  );
  const model: LuaModel = {
    getValue: () => "    self.Bt",
    getWordUntilPosition: () => ({ startColumn: 10, endColumn: 12 }),
    uri: { scheme: "file", path: "/E:/NF/Content/Script/View.lua" },
  };
  return { providers, disposed, notices, handle, model };
}

test(".lua files open as the lua language", () => {
  assert.equal(languageForPath("E:/NF/Content/Script/View.lua").languageId, "lua");
  assert.ok(isLuaPath("a/B.LUA"));
  assert.ok(!isLuaPath("a/B.luac"));
});

test("completion maps server items onto the typed word and forwards the trigger", async () => {
  const requests: unknown[] = [];
  const h = harness({
    luaLsCompletion: async (root: string, request: unknown) => {
      requests.push([root, request]);
      return {
        ok: true,
        isIncomplete: true,
        items: [
          { label: "BtnHide", kind: 5, insertText: "BtnHide", isSnippet: false, detail: "UMoreButton" },
          { label: "Cache", kind: 2, insertText: "Cache()", isSnippet: true, documentation: "doc" },
        ],
      };
    },
  });
  try {
    const result = (await h.providers.get("completion")!.provideCompletionItems!(
      h.model,
      { lineNumber: 3, column: 12 },
      { triggerCharacter: "." },
    )) as { incomplete: boolean; suggestions: Record<string, unknown>[] };
    assert.deepEqual(requests, [[
      "E:/NF",
      { path: "E:/NF/Content/Script/View.lua", line: 3, column: 12, text: "    self.Bt", triggerCharacter: "." },
    ]]);
    assert.equal(result.incomplete, true);
    const range = { startLineNumber: 3, endLineNumber: 3, startColumn: 10, endColumn: 12 };
    assert.deepEqual(result.suggestions, [
      { label: "BtnHide", kind: 3, insertText: "BtnHide", range, detail: "UMoreButton" },
      { label: "Cache", kind: 0, insertText: "Cache()", range, insertTextRules: 4, documentation: { value: "doc" } },
    ]);
    h.handle.dispose();
    assert.deepEqual(h.disposed, ["completion", "hover", "signature", "semantic"]);
  } finally {
    delete (globalThis as { window?: unknown }).window;
  }
});

test("a missing server is announced once and providers stay quiet", async () => {
  const missing = { ok: false, reason: "not_found", message: "Lua language server not found." };
  const h = harness({
    luaLsCompletion: async () => missing,
    luaLsHover: async () => missing,
  });
  try {
    const position = { lineNumber: 1, column: 1 };
    const first = (await h.providers.get("completion")!.provideCompletionItems!(h.model, position, {})) as {
      suggestions: unknown[];
    };
    assert.deepEqual(first.suggestions, []);
    assert.equal(await h.providers.get("hover")!.provideHover!(h.model, position), null);
    await h.providers.get("completion")!.provideCompletionItems!(h.model, position, {});
    assert.deepEqual(h.notices, ["Lua language server not found."]);
  } finally {
    delete (globalThis as { window?: unknown }).window;
  }
});

test("semantic tokens use the shared legend and re-request until the server has loaded", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const responses = [
    { ok: true, data: [], ready: false },
    { ok: true, data: [0, 9, 9, 2, 0], ready: true },
  ];
  const h = harness({ luaLsSemanticTokens: async () => responses.shift() });
  try {
    const provider = h.providers.get("semantic")! as unknown as {
      getLegend(): { tokenTypes: string[] };
      onDidChange(listener: () => void): { dispose(): void };
      provideDocumentSemanticTokens(model: LuaModel): Promise<{ data: Uint32Array } | null>;
    };
    assert.deepEqual(provider.getLegend().tokenTypes, [...LUA_SEMANTIC_TOKEN_TYPES]);
    let changes = 0;
    provider.onDidChange(() => changes++);
    const first = await provider.provideDocumentSemanticTokens(h.model);
    assert.deepEqual([...first!.data], []);
    assert.equal(changes, 0);
    mock.timers.tick(LUA_SEMANTIC_RETRY_MS);
    assert.equal(changes, 1, "a not-ready answer asks Monaco to request again");
    const second = await provider.provideDocumentSemanticTokens(h.model);
    assert.ok(second!.data instanceof Uint32Array);
    assert.deepEqual([...second!.data], [0, 9, 9, 2, 0]);
    mock.timers.tick(LUA_SEMANTIC_RETRY_MS * 3);
    assert.equal(changes, 1, "a ready answer stops the retries");
  } finally {
    h.handle.dispose();
    mock.timers.reset();
    delete (globalThis as { window?: unknown }).window;
  }
});

test("signature help uses the active signature and parameter", async () => {
  const h = harness({
    luaLsSignatureHelp: async () => ({
      ok: true,
      activeSignature: 0,
      signatures: [{ label: "SetText(InText: string, bNotify: boolean)", parameters: ["InText: string", "bNotify: boolean"], activeParameter: 1 }],
    }),
  });
  try {
    const result = (await h.providers.get("signature")!.provideSignatureHelp!(h.model, { lineNumber: 1, column: 5 })) as {
      value: { activeSignature: number; activeParameter: number; signatures: { parameters: unknown[] }[] };
    };
    assert.equal(result.value.activeSignature, 0);
    assert.equal(result.value.activeParameter, 1);
    assert.equal(result.value.signatures[0]?.parameters.length, 2);
  } finally {
    delete (globalThis as { window?: unknown }).window;
  }
});
