/** Validate a user-selected or bundled lldb-dap executable. */
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, dirname, join } from "node:path";

export const LARRY_LLDB_CAPABILITY = "pdbModuleAllowlist";
export const LARRY_LLDB_VERSION = "23.1.1-larry.2";

export type AdapterVersionFile = {
  version: string;
  capabilities: string[];
  llvmRevision?: string;
};

export type DebugAdapterKind = "lldb-dap";
export type DebugAdapterSource = "configured" | "bundled";

export type DebugAdapterProbe =
  | {
      ok: true;
      kind: DebugAdapterKind;
      path: string;
      source: DebugAdapterSource;
      version?: string;
      capabilities?: string[];
    }
  | { ok: false; message: string; searched: string[] };

export type ProbeDebugAdapterOpts = {
  /** User-selected executable persisted in app settings. */
  configuredPath?: string | null;
  /** Packaged / extracted Larry lldb-dap (Windows extraResources). */
  bundledPath?: string | null;
  pathExists?: (p: string) => boolean;
  readVersion?: (adapterPath: string) => AdapterVersionFile | null;
};

const SELECT_HINT =
  `Larry lldb-dap ${LARRY_LLDB_VERSION} with ${LARRY_LLDB_CAPABILITY} is required. ` +
  "Select the compatible lldb-dap executable.";

function exists(path: string, fn: (p: string) => boolean): boolean {
  try {
    return fn(path);
  } catch {
    return false;
  }
}

export function readAdapterVersion(adapterPath: string): AdapterVersionFile | null {
  try {
    const parent = dirname(adapterPath);
    const root = basename(parent).toLowerCase() === "bin" ? dirname(parent) : parent;
    const parsed = JSON.parse(
      readFileSync(join(root, "VERSION.json"), "utf8"),
    ) as Partial<AdapterVersionFile>;
    if (
      typeof parsed.version !== "string" ||
      !Array.isArray(parsed.capabilities) ||
      !parsed.capabilities.every((value) => typeof value === "string")
    ) {
      return null;
    }
    return {
      version: parsed.version,
      capabilities: parsed.capabilities,
      ...(typeof parsed.llvmRevision === "string"
        ? { llvmRevision: parsed.llvmRevision }
        : {}),
    };
  } catch {
    /* Fall through to the executable's version output. */
  }
  try {
    const output = execFileSync(adapterPath, ["--version"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5_000,
    });
    if (
      !output.includes(LARRY_LLDB_VERSION) ||
      !output.includes(LARRY_LLDB_CAPABILITY)
    ) {
      return null;
    }
    return {
      version: LARRY_LLDB_VERSION,
      capabilities: [LARRY_LLDB_CAPABILITY],
    };
  } catch {
    return null;
  }
}

function compatible(
  version: AdapterVersionFile | null,
): version is AdapterVersionFile {
  return (
    version?.version === LARRY_LLDB_VERSION &&
    version.capabilities.includes(LARRY_LLDB_CAPABILITY)
  );
}

function probePath(
  path: string,
  source: DebugAdapterSource,
  pathExists: (p: string) => boolean,
  readVersion: (adapterPath: string) => AdapterVersionFile | null,
): Extract<DebugAdapterProbe, { ok: true }> | null {
  if (!exists(path, pathExists)) return null;
  const version = readVersion(path);
  if (!compatible(version)) return null;
  return {
    ok: true,
    kind: "lldb-dap",
    path,
    source,
    version: version.version,
    capabilities: version.capabilities,
  };
}

export function probeDebugAdapter(opts?: ProbeDebugAdapterOpts): DebugAdapterProbe {
  const pathExists = opts?.pathExists ?? ((p: string) => existsSync(p));
  const readVersion = opts?.readVersion ?? readAdapterVersion;
  const configured = opts?.configuredPath?.trim() || "";
  const bundled = opts?.bundledPath?.trim() || "";
  const searched: string[] = [];

  if (configured) {
    searched.push(configured);
    const hit = probePath(configured, "configured", pathExists, readVersion);
    if (hit) return hit;
  }
  if (bundled) {
    searched.push(bundled);
    const hit = probePath(bundled, "bundled", pathExists, readVersion);
    if (hit) return hit;
  }

  return {
    ok: false,
    message: bundled
      ? `Bundled lldb-dap is missing or incompatible. ${SELECT_HINT}`
      : SELECT_HINT,
    searched,
  };
}
