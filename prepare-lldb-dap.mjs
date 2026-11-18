import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import AdmZip from "adm-zip";

const root = resolve(import.meta.dirname);
const dest = join(root, "resources", "lldb-dap");
const exeName = "lldb-dap.exe";

function zipPath() {
  if (!existsSync(dest)) return null;
  const match = readdirSync(dest).find((name) =>
    /^lldb-dap-.*-win-x64\.zip$/i.test(name),
  );
  return match ? join(dest, match) : null;
}

function extractedVersion() {
  try {
    const parsed = JSON.parse(readFileSync(join(dest, "VERSION.json"), "utf8"));
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

const zip = zipPath();
if (!zip) {
  console.error(
    `[prepare-lldb-dap] missing zip under ${dest} (expected lldb-dap-*-win-x64.zip)`,
  );
  process.exit(1);
}

const exe = join(dest, "bin", exeName);
const crt = join(dest, "bin", "vcruntime140.dll");
const archive = new AdmZip(zip);
const { version } = JSON.parse(archive.readAsText("VERSION.json"));
if (typeof version !== "string" || !version) throw new Error(`Missing debugger version in ${zip}`);
if (existsSync(exe) && existsSync(crt) && extractedVersion() === version) {
  console.log(`[prepare-lldb-dap] already extracted ${version} → ${exe}`);
  process.exit(0);
}

console.log(`[prepare-lldb-dap] extract ${zip}`);
mkdirSync(dest, { recursive: true });
for (const name of ["bin", "lib"]) {
  rmSync(join(dest, name), { recursive: true, force: true });
}
archive.extractAllTo(dest, true);
if (!existsSync(exe)) {
  console.error(`[prepare-lldb-dap] extract did not produce ${exe}`);
  process.exit(1);
}
console.log(`[prepare-lldb-dap] ready ${exe}`);
