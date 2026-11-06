/**
 * Skill Hub zip layer — inbound package validation, frontmatter parsing and
 * interop with the zip adm-zip produces on the device side.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import AdmZip from "adm-zip";
import {
  buildSkillPackage,
  normalizeSkillPackage,
  SKILL_HUB_LIMITS,
} from "../src/skillHubStore.ts";

function zipOf(files: Record<string, string | Buffer>): string {
  const zip = new AdmZip();
  for (const [path, content] of Object.entries(files)) {
    zip.addFile(path, Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8"));
  }
  return zip.toBuffer().toString("base64");
}

/**
 * Hand-built STORED zip so entry names stay exactly as written — adm-zip
 * normalizes traversal segments before we get a chance to reject them.
 */
function rawZip(entries: Array<[string, string]>): string {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const data = Buffer.from(content, "utf8");
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30 + nameBuf.length + data.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(local, 30);
    data.copy(local, 30 + nameBuf.length);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);

    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]).toString("base64");
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const SKILL_MD = "---\nname: alpha\ndescription: Alpha skill.\n---\n\nDo the alpha thing.\n";

describe("skill hub package validation", () => {
  it("accepts a device-style package and reports files with sizes", () => {
    const binary = randomBytes(256);
    const pkg = normalizeSkillPackage(zipOf({
      "SKILL.md": SKILL_MD,
      "notes/readme.md": "hello",
      "assets/blob.bin": binary,
    }));
    assert.equal(pkg.description, "Alpha skill.");
    assert.equal(pkg.body, "Do the alpha thing.");
    assert.deepEqual(
      pkg.files.map((file) => file.path).sort(),
      ["assets/blob.bin", "notes/readme.md"],
    );
    assert.equal(pkg.files.find((f) => f.path === "assets/blob.bin")?.size, binary.byteLength);
  });

  it("round-trips buildSkillPackage through normalization", () => {
    const zip = buildSkillPackage("beta", "Beta skill.", "Beta body.\n\nMore.");
    const pkg = normalizeSkillPackage(zip.toString("base64"));
    assert.equal(pkg.description, "Beta skill.");
    assert.equal(pkg.body, "Beta body.\n\nMore.");
    assert.deepEqual(pkg.files, []);
  });

  it("rejects empty, oversized and malformed packages", () => {
    assert.throws(() => normalizeSkillPackage(""), /required/i);
    assert.throws(() => normalizeSkillPackage("!!!"), /empty/i);
    assert.throws(
      () => normalizeSkillPackage(Buffer.alloc(SKILL_HUB_LIMITS.zipBytes + 1, 7).toString("base64")),
      /too large/i,
    );
    assert.throws(() => normalizeSkillPackage(Buffer.from("not a zip").toString("base64")), /valid zip/i);
  });

  it("rejects zip-slip entries and absolute paths", () => {
    assert.throws(
      () => normalizeSkillPackage(rawZip([["SKILL.md", SKILL_MD], ["../escape.md", "x"]])),
      /inside the skill directory/i,
    );
    assert.throws(
      () => normalizeSkillPackage(rawZip([["SKILL.md", SKILL_MD], ["/etc/passwd", "x"]])),
      /relative paths/i,
    );
  });

  it("requires exactly one root SKILL.md with a description", () => {
    assert.throws(() => normalizeSkillPackage(zipOf({ "notes.md": "x" })), /SKILL\.md at its root/i);
    assert.throws(
      () => normalizeSkillPackage(zipOf({ "nested/SKILL.md": SKILL_MD })),
      /SKILL\.md at its root/i,
    );
    assert.throws(
      () => normalizeSkillPackage(zipOf({ "SKILL.md": "no frontmatter" })),
      /missing a description/i,
    );
  });
});
