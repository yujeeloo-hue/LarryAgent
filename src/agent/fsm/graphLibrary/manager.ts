import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createDefaultActionRegistry } from "../actions/createDefaultActionRegistry.js";
import { loadGraphConfig } from "../compatibility/loadGraphConfig.js";
import { validateFSMGraphConfig } from "../validateFSMGraphConfig.js";
import type { FSMGraphConfig } from "../types.js";
import { llmDescriptionOf, toLlmParamsSchema } from "./llmCatalog.js";
import { createDefaultGraphConfig } from "./defaultGraph.js";
import type {
  FsmActionCatalogEntry,
  FsmBuiltinTemplate,
  FsmGraphLibraryEntry,
  FsmGraphOrigin,
  FsmGraphLibraryRecord,
  BuiltinGraphMode,
} from "./types.js";
import {
  FSM_BUILTIN_TEMPLATES,
  FSM_GRAPH_COLORS,
  forkColorForMode,
  normalizeFsmGraphColor,
} from "./types.js";
import { graphConfigForMode } from "../FsmGraphWorkflow.js";

const INDEX_FILE = "index.json";

type GraphIndex = {
  version: 1;
  graphs: FsmGraphLibraryEntry[];
};

/** Deserialized input may carry any supported graph version. Outputs are current. */
type GraphRecordInput = Omit<FsmGraphLibraryRecord, "config"> & { config: unknown };

let graphsRoot: string | null = null;

export function configureFsmGraphsRoot(root: string): void {
  graphsRoot = root;
}

function requireRoot(): string {
  if (!graphsRoot) {
    throw new Error("FSM graphs root is not configured");
  }
  return graphsRoot;
}

function graphFilePath(id: string): string {
  return join(requireRoot(), `${id}.json`);
}

async function ensureRoot(): Promise<void> {
  await mkdir(requireRoot(), { recursive: true });
}

function normalizeGraphOrigin(origin: unknown): FsmGraphOrigin {
  return origin === "llm" ? "llm" : "user";
}

/**
 * Legacy records/entries predate origin/enabled: normalize on read to
 * user-authored + enabled. Fields re-persist on the next save. `color`
 * is kept only when it is a valid `#rrggbb` hex.
 */
function normalizeGraphFields<
  T extends { origin?: unknown; enabled?: unknown; color?: unknown },
>(value: T): Omit<T, "color"> & { origin: FsmGraphOrigin; enabled: boolean } {
  const { color: rawColor, ...rest } = value;
  const origin = normalizeGraphOrigin(value.origin);
  const color = normalizeFsmGraphColor(rawColor);
  return {
    ...rest,
    origin,
    enabled: typeof value.enabled === "boolean" ? value.enabled : true,
    ...(color ? { color } : {}),
  };
}

async function readIndex(): Promise<GraphIndex> {
  await ensureRoot();
  try {
    const raw = await readFile(join(requireRoot(), INDEX_FILE), "utf8");
    const parsed = JSON.parse(raw) as GraphIndex;
    if (parsed?.version === 1 && Array.isArray(parsed.graphs)) {
      return { version: 1, graphs: parsed.graphs.map(normalizeGraphFields) };
    }
  } catch {
    // missing or corrupt → empty index
  }
  return { version: 1, graphs: [] };
}

async function writeIndex(index: GraphIndex): Promise<void> {
  await ensureRoot();
  await writeFile(
    join(requireRoot(), INDEX_FILE),
    `${JSON.stringify(index, null, 2)}\n`,
    "utf8",
  );
}

function assertRecord(raw: unknown): GraphRecordInput {
  if (!raw || typeof raw !== "object") {
    throw new Error("Graph record must be an object");
  }
  const record = raw as GraphRecordInput;
  if (typeof record.id !== "string" || !record.id.trim()) {
    throw new Error("Graph record.id is required");
  }
  if (typeof record.name !== "string" || !record.name.trim()) {
    throw new Error("Graph record.name is required");
  }
  if (!record.config || typeof record.config !== "object") {
    throw new Error("Graph record.config is required");
  }
  return record;
}

export function validateGraphConfig(raw: unknown): FSMGraphConfig {
  const { config } = loadGraphConfig(raw);
  const registry = createDefaultActionRegistry();
  validateFSMGraphConfig(config, registry);
  return config;
}

export function listActionCatalog(): FsmActionCatalogEntry[] {
  return createDefaultActionRegistry().listActionCatalog();
}

/**
 * LLM catalog projection: no nested paramsSchema (use describeAction) and no
 * editor titles — descriptions come from `x-llmDescription ?? description`.
 */
export function listActionCatalogSlim(): Array<{
  type: string;
  description?: string;
  required?: string[];
}> {
  return listActionCatalog().map((entry) => {
    const required = Array.isArray(entry.paramsSchema.required)
      ? entry.paramsSchema.required.filter(
          (k): k is string => typeof k === "string",
        )
      : undefined;
    const description = llmDescriptionOf(entry.paramsSchema);
    return {
      type: entry.type,
      ...(description ? { description } : {}),
      ...(required && required.length > 0 ? { required } : {}),
    };
  });
}

