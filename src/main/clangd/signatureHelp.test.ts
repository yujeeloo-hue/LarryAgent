import assert from "node:assert/strict";
import test from "node:test";
import { parseSignatureHelp } from "./signatureHelp.js";

test("signature help preserves LSP parameter and function documentation through offsets", () => {
  const label = "bool Add(int32 Count, bool bNotify = true)";
  const result = parseSignatureHelp({ activeSignature: 1, activeParameter: 1, signatures: [
    { label, documentation: { kind: "markdown", value: "Adds items." }, parameters: [
      { label: [9, 20], documentation: { kind: "markdown", value: "Must be **positive**." } },
      { label: "bool bNotify = true", documentation: { kind: "plaintext", value: "Use <true> to notify." } },
    ] },
    { label: "void Reset()", parameters: [] },
  ] });
  assert.equal(result.activeSignature, 1);
  assert.deepEqual(result.signatures[0], { label, documentation: "Adds items.", activeParameter: 1, parameters: ["int32 Count", "bool bNotify = true"], parameterDocumentation: ["Must be **positive**.", "Use \\<true\\> to notify."] });
  assert.equal(result.signatures[1]!.activeParameter, 0);
});

test("malformed signature labels, offsets and active indices are bounded safely", () => {
  assert.deepEqual(parseSignatureHelp(null), { ok: true, signatures: [], activeSignature: 0 });
  const result = parseSignatureHelp({ activeSignature: -1, activeParameter: 99, signatures: [null, { label: 1 }, { label: "void F(int)", parameters: [{ label: [-1, 30] }, null] }] });
  assert.equal(result.signatures.length, 1);
  assert.equal(result.activeSignature, 0);
  assert.equal(result.signatures[0]!.activeParameter, 1);
  assert.deepEqual(result.signatures[0]!.parameters, ["", ""]);
  assert.equal(result.signatures[0]!.parameterDocumentation, undefined);
});
