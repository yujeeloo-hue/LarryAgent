/**
 * Optional `.larry/debug.json` `web` overrides for Node + Chrome launch.
 */
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { DEBUG_CONFIG_FILE_REL } from "../electron/debugConfig.js";

const ALLOWED_WEB_KEYS = new Set([
  "server",
  "script",
  "url",
  "webRoot",
  "stopOnEntry",
  "chromeExecutable",
  "runtimeExecutable",
  "runtimeArgs",
]);

export type WebDebugOverride = {
  server?: string;
  script?: string;
  url?: string;
  webRoot?: string;
  stopOnEntry?: boolean;
  chromeExecutable?: string;
  runtimeExecutable?: string;
  runtimeArgs?: string[];
};

export type WebDebugConfigResult =
  | { ok: true; web: WebDebugOverride | null }
  | { ok: false; message: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function resolveMaybe(base: string, value: string): string {
  const trimmed = value.trim();
  return isAbsolute(trimmed) ? trimmed : resolve(base, trimmed);
}

export function parseWebDebugConfig(
  raw: unknown,
  workspacePath: string,
): WebDebugConfigResult {
  if (!isPlainObject(raw)) {
    return { ok: false, message: `${DEBUG_CONFIG_FILE_REL} must contain an object` };
  }
  if (raw.version !== undefined && raw.version !== 1) {
    return {
      ok: false,
      message: `Unsupported version ${String(raw.version)} — expected 1`,
    };
  }
  if (raw.web === undefined) return { ok: true, web: null };
  if (!isPlainObject(raw.web)) {
    return { ok: false, message: `"web" must be an object` };
  }
  for (const key of Object.keys(raw.web)) {
    if (!ALLOWED_WEB_KEYS.has(key)) {
      return {
        ok: false,
        message: `Unknown web key "${key}" — allowed: ${[...ALLOWED_WEB_KEYS].join(", ")}`,
      };
    }
  }
  const src = raw.web;
  const out: WebDebugOverride = {};
  if (src.server !== undefined) {
    if (typeof src.server !== "string" || !src.server.trim()) {
      return { ok: false, message: `"web.server" must be a non-empty string` };
    }
    out.server = src.server.trim();
  }
  if (src.script !== undefined) {
    if (typeof src.script !== "string" || !src.script.trim()) {
      return { ok: false, message: `"web.script" must be a non-empty string` };
    }
    out.script = src.script.trim();
  }
  if (src.url !== undefined) {
    if (typeof src.url !== "string" || !src.url.trim()) {
      return { ok: false, message: `"web.url" must be a non-empty string` };
    }
    out.url = src.url.trim();
  }
  if (src.webRoot !== undefined) {
    if (typeof src.webRoot !== "string" || !src.webRoot.trim()) {
      return { ok: false, message: `"web.webRoot" must be a non-empty string` };
    }
    out.webRoot = resolveMaybe(workspacePath, src.webRoot);
  }
  if (src.stopOnEntry !== undefined) {
    if (typeof src.stopOnEntry !== "boolean") {
      return { ok: false, message: `"web.stopOnEntry" must be a boolean` };
    }
    out.stopOnEntry = src.stopOnEntry;
  }
  if (src.chromeExecutable !== undefined) {
    if (typeof src.chromeExecutable !== "string" || !src.chromeExecutable.trim()) {
      return { ok: false, message: `"web.chromeExecutable" must be a non-empty string` };
    }
    out.chromeExecutable = resolveMaybe(workspacePath, src.chromeExecutable);
  }
  if (src.runtimeExecutable !== undefined) {
    if (typeof src.runtimeExecutable !== "string" || !src.runtimeExecutable.trim()) {
      return { ok: false, message: `"web.runtimeExecutable" must be a non-empty string` };
    }
    out.runtimeExecutable = resolveMaybe(workspacePath, src.runtimeExecutable);
  }
  if (src.runtimeArgs !== undefined) {
    if (
      !Array.isArray(src.runtimeArgs) ||
      src.runtimeArgs.some((item) => typeof item !== "string")
    ) {
      return { ok: false, message: `"web.runtimeArgs" must be an array of strings` };
    }
    out.runtimeArgs = src.runtimeArgs;
  }
  return { ok: true, web: out };
}

export async function readWebDebugConfig(
  workspacePath: string,
): Promise<WebDebugConfigResult> {
  let text: string;
  try {
    text = await readFile(join(workspacePath, DEBUG_CONFIG_FILE_REL), "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { ok: true, web: null };
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
  return parseWebDebugConfig(parsed, workspacePath);
}
