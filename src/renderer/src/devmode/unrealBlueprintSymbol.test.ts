import assert from "node:assert/strict";
import { test } from "node:test";
import { blueprintSymbolFromHover } from "./unrealBlueprintSymbol.js";

test("a clangd class hover becomes a class query", () => {
  const markdown = "### class `ANFCharacter`\n\nProvided by `NFCharacter.h`\n\n---\n```cpp\nclass ANFCharacter : public ACharacter {}\n```";
  assert.deepEqual(blueprintSymbolFromHover(markdown), { kind: "class", className: "ANFCharacter" });
});

test("a method hover uses the enclosing class from the In line", () => {
  const markdown = "### instance-method `Jump`\n\n---\n→ `void`\n\n---\n```cpp\n// In ANFCharacter\npublic: virtual void Jump() override\n```";
  assert.deepEqual(blueprintSymbolFromHover(markdown), {
    kind: "function",
    className: "ANFCharacter",
    name: "Jump",
  });
  const nested = "### static-method `Make`\n\n```cpp\n// In NF::UNFLibrary\nstatic void Make()\n```";
  assert.deepEqual(blueprintSymbolFromHover(nested), { kind: "function", className: "UNFLibrary", name: "Make" });
});

test("a constructor hover queries its class", () => {
  const markdown = "### constructor `ANFCharacter`\n\n```cpp\n// In ANFCharacter\npublic: ANFCharacter()\n```";
  assert.deepEqual(blueprintSymbolFromHover(markdown), { kind: "class", className: "ANFCharacter" });
});

test("hovers Blueprints cannot reference are skipped", () => {
  assert.equal(blueprintSymbolFromHover(null), null);
  assert.equal(blueprintSymbolFromHover("### field `Health`\n\n```cpp\n// In ANFCharacter\nint Health\n```"), null);
  assert.equal(blueprintSymbolFromHover("### function `FreeHelper`\n\n```cpp\n// In namespace NF\nvoid FreeHelper()\n```"), null);
  assert.equal(blueprintSymbolFromHover("### instance-method `Jump`\n\n```cpp\nvoid Jump()\n```"), null);
});
