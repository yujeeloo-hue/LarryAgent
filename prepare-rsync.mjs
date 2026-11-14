/**
 * Unpack the committed cwRsync zip into resources/rsync/{bin,etc}.
 * electron-builder copies that folder as Windows-only extraResources.
 *
 * Run via: node prepare-rsync.mjs
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import AdmZip from "adm-zip";

const VERSION = "6.5.0";
const ARCHIVE = "cwrsync_6.5.0_x64_free.zip";
const EXPECTED_SHA256 = "8dc20afec889908c05c2abaa21d37f3fcad3e7ea5f3f37e95b25e6178f6b983a";
const root = resolve(import.meta.dirname);
const dest = join(root, "resources", "rsync");
const zipPath = join(dest, ARCHIVE);
const exe = join(dest, "bin", "rsync.exe");
const versionFile = join(dest, "VERSION.json");

if (!existsSync(zipPath)) {
  console.error(`[prepare-rsync] missing ${zipPath}`);
  process.exit(1);
}
const actual = createHash("sha256").update(readFileSync(zipPath)).digest("hex");
if (actual !== EXPECTED_SHA256) {
  console.error(`[prepare-rsync] SHA-256 mismatch: expected ${EXPECTED_SHA256}, got ${actual}`);
  process.exit(1);
}

function extractedVersion() {
  try {
    const parsed = JSON.parse(readFileSync(versionFile, "utf8"));
    return parsed.version === VERSION;
  } catch {
    return false;
  }
}

if (extractedVersion() && existsSync(exe) && existsSync(join(dest, "bin", "cygwin1.dll"))) {
  console.log(`[prepare-rsync] already extracted cwRsync ${VERSION}`);
  process.exit(0);
}

for (const name of ["bin", "etc"]) rmSync(join(dest, name), { recursive: true, force: true });
rmSync(join(dest, "README.rsync.txt"), { force: true });
const zip = new AdmZip(zipPath);
for (const entry of zip.getEntries()) {
  if (entry.isDirectory) continue;
  const name = entry.entryName;
  if (!(name.startsWith("bin/") || name.startsWith("etc/") || name === "README.rsync.txt")) continue;
  if (name.includes("..")) throw new Error(`[prepare-rsync] unsafe archive entry: ${name}`);
  const target = join(dest, name);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, entry.getData());
}
if (!existsSync(exe)) {
  console.error("[prepare-rsync] archive did not produce bin/rsync.exe");
  process.exit(1);
}
writeFileSync(versionFile, `${JSON.stringify({ version: VERSION, archive: ARCHIVE, sha256: actual }, null, 2)}\n`);
console.log(`[prepare-rsync] ready cwRsync ${VERSION} → ${exe}`);
