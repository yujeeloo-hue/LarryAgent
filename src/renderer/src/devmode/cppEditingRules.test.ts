import assert from "node:assert/strict";
import { test } from "node:test";

import { buildCppLanguageConfiguration } from "./cppLanguageConfig.js";
import { controlFlowSnippets, detectBraceStyle } from "./cppTextCompletion.js";

test("brace style follows the file (Unreal Allman by default)", () => {
  const allman = "void A::B()\n{\n\tif (X)\n\t{\n\t}\n}\n";
  const kr = "void f() {\n  if (x) {\n  }\n  while (y) {\n  }\n}\n";
  assert.equal(detectBraceStyle(allman), "allman");
  assert.equal(detectBraceStyle(kr), "kr");
  assert.equal(detectBraceStyle(""), "allman");
});

test("control-flow snippets expand to parentheses + an indented block", () => {
  const [ifAllman] = controlFlowSnippets("\tif", "if", "allman");
  assert.equal(ifAllman!.label, "if");
  assert.equal(ifAllman!.insertText, "if (${1:condition})\n{\n\t$0\n}");
  assert.equal(ifAllman!.isSnippet, true);
  const [ifKr] = controlFlowSnippets("  if", "if", "kr");
  assert.equal(ifKr!.insertText, "if (${1:condition}) {\n\t$0\n}");
  const fors = controlFlowSnippets("    fo", "fo", "allman").map((s) => s.label);
  assert.deepEqual(fors, ["for", "for range"]);
});

test("snippets only at statement position; after `}` only else-forms", () => {
  assert.deepEqual(controlFlowSnippets("x = if", "if", "allman"), []);
  assert.deepEqual(controlFlowSnippets("Foo(el", "el", "allman"), []);
  const afterClose = controlFlowSnippets("\t} el", "el", "allman").map((s) => s.label);
  assert.deepEqual(afterClose, ["else if", "else"]);
  assert.deepEqual(controlFlowSnippets("\t} if", "if", "allman"), []);
});

test("language config: auto-close pairs, indent / outdent and doc comments", () => {
  const conf = buildCppLanguageConfiguration({ comments: { lineComment: "//" } });
  const opens = conf.autoClosingPairs.map((p) => p.open);
  for (const open of ["{", "[", "(", '"', "'"]) assert.ok(opens.includes(open));
  assert.deepEqual(conf.comments, { lineComment: "//" });
  // `(` right before an identifier must not auto-close.
  assert.equal(conf.autoCloseBefore.includes("F"), false);
  assert.ok(conf.autoCloseBefore.includes(")") && conf.autoCloseBefore.includes(";"));

  const { increaseIndentPattern: inc, decreaseIndentPattern: dec } = conf.indentationRules;
  assert.ok(inc.test("if (bReady) {"));
  assert.ok(inc.test("{"));
  assert.ok(inc.test("public:"));
  assert.equal(inc.test("Foo(); // {"), false);
  assert.ok(dec.test("    }"));
  assert.ok(dec.test("private:"));

  const docOpen = conf.onEnterRules[0]!;
  assert.ok(docOpen.beforeText.test("    /**"));
  assert.ok(docOpen.afterText!.test(" */"));
  assert.equal(docOpen.action.appendText, " * ");
});
