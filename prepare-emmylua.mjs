import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import AdmZip from "adm-zip";

const VERSION = "0.25.1";
const root = resolve(import.meta.dirname);
const dest = join(root, "resources", "emmylua");
const TARGETS = [
  {
    dir: "win32-x64",
    archive: "emmylua_ls-win32-x64.zip",
    sha256: "82efa133287f67be09e1a624d8efecd8063832ec2b9bf9279c37afc5f42118bd",
    binary: "emmylua_ls.exe",
  },
  {
    dir: "darwin-arm64",
    archive: "emmylua_ls-darwin-arm64.tar.gz",
    sha256: "335023043cbc9ad683a13b24eb79f709a370215daf53673276b9a9663df96504",
    binary: "emmylua_ls",
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
    return (
      parsed.version === VERSION &&
      existsSync(join(dest, target.dir, target.binary)) &&
      existsSync(join(dest, target.dir, "LICENSE"))
    );
  } catch {
    return false;
  }
}

const license = join(dest, "LICENSE");
if (!existsSync(license)) {
  console.error(`[prepare-emmylua] missing ${license}`);
  process.exit(1);
}

for (const target of TARGETS) {
  const archivePath = join(dest, target.archive);
  if (!existsSync(archivePath)) {
    console.error(`[prepare-emmylua] missing ${archivePath}`);
    process.exit(1);
  }
  const actual = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
  if (actual !== target.sha256) {
    console.error(`[prepare-emmylua] SHA-256 mismatch for ${target.archive}: expected ${target.sha256}, got ${actual}`);
    process.exit(1);
  }
  if (ready(target)) {
    console.log(`[prepare-emmylua] already extracted ${target.dir}`);
    continue;
  }
  const outDir = join(dest, target.dir);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  for (const entry of archiveEntries(archivePath)) {
    if (entry.name.includes("..")) throw new Error(`[prepare-emmylua] unsafe archive entry: ${entry.name}`);
    const base = entry.name.split("/").pop();
    if (base !== target.binary) continue;
    const file = join(outDir, base);
    writeFileSync(file, entry.data);
    chmodSync(file, 0o755);
  }
  if (!existsSync(join(outDir, target.binary))) {
    console.error(`[prepare-emmylua] ${target.archive} did not produce ${target.binary}`);
    process.exit(1);
  }
  copyFileSync(license, join(outDir, "LICENSE"));
  writeFileSync(
    join(outDir, "VERSION.json"),
    `${JSON.stringify({ version: VERSION, archive: target.archive, sha256: actual }, null, 2)}\n`,
  );
  console.log(`[prepare-emmylua] ready emmylua_ls ${VERSION} → ${join(outDir, target.binary)}`);
}
