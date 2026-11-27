import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import AdmZip from "adm-zip";

const VERSION = "14.1.1";
const root = resolve(import.meta.dirname);
const dest = join(root, "resources", "ripgrep");
const TARGETS = [
  {
    dir: "win32-x64",
    archive: `ripgrep-${VERSION}-x86_64-pc-windows-msvc.zip`,
    sha256: "d0f534024c42afd6cb4d38907c25cd2b249b79bbe6cc1dbee8e3e37c2b6e25a1",
    binary: "rg.exe",
  },
  {
    dir: "darwin-arm64",
    archive: `ripgrep-${VERSION}-aarch64-apple-darwin.tar.gz`,
    sha256: "24ad76777745fbff131c8fbc466742b011f925bfa4fffa2ded6def23b5b937be",
    binary: "rg",
  },
];
const WANTED = new Set(["rg", "rg.exe", "LICENSE-MIT"]);

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

function archiveEntries(path) {
  if (path.endsWith(".zip")) {
    return new AdmZip(path)
      .getEntries()
      .filter((entry) => !entry.isDirectory)
      .map((entry) => ({ name: entry.entryName, data: entry.getData() }));
  }
  return tarEntries(gunzipSync(readFileSync(path)));
}

function ready(target) {
  try {
    const parsed = JSON.parse(readFileSync(join(dest, target.dir, "VERSION.json"), "utf8"));
    return parsed.version === VERSION && existsSync(join(dest, target.dir, target.binary));
  } catch {
    return false;
  }
}

for (const target of TARGETS) {
  const archivePath = join(dest, target.archive);
  if (!existsSync(archivePath)) {
    console.error(`[prepare-ripgrep] missing ${archivePath}`);
    process.exit(1);
  }
  const actual = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
  if (actual !== target.sha256) {
    console.error(`[prepare-ripgrep] SHA-256 mismatch for ${target.archive}: expected ${target.sha256}, got ${actual}`);
    process.exit(1);
  }
  if (ready(target)) {
    console.log(`[prepare-ripgrep] already extracted ${target.dir}`);
    continue;
  }
  const outDir = join(dest, target.dir);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  for (const entry of archiveEntries(archivePath)) {
    if (entry.name.includes("..")) throw new Error(`[prepare-ripgrep] unsafe archive entry: ${entry.name}`);
    const base = entry.name.split("/").pop();
    if (!base || !WANTED.has(base)) continue;
    const file = join(outDir, base);
    writeFileSync(file, entry.data);
    if (base === target.binary) chmodSync(file, 0o755);
  }
  if (!existsSync(join(outDir, target.binary))) {
    console.error(`[prepare-ripgrep] ${target.archive} did not produce ${target.binary}`);
    process.exit(1);
  }
  writeFileSync(
    join(outDir, "VERSION.json"),
    `${JSON.stringify({ version: VERSION, archive: target.archive, sha256: actual }, null, 2)}\n`,
  );
  console.log(`[prepare-ripgrep] ready ripgrep ${VERSION} → ${join(outDir, target.binary)}`);
}
