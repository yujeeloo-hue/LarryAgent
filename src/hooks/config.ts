import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  HOOK_EVENT_NAMES,
  type HookCommandConfig,
  type HookEventName,
  type HookListEntry,
  type HooksFileConfig,
} from "./types.js";

export function userHooksPath(userDataRoot: string): string {
  return join(userDataRoot, "hooks.json");
}

export function projectHooksPath(workspacePath: string): string {
  return join(workspacePath, ".jellybot", "hooks.json");
}

function isHookEventName(value: string): value is HookEventName {
  return (HOOK_EVENT_NAMES as readonly string[]).includes(value);
}

function normalizeCommandConfig(raw: unknown): HookCommandConfig | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.command !== "string" || !obj.command.trim()) return null;
  const config: HookCommandConfig = {
    command: obj.command.trim(),
  };
  if (obj.type === "command") config.type = "command";
  if (typeof obj.timeout === "number" && Number.isFinite(obj.timeout) && obj.timeout > 0) {
    config.timeout = Math.floor(obj.timeout);
  }
  if (typeof obj.matcher === "string" && obj.matcher.trim()) {
    config.matcher = obj.matcher.trim();
  }
  if (obj.failClosed === true) config.failClosed = true;
  return config;
}

export function parseHooksFile(raw: unknown): HooksFileConfig {
  const empty: HooksFileConfig = { version: 1, hooks: {} };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return empty;
  const obj = raw as Record<string, unknown>;
  const version =
    typeof obj.version === "number" && Number.isFinite(obj.version)
      ? Math.floor(obj.version)
      : 1;
  const hooks: HooksFileConfig["hooks"] = {};
  const hooksRaw = obj.hooks;
  if (hooksRaw && typeof hooksRaw === "object" && !Array.isArray(hooksRaw)) {
    for (const [key, value] of Object.entries(
      hooksRaw as Record<string, unknown>,
    )) {
      if (!isHookEventName(key)) continue;
      if (!Array.isArray(value)) continue;
      const list: HookCommandConfig[] = [];
      for (const item of value) {
        const cfg = normalizeCommandConfig(item);
        if (cfg) list.push(cfg);
      }
      if (list.length > 0) hooks[key] = list;
    }
  }
  return { version, hooks };
}

async function readHooksFile(path: string): Promise<HooksFileConfig> {
  try {
    const text = await readFile(path, "utf8");
    const parsed: unknown = JSON.parse(text);
    return parseHooksFile(parsed);
  } catch {
    return { version: 1, hooks: {} };
  }
}

export type LoadedHookConfigs = {
  user: HooksFileConfig;
  project: HooksFileConfig;
  /** user hooks first, then project (project last-write-wins for rewrites). */
  orderedByEvent: Map<
    HookEventName,
    Array<{ config: HookCommandConfig; source: "user" | "project"; id: string }>
  >;
};

export async function loadHookConfigs(input: {
  userDataRoot: string;
  workspacePath: string;
}): Promise<LoadedHookConfigs> {
  const user = await readHooksFile(userHooksPath(input.userDataRoot));
  const project = input.workspacePath.trim()
    ? await readHooksFile(projectHooksPath(input.workspacePath))
    : { version: 1, hooks: {} };

  const orderedByEvent = new Map<
    HookEventName,
    Array<{ config: HookCommandConfig; source: "user" | "project"; id: string }>
  >();

  for (const event of HOOK_EVENT_NAMES) {
    const list: Array<{
      config: HookCommandConfig;
      source: "user" | "project";
      id: string;
    }> = [];
    let i = 0;
    for (const config of user.hooks[event] ?? []) {
      list.push({
        config,
        source: "user",
        id: `user:${event}:${i}`,
      });
      i += 1;
    }
    i = 0;
    for (const config of project.hooks[event] ?? []) {
      list.push({
        config,
        source: "project",
        id: `project:${event}:${i}`,
      });
      i += 1;
    }
    if (list.length > 0) orderedByEvent.set(event, list);
  }

  return { user, project, orderedByEvent };
}

export function commandHooksAsListEntries(
  loaded: LoadedHookConfigs,
): HookListEntry[] {
  const entries: HookListEntry[] = [];
  for (const event of HOOK_EVENT_NAMES) {
    const list = loaded.orderedByEvent.get(event) ?? [];
    for (const item of list) {
      entries.push({
        id: item.id,
        event,
        source: item.source,
        command: item.config.command,
        ...(item.config.matcher ? { matcher: item.config.matcher } : {}),
        failClosed: item.config.failClosed === true,
        ...(typeof item.config.timeout === "number"
          ? { timeoutSec: item.config.timeout }
          : {}),
      });
    }
  }
  return entries;
}
