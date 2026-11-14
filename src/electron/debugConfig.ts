/**
 * Optional `.larry/debug.json` overrides for Electron launch.
 */
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { ElectronRecipe } from "./manifest.js";

export const DEBUG_CONFIG_FILE_REL = ".larry/debug.json";

const ALLOWED_ELECTRON_KEYS = new Set([
  "recipe",
  "runtimeExecutable",
  "runtimeArgs",
  "webRoot",
  "outFiles",
  "stopOnEntry",
]);

export type ElectronDebugOverride = {
  recipe?: ElectronRecipe;
  runtimeExecutable?: string;
  runtimeArgs?: string[];
  webRoot?: string;
  outFiles?: string[];
  stopOnEntry?: boolean;
};

export type ElectronDebugConfigResult =
  | { ok: true; electron: ElectronDebugOverride | null }
  | { ok: false; message: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function resolveMaybe(base: string, value: string): string {
  const trimmed = value.trim();
  return isAbsolute(trimmed) ? trimmed : resolve(base, trimmed);
}

export function parseElectronDebugConfig(
  raw: unknown,
  workspacePath: string,
): ElectronDebugConfigResult {
  if (!isPlainObject(raw)) {
    return { ok: false, message: `${DEBUG_CONFIG_FILE_REL} must contain an object` };
  }
  if (raw.version !== undefined && raw.version !== 1) {
    return {
      ok: false,
      message: `Unsupported version ${String(raw.version)} — expected 1`,
    };
  }
  if (raw.electron === undefined) return { ok: true, electron: null };
  if (!isPlainObject(raw.electron)) {
    return { ok: false, message: `"electron" must be an object` };
  }
  for (const key of Object.keys(raw.electron)) {
    if (!ALLOWED_ELECTRON_KEYS.has(key)) {
      return {
        ok: false,
        message: `Unknown electron key "${key}" — allowed: ${[...ALLOWED_ELECTRON_KEYS].join(", ")}`,
      };
    }
  }
  const src = raw.electron;
  const out: ElectronDebugOverride = {};
  if (src.recipe !== undefined) {
    if (src.recipe !== "electron-vite" && src.recipe !== "electron") {
      return {
        ok: false,
        message: `"electron.recipe" must be "electron-vite" or "electron"`,
      };
    }
    out.recipe = src.recipe;
  }
  if (src.runtimeExecutable !== undefined) {
    if (typeof src.runtimeExecutable !== "string" || !src.runtimeExecutable.trim()) {
      return { ok: false, message: `"electron.runtimeExecutable" must be a non-empty string` };
    }
    out.runtimeExecutable = resolveMaybe(workspacePath, src.runtimeExecutable);
  }
  if (src.runtimeArgs !== undefined) {
    if (
      !Array.isArray(src.runtimeArgs) ||
      src.runtimeArgs.some((item) => typeof item !== "string")
    ) {
      return { ok: false, message: `"electron.runtimeArgs" must be an array of strings` };
    }
    out.runtimeArgs = src.runtimeArgs;
  }
  if (src.webRoot !== undefined) {
    if (typeof src.webRoot !== "string" || !src.webRoot.trim()) {
      return { ok: false, message: `"electron.webRoot" must be a non-empty string` };
    }
    out.webRoot = resolveMaybe(workspacePath, src.webRoot);
  }
  if (src.outFiles !== undefined) {
    if (
      !Array.isArray(src.outFiles) ||
      src.outFiles.some((item) => typeof item !== "string" || !item.trim())
    ) {
      return { ok: false, message: `"electron.outFiles" must be an array of non-empty strings` };
    }
    out.outFiles = src.outFiles.map((item) => resolveMaybe(workspacePath, item));
  }
  if (src.stopOnEntry !== undefined) {
    if (typeof src.stopOnEntry !== "boolean") {
      return { ok: false, message: `"electron.stopOnEntry" must be a boolean` };
    }
    out.stopOnEntry = src.stopOnEntry;
  }
  return { ok: true, electron: out };
}

export async function readElectronDebugConfig(
  workspacePath: string,
): Promise<ElectronDebugConfigResult> {
  let text: string;
  try {
    text = await readFile(join(workspacePath, DEBUG_CONFIG_FILE_REL), "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { ok: true, electron: null };
    return {
      ok: false,
      message: `Could not read ${DEBUG_CONFIG_FILE_REL} — ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      message: `${DEBUG_CONFIG_FILE_REL} is not valid JSON — ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  return parseElectronDebugConfig(parsed, workspacePath);
}
