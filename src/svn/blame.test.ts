/** Pure-parser tests for `svn blame --xml` output (no svn binary needed). */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decodeXmlEntities,
  parseSvnBlameXml,
  parseSvnLogMessages,
} from "./blame.js";

// Real svn 1.14 output shape: attributes on their own lines, `path` with
// backslashes on Windows, multi-byte author names, locally-modified line
// carrying no <commit> child.
const FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<blame>
<target
   path="Source\\NF\\NF.cpp">
<entry
   line-number="1">
<commit
   revision="3">
<author>hawkpan</author>
<date>2024-08-12T07:40:39.417593Z</date>
</commit>
</entry>
<entry
   line-number="2">
</entry>
</target>
</blame>`;

describe("parseSvnBlameXml", () => {
  it("maps entries to line/rev/author/time", () => {
    const out = parseSvnBlameXml(FIXTURE);
    assert.equal(out.length, 2);
    assert.deepEqual(
      out.map((e) => [e.line, e.rev, e.author]),
      [
        [1, "3", "hawkpan"],
        [2, "M", ""],
      ],
    );
    assert.equal(out[0]!.time, Math.floor(Date.parse("2024-08-12T07:40:39.417593Z") / 1000));
    assert.equal(out[0]!.summary, null);
  });

  it("maps locally-modified lines (no commit element) to rev M", () => {
    const out = parseSvnBlameXml(FIXTURE);
    assert.equal(out[1]!.rev, "M");
    assert.equal(out[1]!.time, null);
  });

  it("also accepts compact single-line output from other svn builds", () => {
    const out = parseSvnBlameXml(
      '<blame><entry line-number="7"><commit revision="4">' +
        "<author>sally</author><date>2020-01-02T03:04:05.000000Z</date>" +
        "</commit></entry></blame>",
    );
    assert.equal(out.length, 1);
    assert.deepEqual(
      out.map((e) => [e.line, e.rev, e.author]),
      [[7, "4", "sally"]],
    );
  });

  it("returns empty when there are no entries", () => {
    assert.deepEqual(parseSvnBlameXml('<blame><target path="x"/></blame>'), []);
    assert.deepEqual(parseSvnBlameXml(""), []);
  });
});

describe("parseSvnLogMessages", () => {
  it("maps revision → message with entities decoded", () => {
    const out = [
      '<logentry revision="9"><author>harry</author>',
      "<date>2021-06-07T08:09:10.000000Z</date>",
      "<msg>Fix &amp; thing</msg></logentry>",
      '<logentry revision="12"><author>sally</author>',
      "<msg>Multi\nline body</msg></logentry>",
    ].join("");
    const map = parseSvnLogMessages(out);
    assert.equal(map.get("9"), "Fix & thing");
    assert.equal(map.get("12"), "Multi\nline body");
  });

  it("skips empty messages", () => {
    const map = parseSvnLogMessages(
      '<logentry revision="3"><author>a</author><msg></msg></logentry>',
    );
    assert.equal(map.size, 0);
  });
});

describe("decodeXmlEntities", () => {
  it("decodes the standard set plus numeric refs", () => {
    assert.equal(
      decodeXmlEntities("&lt;a&gt; &amp; &quot;b&quot; &apos;c&apos; &#65;"),
      `<a> & "b" 'c' A`,
    );
  });
});
