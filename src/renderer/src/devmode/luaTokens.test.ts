import assert from "node:assert/strict";
import { test } from "node:test";
import { language as stockLua } from "monaco-editor/languages/definitions/lua/lua.js";
import { compile } from "monaco-editor/editor/standalone/common/monarch/monarchCompile.js";
import { MonarchTokenizer } from "monaco-editor/editor/standalone/common/monarch/monarchLexer.js";
import { buildLuaLanguage, type StockLuaLanguage } from "./luaTokens.js";

type Token = { offset: number; type: string };
type LineState = unknown;

function tokenizer() {
  const lexer = compile("lua", buildLuaLanguage(stockLua as unknown as StockLuaLanguage) as never);
  const config = { getValue: () => 20_000, onDidChangeConfiguration: () => ({ dispose() {} }) };
  return new MonarchTokenizer(
    { languageIdCodec: { encodeLanguageId: () => 1 }, isRegisteredLanguageId: () => false } as never,
    { getColorTheme: () => ({ tokenTheme: { match: () => 0 } }) } as never,
    "lua",
    lexer,
    config as never,
  ) as unknown as {
    getInitialState(): LineState;
    tokenize(line: string, hasEOL: boolean, state: LineState): { tokens: Token[]; endState: LineState };
  };
}

function tokensOf(source: string): Array<[string, string]> {
  const lexer = tokenizer();
  let state = lexer.getInitialState();
  const out: Array<[string, string]> = [];
  for (const line of source.split("\n")) {
    const result = lexer.tokenize(line, true, state);
    state = result.endState;
    result.tokens.forEach((token, i) => {
      const end = result.tokens[i + 1]?.offset ?? line.length;
      const text = line.slice(token.offset, end);
      if (text.trim()) out.push([text.trim(), token.type.replace(/\.lua$/, "")]);
    });
  }
  return out;
}

function typeOf(tokens: Array<[string, string]>, text: string): string | undefined {
  return tokens.find(([t]) => t === text)?.[1];
}

test("function declarations color the owner as a type and the name as a function", () => {
  const t = tokensOf("function BP_Hero_C:Cache()\nend\nlocal function helper(a)\nend\nfunction M.Util.Run() end");
  assert.equal(typeOf(t, "function"), "keyword.function");
  assert.equal(typeOf(t, "BP_Hero_C"), "type");
  assert.equal(typeOf(t, "Cache"), "function.declaration");
  assert.equal(typeOf(t, "helper"), "function.declaration");
  assert.equal(typeOf(t, "Util"), "type");
  assert.equal(typeOf(t, "Run"), "function.declaration");
});

test("anonymous functions keep their parameters list intact", () => {
  const t = tokensOf("local f = function(a, b) return a end");
  assert.equal(typeOf(t, "function"), "keyword.function");
  assert.equal(typeOf(t, "a"), "identifier");
});

test("calls, self, UE namespace and Unreal type names", () => {
  const t = tokensOf("self:Cache()\nlocal actor = UE.AActor\nprint(UUserWidget, FVector, EState, counter)\nself.Btn:SetText('x')");
  assert.equal(typeOf(t, "self"), "variable.predefined");
  assert.equal(typeOf(t, "Cache"), "function.call");
  assert.equal(typeOf(t, "UE"), "namespace");
  assert.equal(typeOf(t, "AActor"), "type");
  assert.equal(typeOf(t, "print"), "function.call");
  assert.equal(typeOf(t, "UUserWidget"), "type");
  assert.equal(typeOf(t, "FVector"), "type");
  assert.equal(typeOf(t, "EState"), "type");
  assert.equal(typeOf(t, "counter"), "identifier");
  assert.equal(typeOf(t, "SetText"), "function.call");
  assert.equal(typeOf(t, "local"), "keyword.local");
});

test("doc annotations color tags, names and types, and end with the line", () => {
  const t = tokensOf("---@class BP_View_C : NFModeVisual_C\n---@field public BtnHide UMoreButton @hide\n---@param InText string\n---@type BP_View_C|BP_View_BP\nlocal x = 1\n-- plain comment");
  assert.equal(typeOf(t, "InText"), "variable.parameter", "visibility is optional on @param");
  assert.equal(typeOf(t, "@class"), "annotation");
  assert.equal(typeOf(t, "BP_View_C"), "type");
  assert.equal(typeOf(t, "NFModeVisual_C"), "type");
  assert.equal(typeOf(t, "@field"), "annotation");
  assert.equal(typeOf(t, "BtnHide"), "variable.parameter");
  assert.equal(typeOf(t, "UMoreButton"), "type");
  assert.equal(typeOf(t, "BP_View_BP"), "type");
  assert.equal(typeOf(t, "local"), "keyword.local", "state pops back to code after the doc line");
  assert.equal(typeOf(t, "-- plain comment"), "comment");
});
