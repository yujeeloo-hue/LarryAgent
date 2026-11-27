import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export const DEV_TASKS_FILE_REL = ".larry/tasks.json";

export const DEV_TASK_DEFAULT_TIMEOUT_MS = 600_000;
export const DEV_TASK_MIN_TIMEOUT_MS = 1_000;
export const DEV_TASK_MAX_TIMEOUT_MS = 28_800_000;

const MAX_TASKS = 24;
const MAX_COMMAND_CHARS = 4_000;
const MAX_ENV_VARS = 32;
const MAX_ENV_VALUE_CHARS = 2_000;
const MAX_OPEN_AFTER_CHARS = 1_024;
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const DEV_TASK_PLATFORM_KEYS = ["mac", "win"] as const;
export type DevTaskPlatformKey = (typeof DEV_TASK_PLATFORM_KEYS)[number];

export function devTaskPlatformKey(
  platform: string = process.platform,
): DevTaskPlatformKey | null {
  if (platform === "darwin") return "mac";
  if (platform === "win32") return "win";
  return null;
}

export type DevTaskDef = {
  command: string;
  cwd: string;
  timeoutMs: number;
  env: Record<string, string>;
  openAfter?: string;
};

export type DevTaskConfigResult =
  | { ok: true; tasks: Record<string, DevTaskDef>; preBuild?: string }
  | { ok: false; message: string };

/**
 * Separator between the pre-build command and the build command. It must keep
 * running the build when the pre-build command exits non-zero — the pre-build
 * step is advisory (lint, codegen warnings), so its failure is reported in the
 * run output but never blocks the build.
 */
export function preBuildSeparator(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? " & " : "; ";
}

export const PRE_BUILD_FAILURE_NOTE =
  "pre-build step failed - continuing with the build";

const JOINED_SEPARATORS = [" && ", " & ", "; ", " &&", ";"];

/**
 * Prepends a workspace-configured command to every build execution. The host
 * stays agnostic about what the command does (lint, codegen, telemetry, ...).
 * A non-zero pre-build exit only prints a one-line note; the build still runs.
 */
