import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

const VERSION = "7.0.2";
const root = resolve(import.meta.dirname);
const dest = join(root, "resources", "typescript");
const TARGETS = [
  {
    dir: "win32-x64",
    archive: `typescript-win32-x64-${VERSION}.tgz`,
    sha256: "61fc4e141d2bc687db580e71bbfa63b9c209f0310645d82ca1b457eb3a24fd19",
    binary: "tsc.exe",
  },
  {
    dir: "darwin-arm64",
    archive: `typescript-darwin-arm64-${VERSION}.tgz`,
    sha256: "902e2fe1cf0799198ef902c6b8c310a450fef629a6baba41d45641ef75c04ebd",
    binary: "tsc",
  },
];

function tarEntries(buffer) {
  const out = [];
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start, length) =>
      header.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
    const prefix = field(345, 155);
    const name = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100);
    const size = Number.parseInt(field(124, 12).trim() || "0", 8);
    const type = field(156, 1);
    const start = offset + 512;
    if (type === "0" || type === "") out.push({ name, data: buffer.subarray(start, start + size) });
    offset = start + Math.ceil(size / 512) * 512;
  }
  return out;
}

function destinationFor(name, binary) {
  if (name.includes("..")) throw new Error(`[prepare-typescript-ls] unsafe archive entry: ${name}`);
  if (name === "package/LICENSE" || name === "package/NOTICE.txt") return name.slice("package/".length);
  const match = /^package\/lib\/([^/]+)$/.exec(name);
  if (!match) return null;
  const base = match[1];
  return base === binary || /^lib(?:\..+)?\.d\.ts$/.test(base) ? base : null;
}

function ready(target) {
  try {
    const parsed = JSON.parse(readFileSync(join(dest, target.dir, "VERSION.json"), "utf8"));
    return (
      parsed.version === VERSION &&
      parsed.sha256 === target.sha256 &&
      existsSync(join(dest, target.dir, target.binary)) &&
      existsSync(join(dest, target.dir, "lib.d.ts")) &&
      existsSync(join(dest, target.dir, "LICENSE"))
    );
  } catch {
    return false;
  }
}

for (const target of TARGETS) {
  const archivePath = join(dest, target.archive);
  if (!existsSync(archivePath)) {
    console.error(`[prepare-typescript-ls] missing ${archivePath}`);
    process.exit(1);
  }
  const archive = readFileSync(archivePath);
  const actual = createHash("sha256").update(archive).digest("hex");
  if (actual !== target.sha256) {
    console.error(
      `[prepare-typescript-ls] SHA-256 mismatch for ${target.archive}: expected ${target.sha256}, got ${actual}`,
    );
    process.exit(1);
  }
  if (ready(target)) {
    console.log(`[prepare-typescript-ls] already extracted ${target.dir}`);
    continue;
  }
  const outDir = join(dest, target.dir);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  for (const entry of tarEntries(gunzipSync(archive))) {
    const base = destinationFor(entry.name, target.binary);
    if (!base) continue;
    const file = join(outDir, base);
    writeFileSync(file, entry.data);
    if (base === target.binary) chmodSync(file, 0o755);
  }
  for (const required of [target.binary, "lib.d.ts", "LICENSE"]) {
    if (!existsSync(join(outDir, required))) {
      console.error(`[prepare-typescript-ls] ${target.archive} did not produce ${required}`);
      process.exit(1);
    }
  }
  writeFileSync(
    join(outDir, "VERSION.json"),
    `${JSON.stringify({ version: VERSION, archive: target.archive, sha256: actual }, null, 2)}\n`,
  );
  console.log(`[prepare-typescript-ls] ready TypeScript ${VERSION} → ${join(outDir, target.binary)}`);
}
