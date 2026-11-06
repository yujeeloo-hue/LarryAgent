import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  detailParagraphs,
  schemaDetails,
} from "./actionDetails.js";

describe("graph-editor actionDetails helpers", () => {
  it("schemaDetails trims and returns non-empty details", () => {
    assert.equal(schemaDetails({ details: "  a \n\n b  " }), "a \n\n b");
    assert.equal(schemaDetails({ details: "   " }), null);
    assert.equal(schemaDetails({ details: 42 }), null);
    assert.equal(schemaDetails({}), null);
    assert.equal(schemaDetails(undefined), null);
  });

  it("detailParagraphs splits on blank lines and drops empties", () => {
    assert.deepEqual(detailParagraphs("one"), ["one"]);
    assert.deepEqual(detailParagraphs("one\n\ntwo"), ["one", "two"]);
    assert.deepEqual(detailParagraphs("one\n\ntwo"), ["one", "two"]);
    assert.deepEqual(detailParagraphs("  one  \n\n\n\ntwo\n"), ["one", "two"]);
    assert.deepEqual(detailParagraphs(""), []);
    assert.deepEqual(detailParagraphs("a\nb"), ["a\nb"]);
  });
});