export function listEdgeCatalogSlim(): Array<{
  type: string;
  description?: string;
  required?: string[];
}> {
  return createDefaultActionRegistry()
    .listEdgeCatalog()
    .map((entry) => {
      const required = Array.isArray(entry.paramsSchema.required)
        ? entry.paramsSchema.required.filter(
            (k): k is string => typeof k === "string",
          )
        : undefined;
      const description = llmDescriptionOf(entry.paramsSchema);
      return {
        type: entry.type,
        ...(description ? { description } : {}),
        ...(required && required.length > 0 ? { required } : {}),
      };
    });
}

/** LLM-facing describe entry: projected paramsSchema, no editor chrome. */
export type FsmLlmDescribeEntry = {
  type: string;
  description?: string;
  paramsSchema: Record<string, unknown>;
};

export function describeAction(type: string): FsmLlmDescribeEntry | null {
  const registry = createDefaultActionRegistry();
  const trimmed = type.trim();
  if (!trimmed || !registry.hasAction(trimmed)) return null;
  const schema = registry.getActionParamsSchema(trimmed);
  const description = llmDescriptionOf(schema);
  return {
    type: trimmed,
    ...(description ? { description } : {}),
    paramsSchema: toLlmParamsSchema(schema),
  };
}

export function describeEdge(type: string): FsmLlmDescribeEntry | null {
  const registry = createDefaultActionRegistry();
  const trimmed = type.trim();
  if (!trimmed || !registry.hasEdge(trimmed)) return null;
  const schema = registry.getEdgeParamsSchema(trimmed);
  const description = llmDescriptionOf(schema);
  return {
    type: trimmed,
    ...(description ? { description } : {}),
    paramsSchema: toLlmParamsSchema(schema),
  };
}

