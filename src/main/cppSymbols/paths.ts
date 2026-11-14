import { resolve } from "node:path";
import { join } from "node:path";
import { CPP_SYMBOL_DB_FILENAME } from "./types.js";

/** Absolute path with forward slashes, matching the editor's path keys. */
export function normalizeSymbolPath(path: string): string {
  return resolve(path).replace(/\\/g, "/");
}

export function cppSymbolDatabasePath(workspacePath: string): string {
  return join(resolve(workspacePath), ".jellybot", CPP_SYMBOL_DB_FILENAME);
}
