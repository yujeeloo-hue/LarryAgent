/** Validate a user-selected or bundled lldb-dap executable. */
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, dirname, join } from "node:path";

export const LARRY_LLDB_CAPABILITY = "pdbModuleAllowlist";
export const LARRY_LLDB_VERSION = "23.1.1-larry.5";

export type AdapterVersionFile = {
  version: string;
  capabilities: string[];
  llvmRevision?: string;
};

export type DebugAdapterKind = "lldb-dap";
export type DebugAdapterSource = "configured" | "bundled" | "system";

export type DebugAdapterProbe =
  | {
      ok: true;
      kind: DebugAdapterKind;
      path: string;
      source: DebugAdapterSource;
      version?: string;
      capabilities?: string[];
      /** Stock lldb-dap (Xcode / LLVM). It has no PDB allowlist. */
      stock?: boolean;
    }
  | { ok: false; message: string; searched: string[] };

export type ProbeDebugAdapterOpts = {
  /** User-selected executable persisted in app settings. */
  configuredPath?: string | null;
  /** Packaged / extracted Larry lldb-dap (Windows extraResources). */
  bundledPath?: string | null;
  /**
   * Accept a stock lldb-dap when the Larry build is absent. macOS uses the
   * Xcode adapter; Windows Unreal debugging still requires `pdbModuleAllowlist`.
   */
  allowStock?: boolean;
  /** Extra stock executables tried after a configured path, in order. */
  stockCandidates?: string[];
  pathExists?: (p: string) => boolean;
  readVersion?: (adapterPath: string) => AdapterVersionFile | null;
  readStock?: (adapterPath: string) => boolean;
};

/** Xcode and `/usr/bin` lldb-dap. `DEVELOPER_DIR` wins when xcode-select points elsewhere. */
export function darwinLldbDapCandidates(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const fromDev = env.DEVELOPER_DIR
    ? join(env.DEVELOPER_DIR, "usr", "bin", "lldb-dap")
    : "";
  return [...new Set(
    [
      fromDev,
      "/Applications/Xcode.app/Contents/Developer/usr/bin/lldb-dap",
      "/usr/bin/lldb-dap",
    ].filter((path) => path.length > 0),
  )];
}

/** True when `lldb-dap --version` identifies an LLDB adapter (any vendor build). */
export function isStockLldbDap(adapterPath: string): boolean {
  try {
    const output = execFileSync(adapterPath, ["--version"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5_000,
    });
    return /lldb-dap/i.test(output) && /llvm|lldb/i.test(output);
  } catch {
    return false;
  }
}

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

  if (opts?.allowStock) {
    const readStock = opts.readStock ?? isStockLldbDap;
    const seen = new Set<string>();
    for (const path of [configured, ...(opts.stockCandidates ?? [])]) {
      if (!path || seen.has(path)) continue;
      seen.add(path);
      if (!searched.includes(path)) searched.push(path);
      if (!exists(path, pathExists) || !readStock(path)) continue;
      return {
        ok: true,
        kind: "lldb-dap",
        path,
        source: path === configured ? "configured" : "system",
        stock: true,
      };
    }
  }

  return {
    ok: false,
    message: opts?.allowStock
      ? "lldb-dap was not found. Install Xcode, or select an lldb-dap executable."
      : bundled
        ? `Bundled lldb-dap is missing or incompatible. ${SELECT_HINT}`
        : SELECT_HINT,
    searched,
  };
}