export async function listFsmGraphs(): Promise<FsmGraphLibraryEntry[]> {
  const index = await readIndex();
  return [...index.graphs].sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Built-in graphs selectable in the composer without forking. Resolved from
 * code on every read (always the current template), never stored on disk, and
 * read-only: save / enable / delete reject these ids.
 */
export const BUILTIN_GRAPH_ID_PREFIX = "builtin:";
const COMPOSER_BUILTIN_GRAPHS: ReadonlyArray<{ mode: BuiltinGraphMode; name: string }> = [
  { mode: "react_v2", name: "Auto V2" },
];

export function builtinGraphId(mode: BuiltinGraphMode): string {
  return `${BUILTIN_GRAPH_ID_PREFIX}${mode}`;
}

export function isBuiltinGraphId(id: string): boolean {
  return id.trim().startsWith(BUILTIN_GRAPH_ID_PREFIX);
}

function builtinGraphRecord(id: string): FsmGraphLibraryRecord | null {
  const entry = COMPOSER_BUILTIN_GRAPHS.find((g) => builtinGraphId(g.mode) === id);
  if (!entry) return null;
  return {
    id,
    name: entry.name,
    createdAt: 0,
    updatedAt: 0,
    config: structuredClone(graphConfigForMode(entry.mode)),
    origin: "user",
    enabled: true,
    color: forkColorForMode(entry.mode),
  };
}

/** Composer graph picker: built-in graphs first, then enabled library graphs. */
export async function listComposerGraphs(): Promise<FsmGraphLibraryEntry[]> {
  const builtins = COMPOSER_BUILTIN_GRAPHS.map((g): FsmGraphLibraryEntry => ({
    id: builtinGraphId(g.mode),
    name: g.name,
    updatedAt: 0,
    origin: "user",
    enabled: true,
    color: forkColorForMode(g.mode),
  }));
  const library = (await listFsmGraphs()).filter((g) => g.enabled);
  return [...builtins, ...library];
}

function assertNotBuiltinGraph(id: string, action: string): void {
  if (isBuiltinGraphId(id)) {
    throw new Error(
      `Built-in graph "${id}" is read-only and cannot be ${action}. Fork it in the Graphs screen to customize.`,
    );
  }
}

export async function getFsmGraph(
  id: string,
): Promise<FsmGraphLibraryRecord | null> {
  const trimmed = id.trim();
  if (!trimmed) return null;
  if (isBuiltinGraphId(trimmed)) return builtinGraphRecord(trimmed);
  try {
    const raw = await readFile(graphFilePath(trimmed), "utf8");
    const record = assertRecord(JSON.parse(raw));
    const { color: rawColor, ...rest } = record;
    const { origin, enabled } = normalizeGraphFields(record);
    const color = normalizeFsmGraphColor(rawColor);
    return {
      ...rest,
      origin,
      enabled,
      ...(color ? { color } : {}),
      config: loadGraphConfig(record.config).config,
    };
  } catch {
    return null;
  }
}

/**
 * Load + validate a library graph for `runMode === "custom"`.
 * Missing / invalid graphs fail loudly (no silent builtin fallback).
 */
export async function resolveCustomFsmGraphForTurn(
  composerFsmGraphId: string | null | undefined,
  load: (id: string) => Promise<GraphRecordInput | null> = getFsmGraph,
): Promise<{ id: string; config: FSMGraphConfig }> {
  const id =
    typeof composerFsmGraphId === "string" ? composerFsmGraphId.trim() : "";
  if (!id) {
    throw new Error(
      "Custom graphs mode requires a saved FSM graph. Pick one in the composer menu.",
    );
  }
  const record = await load(id);
  if (!record) {
    throw new Error(`Custom FSM graph not found: ${id}`);
  }
  if (record.enabled === false) {
    throw new Error(
      `FSM graph "${record.name}" is disabled — enable it in the Graphs editor first.`,
    );
  }
  let config: FSMGraphConfig;
  try {
    config = validateGraphConfig(record.config);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Custom FSM graph is invalid: ${message}`);
  }
  return { id, config };
}

export function createNewGraphRecord(
  name: string,
  opts?: { origin?: FsmGraphOrigin },
): FsmGraphLibraryRecord {
  const now = Date.now();
  const origin = normalizeGraphOrigin(opts?.origin);
  return {
    id: randomUUID(),
    name: name.trim() || "Untitled graph",
    createdAt: now,
    updatedAt: now,
    config: createDefaultGraphConfig(),
    origin,
    enabled: origin === "user",
    color: FSM_GRAPH_COLORS.default,
  };
}

export function listBuiltinTemplates(): FsmBuiltinTemplate[] {
  return [...FSM_BUILTIN_TEMPLATES];
}

export function createForkFromBuiltin(
  mode: BuiltinGraphMode,
  name?: string,
): FsmGraphLibraryRecord {
  const template = FSM_BUILTIN_TEMPLATES.find((t) => t.mode === mode);
  const now = Date.now();
  return {
    id: randomUUID(),
    name: name?.trim() || `${template?.label ?? mode} (fork)`,
    createdAt: now,
    updatedAt: now,
    config: structuredClone(graphConfigForMode(mode)),
    origin: "user",
    enabled: true,
    // Fork inherits the source mode color (Auto/Subagent have none → default).
    color: forkColorForMode(mode),
  };
}

/** Shared write path: load once, validate current config, then persist it. */
async function persistGraph(
  next: GraphRecordInput,
): Promise<FsmGraphLibraryRecord> {
  const migratedConfig = validateGraphConfig(next.config);
  const now = Date.now();
  const { color: rawColor, ...rest } = next;
  const color = normalizeFsmGraphColor(rawColor);
  const stored: FsmGraphLibraryRecord = {
    ...rest,
    name: next.name.trim(),
    config: migratedConfig,
    updatedAt: now,
    createdAt:
      typeof next.createdAt === "number" && next.createdAt > 0
        ? next.createdAt
        : now,
    ...(color ? { color } : {}),
  };
  await ensureRoot();
  await writeFile(
    graphFilePath(stored.id),
    `${JSON.stringify(stored, null, 2)}\n`,
    "utf8",
  );
  const index = await readIndex();
  const entry: FsmGraphLibraryEntry = {
    id: stored.id,
    name: stored.name,
    updatedAt: stored.updatedAt,
    origin: stored.origin,
    enabled: stored.enabled,
    ...(color ? { color } : {}),
  };
  const graphs = index.graphs.filter((g) => g.id !== stored.id);
  graphs.push(entry);
  await writeIndex({ version: 1, graphs });
  return stored;
}

/**
 * Create or update a library graph. `origin`/`enabled` are owned by the
 * library: updates preserve the stored values (client-supplied ones are
 * ignored — only setFsmGraphEnabled flips `enabled`), while new records
 * derive `enabled` from the provided origin ("llm" → disabled until the
 * user enables it in the Graphs editor).
 */
export async function saveFsmGraph(
  input: unknown,
): Promise<FsmGraphLibraryRecord> {
  const record = assertRecord(input);
  assertNotBuiltinGraph(record.id, "edited");
  const existing = await getFsmGraph(record.id);
  const origin = existing
    ? existing.origin
    : normalizeGraphOrigin(record.origin);
  const enabled = existing ? existing.enabled : origin === "llm" ? false : true;
  return persistGraph({ ...record, origin, enabled });
}

/**
 * User-only enable/disable (UI IPC path; the fsm_graph tool has no enable
 * action). Enabling re-validates the stored config; returns null when the id
 * is unknown and the unchanged record when state already matches. Disable-
 * side session detach is the caller's responsibility (IPC guard).
 */
export async function setFsmGraphEnabled(
  id: string,
  enabled: boolean,
): Promise<FsmGraphLibraryRecord | null> {
  assertNotBuiltinGraph(id, enabled ? "enabled" : "disabled");
  const record = await getFsmGraph(id.trim());
  if (!record) return null;
  if (record.enabled === enabled) return record;
  if (enabled) {
    validateGraphConfig(record.config);
  }
  return persistGraph({ ...record, enabled });
}

export async function deleteFsmGraph(id: string): Promise<void> {
  const trimmed = id.trim();
  if (!trimmed) return;
  assertNotBuiltinGraph(trimmed, "deleted");
  await rm(graphFilePath(trimmed), { force: true });
  const index = await readIndex();
  await writeIndex({
    version: 1,
    graphs: index.graphs.filter((g) => g.id !== trimmed),
  });
}

