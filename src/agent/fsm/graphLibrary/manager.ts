import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createDefaultActionRegistry } from "../actions/createDefaultActionRegistry.js";
import { loadGraphConfig } from "../compatibility/loadGraphConfig.js";
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
import { analyzeGraph, graphFingerprint } from "../authoring/diagnostics.js";

const INDEX_FILE = "index.json";

type GraphIndex = {
  version: 1;
  graphs: FsmGraphLibraryEntry[];
};

type GraphRecordInput = Omit<FsmGraphLibraryRecord, "config"> & { config: unknown };

let graphsRoot: string | null = null;

export function configureFsmGraphsRoot(root: string): void {
  graphsRoot = root;
}

export function requireFsmGraphsRoot(): string {
  if (!graphsRoot) {
    throw new Error("FSM graphs root is not configured");
  }
  return graphsRoot;
}

const requireRoot = requireFsmGraphsRoot;
let libraryQueue: Promise<unknown> = Promise.resolve();
export async function withGraphLibraryLock<T>(work: () => Promise<T>): Promise<T> {
  const next = libraryQueue.then(work, work);
  libraryQueue = next.catch(() => {});
  return next;
}

export function graphRecordRevision(record: FsmGraphLibraryRecord): string {
  return graphFingerprint({ name: record.name, description: record.description, config: record.config, color: record.color, nodeLayout: record.nodeLayout, enabled: record.enabled, updatedAt: record.updatedAt });
}

function graphFilePath(id: string): string {
  if (id === "index" || !/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("Invalid graph id");
  return join(requireRoot(), `${id}.json`);
}

async function ensureRoot(): Promise<void> {
  await mkdir(requireRoot(), { recursive: true });
}

function normalizeGraphOrigin(origin: unknown): FsmGraphOrigin {
  return origin === "llm" ? "llm" : "user";
}

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
  }
  return { version: 1, graphs: [] };
}

async function writeIndex(index: GraphIndex): Promise<void> {
  await ensureRoot();
  await writeJson(join(requireRoot(), INDEX_FILE), index);
}

async function writeJson(target: string, value: unknown): Promise<void> {
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
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
  const validation = analyzeGraph(config);
  if (!validation.valid) throw Object.assign(new Error(validation.issues.filter(i => i.severity === "error").map(i => `${i.path}: ${i.message}`).join("\n")), { code: "INVALID_GRAPH", validation });
  return config;
}

export function listActionCatalog(): FsmActionCatalogEntry[] {
  return createDefaultActionRegistry().listActionCatalog();
}

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
  const entries = await Promise.all(index.graphs.map(async entry => {
    const record = await getFsmGraph(entry.id);
    const validation = record?.validation ?? analyzeGraph(null);
    return { ...entry, enabled: entry.enabled && !!record?.enabled && validation.valid, validation };
  }));
  return entries.sort((a, b) => b.updatedAt - a.updatedAt);
}

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
  const config = structuredClone(graphConfigForMode(entry.mode));
  const validation = analyzeGraph(config);
  return {
    id,
    name: entry.name,
    createdAt: 0,
    updatedAt: 0,
    config,
    validation,
    origin: "user",
    enabled: validation.valid,
    color: forkColorForMode(entry.mode),
  };
}

export async function listComposerGraphs(): Promise<FsmGraphLibraryEntry[]> {
  const builtins = COMPOSER_BUILTIN_GRAPHS.map((g): FsmGraphLibraryEntry => ({
    id: builtinGraphId(g.mode),
    name: g.name,
    updatedAt: 0,
    origin: "user",
    enabled: true,
    validation: analyzeGraph(graphConfigForMode(g.mode)),
    color: forkColorForMode(g.mode),
  }));
  const library = (await listFsmGraphs()).filter((g) => g.enabled && g.validation?.valid);
  return [...builtins.filter(g => g.validation?.valid), ...library];
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
    const config = loadGraphConfig(record.config).config;
    const validation = analyzeGraph(config);
    return {
      ...rest,
      origin,
      enabled: enabled && validation.valid,
      validation,
      ...(color ? { color } : {}),
      config,
    };
  } catch {
    return null;
  }
}

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
  let config: FSMGraphConfig;
  try {
    config = validateGraphConfig(record.config);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Custom FSM graph is invalid: ${message}`);
  }
  if (record.enabled === false) {
    throw new Error(
      `FSM graph "${record.name}" is disabled — enable it in the Graphs editor first.`,
    );
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
    color: forkColorForMode(mode),
  };
}

async function persistGraph(
  next: GraphRecordInput,
): Promise<FsmGraphLibraryRecord> {
  const migratedConfig = loadGraphConfig(next.config).config;
  const validation = analyzeGraph(migratedConfig);
  const now = Date.now();
  const { color: rawColor, ...rest } = next;
  const color = normalizeFsmGraphColor(rawColor);
  const stored: FsmGraphLibraryRecord = {
    ...rest,
    name: next.name.trim(),
    config: migratedConfig,
    updatedAt: Math.max(now, (typeof next.updatedAt === "number" ? next.updatedAt : 0) + 1),
    enabled: next.enabled && validation.valid,
    validation,
    createdAt:
      typeof next.createdAt === "number" && next.createdAt > 0
        ? next.createdAt
        : now,
    ...(color ? { color } : {}),
  };
  await ensureRoot();
  await writeJson(graphFilePath(stored.id), stored);
  const index = await readIndex();
  const entry: FsmGraphLibraryEntry = {
    id: stored.id,
    name: stored.name,
    updatedAt: stored.updatedAt,
    origin: stored.origin,
    enabled: stored.enabled,
    validation,
    ...(color ? { color } : {}),
  };
  const graphs = index.graphs.filter((g) => g.id !== stored.id);
  graphs.push(entry);
  await writeIndex({ version: 1, graphs });
  return stored;
}

export async function saveFsmGraph(
  input: unknown,
  expectedRevision?: string | null,
): Promise<FsmGraphLibraryRecord> {
  return withGraphLibraryLock(async () => {
    const record = assertRecord(input);
    assertNotBuiltinGraph(record.id, "edited");
    const existing = await getFsmGraph(record.id);
    if (expectedRevision !== undefined && (existing ? graphRecordRevision(existing) : null) !== expectedRevision) throw Object.assign(new Error("The saved graph changed. Open a new context or reconcile changes before committing."), { code: "GRAPH_CONFLICT" });
    const origin = existing
      ? existing.origin
      : normalizeGraphOrigin(record.origin);
    const enabled = existing ? existing.enabled : origin === "llm" ? false : true;
    return persistGraph({ ...record, origin, enabled });
  });
}

export async function setFsmGraphEnabled(
  id: string,
  enabled: boolean,
): Promise<FsmGraphLibraryRecord | null> {
  return withGraphLibraryLock(async () => {
    assertNotBuiltinGraph(id, enabled ? "enabled" : "disabled");
    const record = await getFsmGraph(id.trim());
    if (!record) return null;
    if (enabled) {
      validateGraphConfig(record.config);
    }
    return persistGraph({ ...record, enabled });
  });
}

export async function deleteFsmGraph(id: string): Promise<void> {
  return withGraphLibraryLock(async () => {
    const trimmed = id.trim();
    if (!trimmed) return;
    assertNotBuiltinGraph(trimmed, "deleted");
    await rm(graphFilePath(trimmed), { force: true });
    const index = await readIndex();
    await writeIndex({
      version: 1,
      graphs: index.graphs.filter((g) => g.id !== trimmed),
  });
  });
}

