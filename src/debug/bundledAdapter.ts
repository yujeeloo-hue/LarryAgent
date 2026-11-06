/**
 * Windows Larry lldb-dap shipped beside the app (extraResources / repo).
 * The zip is the source of truth; bin/ is extracted at dist:win and, if
 * missing, on first debug start in unpackaged Windows builds.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { LARRY_LLDB_VERSION } from "./adapterProbe.js";

export const BUNDLED_LLDB_DIR = "lldb-dap";

export function bundledLldbDapPath(resourcesRoot: string): string {
  const name = process.platform === "win32" ? "lldb-dap.exe" : "lldb-dap";
  return join(resourcesRoot, BUNDLED_LLDB_DIR, "bin", name);
}

export function findBundledLldbDapZip(resourcesRoot: string): string | null {
  const dir = join(resourcesRoot, BUNDLED_LLDB_DIR);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const match = names.find((name) =>
    /^lldb-dap-.*-win-x64\.zip$/i.test(name),
  );
  return match ? join(dir, match) : null;
}

function extractedVersion(resourcesRoot: string): string | null {
  try {
    const parsed = JSON.parse(
      readFileSync(
        join(resourcesRoot, BUNDLED_LLDB_DIR, "VERSION.json"),
        "utf8",
      ),
    ) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

/** Unpack the committed zip when bin/ is missing or stale. */
export function extractBundledLldbDap(resourcesRoot: string): string | null {
  const zipPath = findBundledLldbDapZip(resourcesRoot);
  if (!zipPath) return null;
  const dest = join(resourcesRoot, BUNDLED_LLDB_DIR);
  mkdirSync(dest, { recursive: true });
  for (const name of ["bin", "lib"]) {
    rmSync(join(dest, name), { recursive: true, force: true });
  }
  const zip = new AdmZip(zipPath);
  zip.extractAllTo(dest, true);
  return bundledLldbDapPath(resourcesRoot);
}

/**
 * Return the bundled executable if it is already extracted, or extract the
 * zip first. Missing zip / failed extract → null (caller may prompt).
 */
export function ensureBundledLldbDap(resourcesRoot: string): string | null {
  const exe = bundledLldbDapPath(resourcesRoot);
  if (
    existsSync(exe) &&
    extractedVersion(resourcesRoot) === LARRY_LLDB_VERSION
  ) {
    return exe;
  }
  const extracted = extractBundledLldbDap(resourcesRoot);
  return extracted && existsSync(extracted) ? extracted : null;
}
