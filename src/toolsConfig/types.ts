/**
 * App-global Tools / MCP / Skills index (`{userData}/tools.json`).
 * Not mixed with LLM settings in settings.json.
 */

import { normalizeSkillProject } from "../skills/projectScope.js";

export const TOOLS_CONFIG_FILE = "tools.json";

/** Local MCP server launched as a child process (JSON-RPC over stdio). */
export type McpStdioTransport = {
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
};

/** Remote MCP server over Streamable HTTP (SSE fallback at connect time). */
export type McpHttpTransport = {
  type: "http";
  url: string;
  headers?: Record<string, string>;
};

export type McpTransport = McpStdioTransport | McpHttpTransport;

/** App-global MCP server profile. */
export type McpServerConfig = {
  id: string;
  name: string;
  enabled: boolean;
  transport: McpTransport;
};

/**
 * App-global skill index entry. Body lives on disk at
 * `{userData}/skills/<name>/SKILL.md`.
 */
export type SkillConfig = {
  id: string;
  /** Unique slug: lowercase letters, numbers, hyphens (max 64). Folder name. */
  name: string;
  enabled: boolean;
  /** Who created / last took ownership. Absent → "user". */
  origin?: SkillOrigin;
  /**
   * Owning project: workspace folder slug (e.g. `jellybot`).
   * Absent → universal (listed in every project).
   */
  project?: string;
  /** Absent → "active". Deprecated skills leave the default catalog. */
  status?: SkillStatus;
  /** Skill id that replaces this one (set by merge / deprecate). */
  supersededBy?: string;
  createdAt?: number;
  updatedAt?: number;
  createdFrom?: { sessionId: string; userMessageId?: string };
  /** Monotonic content revision; absent → 1. */
  revision?: number;
};

export const SKILL_ORIGINS = [
  "user",
  "installed",
  "agent",
  "reflector",
  "coco",
] as const;
export type SkillOrigin = (typeof SKILL_ORIGINS)[number];
export type SkillStatus = "active" | "deprecated";

export type ToolsConfig = {
  version: 1;
  mcpServers: McpServerConfig[];
  skills: SkillConfig[];
  /**
   * Per-tool permission overrides keyed by registry tool name
   * (`write_file`, `mcp__{serverId}__…`). Sparse: only non-default levels.
   * Levels: 0 Allow, 1 Full, 2 Ask.
   */
  toolPermissionOverrides: Record<string, 0 | 1 | 2>;
  /**
   * Per-tool always-offer overrides. true = include in model tools[],
   * false = defer until search_tools. Absent → follow Auto-organize baseline
   * or built-in defaults.
   */
  toolOfferOverrides: Record<string, boolean>;
  /**
   * Per-tool conversation card visibility. false = tool still executes and
   * is stored in the session, but its card is not rendered in the chat flow
   * (streaming, finished, and history replay). Absent → show (true).
   */
  toolDisplayOverrides: Record<string, boolean>;
  /**
   * Last Tools → Auto-organize result (ordered registry names, ≤16).
   * Forced meta tools are not stored here.
   */
  toolOfferAutoBaseline: string[];
  /**
   * Shell Safe Mode (plan: docs/plans/20260819-shell-safe-mode.md).
   * enabled=false bypasses every risk assessor (legacy behavior);
   * fatalPolicy: "ask" (confirm card on Class A) | "block" (hard deny).
   */
  shellSafety: ShellSafetyOptions;
};

export type ShellSafetyOptions = {
  enabled: boolean;
  fatalPolicy: "ask" | "block";
};

/** Parse/normalize shellSafety; defaults enabled+ask on anything invalid. */
export function normalizeShellSafety(value: unknown): ShellSafetyOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { enabled: true, fatalPolicy: "ask" };
  }
  const raw = value as Record<string, unknown>;
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : true,
    fatalPolicy:
      raw.fatalPolicy === "ask" || raw.fatalPolicy === "block"
        ? raw.fatalPolicy
        : "ask",
  };
}

/** Sparse patch onto tools.json (only present keys are overwritten). */
export type ToolsConfigPatch = {
  mcpServers?: McpServerConfig[];
  skills?: SkillConfig[];
  toolPermissionOverrides?: Record<string, 0 | 1 | 2>;
  toolOfferOverrides?: Record<string, boolean>;
  toolDisplayOverrides?: Record<string, boolean>;
  toolOfferAutoBaseline?: string[];
  shellSafety?: ShellSafetyOptions;
};

export function emptyToolsConfig(): ToolsConfig {
  return {
    version: 1,
    mcpServers: [],
    skills: [],
    toolPermissionOverrides: {},
    toolOfferOverrides: {},
    toolDisplayOverrides: {},
    toolOfferAutoBaseline: [],
    shellSafety: { enabled: true, fatalPolicy: "ask" },
  };
}

function normalizeStringRecord(
  value: unknown,
): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const k = key.trim();
    if (!k || typeof raw !== "string") continue;
    out[k] = raw;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeMcpTransport(value: unknown): McpTransport | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.type === "stdio") {
    if (typeof raw.command !== "string" || !raw.command.trim()) return null;
    const transport: McpStdioTransport = {
      type: "stdio",
      command: raw.command.trim(),
    };
    if (Array.isArray(raw.args)) {
      const args = raw.args
        .filter((a): a is string => typeof a === "string")
        .map((a) => a.trim())
        .filter(Boolean);
      if (args.length > 0) transport.args = args;
    }
    const env = normalizeStringRecord(raw.env);
    if (env) transport.env = env;
    if (typeof raw.cwd === "string" && raw.cwd.trim()) {
      transport.cwd = raw.cwd.trim();
    }
    return transport;
  }
  if (raw.type === "http") {
    if (typeof raw.url !== "string" || !raw.url.trim()) return null;
    try {
      void new URL(raw.url.trim());
    } catch {
      return null;
    }
    const transport: McpHttpTransport = {
      type: "http",
      url: raw.url.trim(),
    };
    const headers = normalizeStringRecord(raw.headers);
    if (headers) transport.headers = headers;
    return transport;
  }
  return null;
}

