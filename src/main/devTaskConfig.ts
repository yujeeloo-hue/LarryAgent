/**
 * Dev Mode task configuration — `.larry/tasks.json` at the workspace root.
 *
 * Pure parsing / validation (no Electron imports) so it stays unit-testable
 * in plain node. Consumers:
 * - main/devTasks.ts — Build/Run buttons execute tasks from here;
 * - tools/builtin/devTasks.ts — the agent-side `dev_tasks` tool writes here.
 *
 * Format:
 * {
 *   "version": 1,
 *   "tasks": {
 *     "build": {
 *       "command": "npm run build",
 *       "cwd": ".", "timeoutMs": 600000, "env": {},
 *       "openAfter": "dist",
 *       "mac": { "command": "npm run dist:mac" },
 *       "win": { "command": "npm run dist:win", "openAfter": "dist/win-unpacked" }
 *     },
 *     "run": { "command": "npm run dev" }
 *   }
 * }
 *
 * timeoutMs default is 10 minutes (1s–8h). Unreal workspaces get the
 * `build` task's timeout floored at UNREAL_UBT_TIMEOUT_MS (4h) — UE
 * compiles run for hours (see devTaskResolve.ts).
 *
 * Platform overrides (`mac` for darwin, `win` for win32) merge over the base
 * fields at parse time, so consumers always see the effective definition for
 * the machine they run on. `openAfter` is a directory (workspace-relative or
 * absolute) opened in the file manager after the task exits 0.
 */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/** Config location relative to the workspace root. */
export const DEV_TASKS_FILE_REL = ".larry/tasks.json";

export const DEV_TASK_DEFAULT_TIMEOUT_MS = 600_000;
export const DEV_TASK_MIN_TIMEOUT_MS = 1_000;
/** Cap for `.larry/tasks.json` — UBT DebugGame Editor often exceeds 1h. */
export const DEV_TASK_MAX_TIMEOUT_MS = 28_800_000;

const MAX_TASKS = 24;
const MAX_COMMAND_CHARS = 4_000;
const MAX_ENV_VARS = 32;
const MAX_ENV_VALUE_CHARS = 2_000;
const MAX_OPEN_AFTER_CHARS = 1_024;
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Override keys accepted inside a task definition. */
export const DEV_TASK_PLATFORM_KEYS = ["mac", "win"] as const;
export type DevTaskPlatformKey = (typeof DEV_TASK_PLATFORM_KEYS)[number];

/** node platform → override key (null = no overrides apply). */
export function devTaskPlatformKey(
  platform: string = process.platform,
): DevTaskPlatformKey | null {
  if (platform === "darwin") return "mac";
  if (platform === "win32") return "win";
  return null;
}

export type DevTaskDef = {
  /** Shell command line (runs under /bin/zsh -lc or cmd.exe). */
  command: string;
  /** Absolute working directory (task `cwd` resolved against the workspace). */
  cwd: string;
  /**
   * Kill the process group after this long.
   * `0` disables the wall-clock timer (used by the synthetic Unreal UBT build).
   */
  timeoutMs: number;
  /** Extra env vars merged over process.env. */
  env: Record<string, string>;
  /** Directory opened in the file manager after the task exits 0. */
  openAfter?: string;
};

export type DevTaskConfigResult =
  | { ok: true; tasks: Record<string, DevTaskDef> }
  | { ok: false; message: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function clampTimeout(raw: unknown): number | null {
  let n: number;
  if (typeof raw === "number" && Number.isFinite(raw)) n = Math.round(raw);
  else if (typeof raw === "string" && /^\d+$/.test(raw.trim()))
    n = Number(raw.trim());
  else return null;
  // Zero/negative is a config error; oversized values clamp down to the cap.
  if (n < 1) return null;
  return Math.min(
    Math.max(n, DEV_TASK_MIN_TIMEOUT_MS),
    DEV_TASK_MAX_TIMEOUT_MS,
  );
}

/** One field source: the task base definition or a platform override. */
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

/**
 * Validate the shared command fields of one field source. Everything is
 * optional at this level — `command` is required only for the base
 * definition, which the caller checks separately. Errors accumulate into
 * `errors` with a pointing `label` like `"build"` or `"build" (mac override)`.
 */
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

/**
 * Validate one parsed JSON document. Absent fields take defaults; anything
 * malformed fails the whole file with a pointing message (the agent tool
 * surfaces the same text, so mis-written configs are self-explaining).
 *
 * `platform` (a node platform string, defaulting to the current one) selects
 * which override block merges over the base definition.
 */
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

    // Validate platform blocks even when they do not apply to this machine —
    // a broken override would otherwise only fail on the other platform.
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

    // Effective definition = base merged with the current platform override
    // (every override field replaces its base counterpart; env merges per key).
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
  return { ok: true, tasks };
}

function isAbsoluteStr(p: string): boolean {
  return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);
}

/**
 * Read + validate the workspace config. A missing file is not an error —
 * it means "no tasks yet" (buttons stay disabled with a hint).
 */
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
