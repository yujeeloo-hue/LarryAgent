import assert from "node:assert/strict";
import test from "node:test";
import { compactSignatureLabel, formatCompactHover, semanticHoverParts } from "./compactLanguagePopover.js";
import { compactSignatureInformation } from "./clangdFeatures.js";
import { formatCppHoverMarkdown, registerCppLanguageFeatures } from "./cppLanguageFeatures.js";

test("long signatures preserve nested templates and quoted commas while wrapping", () => {
  const params = ['const TMap<FName, TArray<int32>>& Items', 'const FString& Message = TEXT("first, second")', 'int32 Count'];
  const label = `bool UInventoryComponent::TryAddItem(${params.join(", ")}) const`;
  const wrapped = compactSignatureLabel(label);
  assert.equal(wrapped, `bool UInventoryComponent::TryAddItem(\n    ${params.join(",\n    ")}\n) const`);
  const result = compactSignatureInformation({ label, parameters: params, activeParameter: 2, parameterDocumentation: ["", "", "Number of items."] }, 0);
  assert.equal(result.activeParameter, 2);
  result.parameters.forEach((p, i) => assert.equal(result.label.slice(...p.label), params[i]));
  assert.match(result.parameters[2]!.documentation.value, /Parameter 3 of 3/);
  assert.match(result.parameters[2]!.documentation.value, /Number of items/);
  assert.equal(compactSignatureLabel(label, ["mismatched"]), label);
});

test("semantic hover removes duplicate compiler preamble and preserves documentation", () => {
  const parsed = semanticHoverParts('### function `TryAddItem`\nprovided by "Inventory.h"\n\n→ `bool`\nParameters:\n- `int32 Count`\n\n---\nAdds items.\n\nMore information.\n\n```cpp\nbool TryAddItem(int32 Count)\n```');
  assert.equal(parsed.signature, "bool TryAddItem(int32 Count)");
  assert.equal(parsed.documentation, "Adds items.\n\nMore information.");
  assert.equal(semanticHoverParts("A usage example:\n\n```python\nprint(1)\n```").signature, null);
});

test("compact hover keeps one identity/signature and deduplicates escaped locations", () => {
  const markdown = formatCompactHover({ name: "Thing<T>", kind: "class", signature: "class Thing<T>", documentation: "Summary.\n\nLonger documentation.", locations: [
    { role: "Decl", path: 'Source/A"B.h', line: 8 },
    { role: "Decl", path: 'source/a"b.h', line: 8 },
  ] });
  assert.match(markdown, /Thing&lt;T&gt;<\/h4>/);
  assert.match(markdown, /<summary>More details<\/summary>/);
  assert.equal(markdown.match(/<tr>/g)?.length, 1);
  assert.match(markdown, /title="Source\/A&quot;B.h"/);
  assert.match(markdown, /<td>:8<\/td>/);
});

test("semantic signature wins while index locations remain in one hover", () => {
  const entry = { name: "Add", kind: "function" as const, path: "E:/P/Inventory.h", line: 12, params: "float Wrong", returnType: "void" };
  const markdown = formatCppHoverMarkdown("Add", [entry, entry], "E:/P", null, "### function Add\n\nAdds items.\n\n```cpp\nbool Add(int32 Count)\n```");
  assert.match(markdown!, /bool Add\(int32 Count\)/);
  assert.doesNotMatch(markdown!, /Wrong/);
  assert.equal(markdown!.match(/<h4>/g)?.length, 1);
  assert.equal(markdown!.match(/<tr>/g)?.length, 1);
});

test("single-letter semantic symbols remain hoverable when the index has no result", async () => {
  let provider: any;
  const disposable = { dispose() {} };
  registerCppLanguageFeatures({ languages: { registerDefinitionProvider: () => disposable, registerHoverProvider: (_language, p) => { provider = p; return disposable; } }, Uri: { file: p => p } }, {
    getWorkspaceRoot: () => null,
    getSemanticHover: async () => "```cpp\nint f()\n```",
  });
  const result = await provider.provideHover({ getValue: () => "f()", getWordAtPosition: () => ({ word: "f", startColumn: 1, endColumn: 2 }), getOffsetAt: () => 0, uri: { scheme: "file", path: "/x.cpp" } }, { lineNumber: 1, column: 1 });
  assert.match(result.contents[0].value, /int f\(\)/);
  assert.equal(result.contents[0].supportHtml, true);
});
