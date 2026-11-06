/**
 * dev_tasks — agent interface for the Dev Mode Build/Run button scripts.
 *
 * Reads/writes `.larry/tasks.json`; validation is shared with the main-side
 * runner (main/devTaskConfig.ts), so a config accepted here is exactly what
 * the buttons will execute. Deliberately never executes tasks: running is
 * a user-initiated button click, keeping the agent out of the blast radius.
 *
 * get/set round-trip the RAW task objects (not the platform-merged defs) —
 * losing the `mac`/`win` blocks on a get→set cycle would silently collapse
 * a dual-platform config to whatever the current machine resolves to.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ToolReturnCode } from "../../session/returnCodes.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { failureResult, textResult } from "../pathUtil.js";
import {
  DEV_TASKS_FILE_REL,
  DEV_TASK_PLATFORM_KEYS,
  parseDevTasksConfig,
  readDevTasksConfig,
} from "../../main/devTaskConfig.js";

const FORMAT_EXAMPLE = `{
  "version": 1,
  "tasks": {
    "build": {
      "command": "npm run build",
      "openAfter": "dist",
      "mac": { "command": "npm run dist:mac" },
      "win": { "command": "npm run dist:win" }
    },
    "run": { "command": "npm run dev", "env": { "NODE_ENV": "development" } }
  }
}

Task fields: command (required) · cwd · timeoutMs · env · openAfter (directory opened in Finder/Explorer after exit 0) · mac / win overrides (merge their command/cwd/timeoutMs/env/openAfter over the base on that platform — keep the base command as the cross-platform fallback).`;

export const devTasksDefinition: ToolDefinition = {
  name: "dev_tasks",
  description:
    "Read or write the Dev Mode task config (.larry/tasks.json) — the scripts for Build, app launch and the optional Deploy button in Dev Mode. Supports per-platform commands (mac/win override blocks) and openAfter (directory opened after a successful build). action=get returns the current tasks plus a format example; action=set validates and writes the whole file (buttons refresh automatically). Never executes tasks — the user runs them from the buttons.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["get", "set"],
        description: "get = read the current tasks; set = write the full config.",
      },
      config: {
        type: "object",
        description:
          'set only — the full config object: { "version": 1, "tasks": { "<id>": { "command": "<shell command>", "cwd": "<relative-or-absolute>", "timeoutMs": 600000, "env": {}, "openAfter": "dist", "mac": { "command": "..." }, "win": { "command": "..." } } } }. Ids "build" and "deploy" map to Dev Mode task buttons; Deploy appears only when configured. "run" supplies the app launch recipe. Additional ids may be defined.',
      },
    },
    required: ["action"],
    additionalProperties: false,
  },
  defaultPermissionLevel: 1,
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Read the raw `tasks` object from disk (keeps platform blocks verbatim). */
async function readRawTasks(ws: string): Promise<Record<string, unknown> | null> {
  let text: string;
  try {
    text = await readFile(join(ws, DEV_TASKS_FILE_REL), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isPlainObject(parsed) || !isPlainObject(parsed.tasks)) return null;
    return parsed.tasks as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** One `- id: …` line summarizing the base + platform commands. */
function describeTask(id: string, raw: unknown): string {
  if (!isPlainObject(raw)) return `- ${id}: (unparsable)`;
  const parts: string[] = [];
  const command = typeof raw.command === "string" ? raw.command : "(no command)";
  parts.push(command);
  for (const key of DEV_TASK_PLATFORM_KEYS) {
    const block = raw[key];
    if (isPlainObject(block) && typeof block.command === "string") {
      parts.push(`${key}: ${block.command}`);
    }
  }
  if (typeof raw.openAfter === "string" && raw.openAfter) {
    parts.push(`openAfter: ${raw.openAfter}`);
  }
  return `- ${id}: ${parts.join(" · ")}`;
}

export const devTasksHandler: ToolHandler = async (args, context) => {
  const action = typeof args.action === "string" ? args.action : "";
  const ws = context.workspacePath;
  if (!ws) return failureResult("No workspace is active for this session.");

  if (action === "get") {
    const res = await readDevTasksConfig(ws);
    if (!res.ok) {
      return failureResult(
        `${res.message}\n\nFix or replace the file with action=set.`,
      );
    }
    const rawTasks = await readRawTasks(ws);
    const ids = Object.keys(res.tasks);
    if (ids.length === 0) {
      return textResult(
        `${DEV_TASKS_FILE_REL} has no tasks yet. Write one with action=set. Format:\n${FORMAT_EXAMPLE}`,
        ToolReturnCode.Success,
      );
    }
    const lines = ids.map((id) => describeTask(id, rawTasks?.[id]));
    return textResult(
      `${DEV_TASKS_FILE_REL} (${ids.length} task(s)):\n${lines.join("\n")}\n\nReplace with action=set (full config). Ids "build" and "deploy" map to Dev Mode task buttons; Deploy appears only when configured.`,
      ToolReturnCode.Success,
    );
  }

  if (action === "set") {
    const raw = args.config;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return failureResult(
        "set requires `config` — the full config object (see action=get for the format).",
      );
    }
    const validated = parseDevTasksConfig(raw, ws);
    if (!validated.ok) {
      return failureResult(`Invalid task config — ${validated.message}`);
    }
    if (!isPlainObject(raw) || !isPlainObject(raw.tasks)) {
      return failureResult("Invalid task config — missing tasks object");
    }
    // Write the validated RAW task objects — platform blocks and openAfter
    // survive verbatim. Only cwd gets normalized: absolute paths under the
    // workspace become relative so the file stays portable across machines.
    const wsNorm = ws.replace(/\\/g, "/").replace(/\/$/, "");
    const relativizeCwd = (cwd: unknown): unknown => {
      if (typeof cwd !== "string" || !cwd.trim()) return cwd;
      const norm = cwd.trim().replace(/\\/g, "/");
      return norm.startsWith(`${wsNorm}/`) ? norm.slice(wsNorm.length + 1) : cwd;
    };
    const normalizeTimeout = (timeoutMs: unknown): unknown => {
      if (typeof timeoutMs === "string" && /^\d+$/.test(timeoutMs.trim())) {
        return Number(timeoutMs.trim());
      }
      return timeoutMs;
    };
    const normalizeBlock = (block: Record<string, unknown>): Record<string, unknown> => {
      const out: Record<string, unknown> = { ...block };
      if (out.cwd !== undefined) out.cwd = relativizeCwd(out.cwd);
      if (out.timeoutMs !== undefined) out.timeoutMs = normalizeTimeout(out.timeoutMs);
      return out;
    };
    const tasks: Record<string, unknown> = {};
    for (const [id, def] of Object.entries(raw.tasks)) {
      if (!isPlainObject(def)) continue;
      const entry: Record<string, unknown> = normalizeBlock(def);
      for (const key of DEV_TASK_PLATFORM_KEYS) {
        if (isPlainObject(entry[key])) entry[key] = normalizeBlock(entry[key]);
      }
      tasks[id] = entry;
    }
    const payload = `${JSON.stringify({ version: 1, tasks }, null, 2)}\n`;
    try {
      await mkdir(join(ws, ".larry"), { recursive: true });
      await writeFile(join(ws, DEV_TASKS_FILE_REL), payload, "utf8");
    } catch (err) {
      return failureResult(
        `Could not write ${DEV_TASKS_FILE_REL} — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const written = Object.keys(tasks);
    return textResult(
      `Wrote ${DEV_TASKS_FILE_REL} — ${written.length} task(s): ${written.join(", ")}. The Dev Mode buttons pick it up automatically.`,
      ToolReturnCode.Success,
    );
  }

  return failureResult('action must be "get" or "set".');
};