/** Parse / normalize MCP server configs from tools.json (or legacy settings). */
export function normalizeMcpServers(value: unknown): McpServerConfig[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: McpServerConfig[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const raw = item as Record<string, unknown>;
    if (typeof raw.id !== "string" || !raw.id.trim()) continue;
    if (typeof raw.name !== "string" || !raw.name.trim()) continue;
    const transport = normalizeMcpTransport(raw.transport);
    if (!transport) continue;
    const id = raw.id.trim();
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: raw.name.trim(),
      enabled: raw.enabled !== false,
      transport,
    });
  }
  return out;
}

const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Parse / normalize skill index entries from tools.json (or legacy settings). */
export function normalizeSkills(value: unknown): SkillConfig[] {
  if (!Array.isArray(value)) return [];
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  const out: SkillConfig[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const raw = item as Record<string, unknown>;
    if (typeof raw.id !== "string" || !raw.id.trim()) continue;
    if (typeof raw.name !== "string" || !raw.name.trim()) continue;
    const id = raw.id.trim();
    const name = raw.name.trim().toLowerCase();
    if (!SKILL_NAME_RE.test(name) || name.length > 64) continue;
    if (seenIds.has(id) || seenNames.has(name)) continue;
    seenIds.add(id);
    seenNames.add(name);
    out.push({ id, name, enabled: raw.enabled !== false, ...normalizeSkillMeta(raw) });
  }
  return out;
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

/** Optional provenance fields; unknown / malformed values are dropped. */
export function normalizeSkillMeta(
  raw: Record<string, unknown>,
): Omit<SkillConfig, "id" | "name" | "enabled"> {
  const out: Omit<SkillConfig, "id" | "name" | "enabled"> = {};
  if (
    typeof raw.origin === "string" &&
    (SKILL_ORIGINS as readonly string[]).includes(raw.origin)
  ) {
    out.origin = raw.origin as SkillOrigin;
  }
  if (raw.status === "active" || raw.status === "deprecated") {
    out.status = raw.status;
  }
  const project = normalizeSkillProject(raw.project);
  if (project) out.project = project;
  if (typeof raw.supersededBy === "string" && raw.supersededBy.trim()) {
    out.supersededBy = raw.supersededBy.trim();
  }
  const createdAt = positiveInt(raw.createdAt);
  if (createdAt !== undefined) out.createdAt = createdAt;
  const updatedAt = positiveInt(raw.updatedAt);
  if (updatedAt !== undefined) out.updatedAt = updatedAt;
  const revision = positiveInt(raw.revision);
  if (revision !== undefined) out.revision = revision;
  const from = raw.createdFrom;
  if (from && typeof from === "object" && !Array.isArray(from)) {
    const f = from as Record<string, unknown>;
    if (typeof f.sessionId === "string" && f.sessionId) {
      out.createdFrom = {
        sessionId: f.sessionId,
        ...(typeof f.userMessageId === "string" && f.userMessageId
          ? { userMessageId: f.userMessageId }
          : {}),
      };
    }
  }
  return out;
}

/** Parse / normalize per-tool permission overrides. */
export function normalizeToolPermissionOverrides(
  value: unknown,
): Record<string, 0 | 1 | 2> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, 0 | 1 | 2> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const name = key.trim();
    if (!name) continue;
    if (raw === 0 || raw === 1 || raw === 2) {
      out[name] = raw;
    }
  }
  return out;
}

export function normalizeToolOfferOverrides(
  value: unknown,
): Record<string, boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, boolean> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const name = key.trim();
    if (!name) continue;
    if (typeof raw === "boolean") {
      out[name] = raw;
    }
  }
  return out;
}

export function normalizeToolDisplayOverrides(
  value: unknown,
): Record<string, boolean> {
  return normalizeToolOfferOverrides(value);
}

export function normalizeToolOfferAutoBaseline(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const name = raw.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
    if (out.length >= 16) break;
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse tools.json body; invalid → empty defaults. */
export function parseToolsConfig(raw: unknown): ToolsConfig {
  if (!isRecord(raw)) return emptyToolsConfig();
  return {
    version: 1,
    mcpServers: normalizeMcpServers(raw.mcpServers),
    skills: normalizeSkills(raw.skills),
    toolPermissionOverrides: normalizeToolPermissionOverrides(
      raw.toolPermissionOverrides,
    ),
    toolOfferOverrides: normalizeToolOfferOverrides(raw.toolOfferOverrides),
    toolDisplayOverrides: normalizeToolDisplayOverrides(
      raw.toolDisplayOverrides,
    ),
    toolOfferAutoBaseline: normalizeToolOfferAutoBaseline(
      raw.toolOfferAutoBaseline,
    ),
    shellSafety: normalizeShellSafety(raw.shellSafety),
  };
}

/**
 * Extract legacy Tools/MCP/Skills fields from a settings.json object.
 * Used only for one-time migration into tools.json.
 */
export function extractLegacyToolsFieldsFromSettings(
  settings: unknown,
): ToolsConfig | null {
  if (!isRecord(settings)) return null;
  const hasAny =
    "mcpServers" in settings ||
    "skills" in settings ||
    "toolPermissionOverrides" in settings ||
    "toolOfferOverrides" in settings ||
    "toolDisplayOverrides" in settings ||
    "toolOfferAutoBaseline" in settings;
  if (!hasAny) return null;
  return parseToolsConfig(settings);
}
