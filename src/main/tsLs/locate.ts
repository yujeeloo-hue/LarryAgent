import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import type { LuaServerBundle } from "../luaLs/locate.js";

export type TypeScriptServerBundle = LuaServerBundle;

function pathExists(path: string): boolean {
  try {
    accessSync(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function defaultBundle(): TypeScriptServerBundle {
  return { packaged: false, devRoots: [process.cwd()] };
}

export function typescriptServerCandidates(
  bundle: TypeScriptServerBundle = defaultBundle(),
  platform: NodeJS.Platform = process.platform,
): string[] {
  const binary = platform === "win32" ? "tsc.exe" : "tsc";
  if (bundle.packaged) {
    return bundle.resourcesPath ? [join(bundle.resourcesPath, "typescript", binary)] : [];
  }
  const arch = bundle.arch ?? process.arch;
  const candidates = (bundle.devRoots ?? []).map((root) =>
    join(root, "resources", "typescript", `${platform}-${arch}`, binary),
  );
  return [...new Set(candidates)];
}

export function findTypeScriptServer(
  bundle: TypeScriptServerBundle = defaultBundle(),
  exists: (path: string) => boolean = pathExists,
  platform: NodeJS.Platform = process.platform,
): string | null {
  return typescriptServerCandidates(bundle, platform).find((candidate) => exists(candidate)) ?? null;
}

const TS_DOCUMENT_LANGUAGES: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescriptreact",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascriptreact",
};

export function typescriptDocumentLanguage(path: string): string | null {
  const ext = /\.([^./\\]+)$/.exec(path)?.[1]?.toLowerCase() ?? "";
  return TS_DOCUMENT_LANGUAGES[ext] ?? null;
}