export function prependPreBuild(
  preBuild: string | undefined,
  command: string,
  separator: string = preBuildSeparator(),
): string {
  const prefix = preBuild?.trim();
  if (!prefix) return command;
  const trimmed = command.trim();
  if (trimmed === prefix) return command;
  for (const joined of [separator, " || ", ...JOINED_SEPARATORS]) {
    if (trimmed.startsWith(`${prefix}${joined}`)) return command;
  }
  const note = `[Larry] ${PRE_BUILD_FAILURE_NOTE}`;
  const guarded = `${prefix} || echo ${separator === " & " ? note : `"${note}"`}`;
  return `${guarded}${separator}${command}`;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function clampTimeout(raw: unknown): number | null {
  let n: number;
  if (typeof raw === "number" && Number.isFinite(raw)) n = Math.round(raw);
  else if (typeof raw === "string" && /^\d+$/.test(raw.trim()))
    n = Number(raw.trim());
  else return null;
  if (n < 1) return null;
  return Math.min(
    Math.max(n, DEV_TASK_MIN_TIMEOUT_MS),
    DEV_TASK_MAX_TIMEOUT_MS,
  );
}

type FieldErrors = string[];

function parseEnvValue(
  rawEnv: unknown,
  label: string,
  errors: FieldErrors,
): Record<string, string> | null {
  if (!isPlainObject(rawEnv)) return null;
  const keys = Object.keys(rawEnv);
  if (keys.length > MAX_ENV_VARS) {
    errors.push(`Task ${label} declares more than ${MAX_ENV_VARS} env vars`);
    return null;
  }
  const env: Record<string, string> = {};
  for (const key of keys) {
    if (!ENV_NAME_RE.test(key)) {
      errors.push(`Task ${label} env name "${key}" is not a valid variable name`);
      return null;
    }
    const value = (rawEnv as Record<string, unknown>)[key];
    if (typeof value !== "string" || value.length > MAX_ENV_VALUE_CHARS) {
      errors.push(
        `Task ${label} env "${key}" must be a string of ≤ ${MAX_ENV_VALUE_CHARS} chars`,
      );
      return null;
    }
    env[key] = value;
  }
  return env;
}

function parseTaskFields(
  src: Record<string, unknown>,
  label: string,
  errors: FieldErrors,
): {
  command?: string;
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  openAfter?: string;
} {
  const out: {
    command?: string;
    cwd?: string;
    timeoutMs?: number;
    env?: Record<string, string>;
    openAfter?: string;
  } = {};

  if (src.command !== undefined) {
    if (typeof src.command !== "string" || !src.command.trim()) {
      errors.push(`Task ${label} needs a non-empty "command" string`);
    } else if (src.command.length > MAX_COMMAND_CHARS) {
      errors.push(`Task ${label} command exceeds ${MAX_COMMAND_CHARS} chars`);
    } else {
      out.command = src.command;
    }
  }
  if (src.cwd !== undefined) {
    if (typeof src.cwd !== "string") {
      errors.push(`Task ${label} cwd must be a string`);
    } else {
      out.cwd = src.cwd;
    }
  }
  if (src.timeoutMs !== undefined) {
    const timeoutMs = clampTimeout(src.timeoutMs);
    if (timeoutMs === null) {
      errors.push(`Task ${label} timeoutMs must be a positive number`);
    } else {
      out.timeoutMs = timeoutMs;
    }
  }
  if (src.env !== undefined) {
    const env = parseEnvValue(src.env, label, errors);
    if (env) out.env = env;
  }
  if (src.openAfter !== undefined) {
    if (
      typeof src.openAfter !== "string" ||
      !src.openAfter.trim() ||
      src.openAfter.trim().length > MAX_OPEN_AFTER_CHARS
    ) {
      errors.push(
        `Task ${label} openAfter must be a non-empty directory path string (≤ ${MAX_OPEN_AFTER_CHARS} chars)`,
      );
    } else {
      out.openAfter = src.openAfter.trim();
    }
  }
  return out;
}

export function parseDevTasksConfig(
  raw: unknown,
  workspacePath: string,
  platform: string = process.platform,
): DevTaskConfigResult {
  if (!isPlainObject(raw)) {
    return { ok: false, message: `${DEV_TASKS_FILE_REL} must contain an object` };
  }
  if (raw.version !== undefined && raw.version !== 1) {
    return { ok: false, message: `Unsupported version ${String(raw.version)} — expected 1` };
  }
  if (raw.tasks !== undefined && !isPlainObject(raw.tasks)) {
    return { ok: false, message: `"tasks" must be an object of task id → definition` };
  }
  let preBuild: string | undefined;
  if (raw.preBuild !== undefined) {
    if (typeof raw.preBuild !== "string" || raw.preBuild.length > MAX_COMMAND_CHARS) {
      return { ok: false, message: `"preBuild" must be a string of ≤ ${MAX_COMMAND_CHARS} chars` };
    }
    preBuild = raw.preBuild.trim() || undefined;
  }
  const taskMap = (raw.tasks ?? {}) as Record<string, unknown>;
  const ids = Object.keys(taskMap);
  if (ids.length > MAX_TASKS) {
    return { ok: false, message: `Too many tasks (${ids.length} > ${MAX_TASKS})` };
  }
  const platformKey = devTaskPlatformKey(platform);

  const tasks: Record<string, DevTaskDef> = {};
  for (const id of ids) {
    if (!TASK_ID_RE.test(id)) {
      return {
        ok: false,
        message: `Invalid task id "${id}" — use letters, digits, "-" or "_" (max 32 chars)`,
      };
    }
    const def = taskMap[id];
    if (!isPlainObject(def)) {
      return { ok: false, message: `Task "${id}" must be an object` };
    }

    const overrides: Partial<
      Record<DevTaskPlatformKey, ReturnType<typeof parseTaskFields>>
    > = {};
    for (const key of DEV_TASK_PLATFORM_KEYS) {
      const block = def[key];
      if (block === undefined) continue;
      if (!isPlainObject(block)) {
        return {
          ok: false,
          message: `Task "${id}" ${key} override must be an object`,
        };
      }
      const errors: FieldErrors = [];
      overrides[key] = parseTaskFields(block, `"${id}" (${key} override)`, errors);
      if (errors.length > 0) return { ok: false, message: errors[0]! };
    }

    const errors: FieldErrors = [];
    const base = parseTaskFields(def, `"${id}"`, errors);
    if (errors.length > 0) return { ok: false, message: errors[0]! };
    if (base.command === undefined) {
      return { ok: false, message: `Task "${id}" needs a non-empty "command" string` };
    }

    const effective = platformKey
      ? { ...base, ...(overrides[platformKey] ?? {}) }
      : base;
    const env = { ...(base.env ?? {}), ...(effective.env ?? {}) };
    const cwd =
      effective.cwd !== undefined && effective.cwd.trim()
        ? isAbsoluteStr(effective.cwd.trim())
          ? effective.cwd.trim()
          : resolve(workspacePath, effective.cwd.trim())
        : workspacePath;
    const task: DevTaskDef = {
      command: effective.command ?? base.command,
      cwd,
      timeoutMs: effective.timeoutMs ?? DEV_TASK_DEFAULT_TIMEOUT_MS,
      env,
    };
    if (effective.openAfter !== undefined) {
      task.openAfter = isAbsoluteStr(effective.openAfter)
        ? effective.openAfter
        : resolve(workspacePath, effective.openAfter);
    }
    tasks[id] = task;
  }
  return { ok: true, tasks, ...(preBuild ? { preBuild } : {}) };
}

function isAbsoluteStr(p: string): boolean {
  return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);
}

export async function readDevTasksConfig(
  workspacePath: string,
  platform: string = process.platform,
): Promise<DevTaskConfigResult> {
  let text: string;
  try {
    text = await readFile(join(workspacePath, DEV_TASKS_FILE_REL), "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { ok: true, tasks: {} };
    return {
      ok: false,
      message: `Could not read ${DEV_TASKS_FILE_REL} — ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      message: `${DEV_TASKS_FILE_REL} is not valid JSON — ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return parseDevTasksConfig(parsed, workspacePath, platform);
}
