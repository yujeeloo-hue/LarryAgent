import { posix, win32 } from "node:path";

export const UNREAL_EDITOR_PROTOCOL = "unreal-editor";
export const UNREAL_EDITOR_PROTOCOL_VERSION = 1;

export const UNREAL_EDITOR_CAPABILITIES_TOOL = "unreal_editor_capabilities";
export const UNREAL_EDITOR_FIND_REFERENCES_TOOL = "unreal_editor_find_references";
export const UNREAL_EDITOR_OPEN_TOOL = "unreal_editor_open";
export const UNREAL_EDITOR_SELECT_TOOL = "unreal_editor_select";
export const UNREAL_EDITOR_STATUS_NOTIFICATION = "notifications/unreal-editor/status";
export const UNREAL_EDITOR_STATUS_PUSH_CAPABILITY = "status_push";
export const UNREAL_EDITOR_SELECT_CAPABILITY = "select";

export const UNREAL_EDITOR_HEARTBEAT_DEFAULT_MS = 10_000;
const HEARTBEAT_MIN_MS = 1_000;
const HEARTBEAT_MAX_MS = 60_000;

export const UNREAL_EDITOR_PROTOCOL_TOOLS = [
  UNREAL_EDITOR_CAPABILITIES_TOOL,
  UNREAL_EDITOR_FIND_REFERENCES_TOOL,
  UNREAL_EDITOR_OPEN_TOOL,
  UNREAL_EDITOR_SELECT_TOOL,
] as const;

const REQUIRED_CAPABILITIES = ["references", "open"] as const;

const REFERENCE_KINDS = [
  "call",
  "event_override",
  "parent_class",
  "cast",
  "variable_type",
  "class_pin",
] as const;

const INDEX_STATES = ["ready", "warming", "unavailable"] as const;
const OPEN_FOCUS = ["node", "graph", "asset"] as const;
const OPEN_ERRORS = ["not_found", "unsupported", "invalid_target"] as const;
const SELECT_ERRORS = ["not_found", "unsupported"] as const;

const GUID_PATTERN = /^[0-9a-fA-F]{32}$/;

export type UnrealEditorReferenceKind = (typeof REFERENCE_KINDS)[number];
export type UnrealEditorIndexState = (typeof INDEX_STATES)[number];
export type UnrealEditorOpenFocus = (typeof OPEN_FOCUS)[number];
export type UnrealEditorOpenError = (typeof OPEN_ERRORS)[number];
export type UnrealEditorSelectError = (typeof SELECT_ERRORS)[number];

export type UnrealEditorCapabilities = {
  protocol: typeof UNREAL_EDITOR_PROTOCOL;
  protocolVersion: typeof UNREAL_EDITOR_PROTOCOL_VERSION;
  projectFile: string;
  engineVersion: string;
  ready: boolean;
  capabilities: string[];
};

export type UnrealEditorStatus = UnrealEditorCapabilities & {
  heartbeatIntervalMs: number;
  shuttingDown: boolean;
};

export type UnrealEditorPushDeclaration =
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "push"; status: UnrealEditorStatus };

export type UnrealEditorBindingSource = "push" | "probe";

export type UnrealEditorBinding = {
  serverId: string;
  projectFile: string;
  projectKey: string;
  engineVersion: string;
  ready: boolean;
  capabilities: string[];
  connectedAt: number;
  source: UnrealEditorBindingSource;
  lastSeenAt: number;
};

export type UnrealEditorReference = {
  kind: UnrealEditorReferenceKind;
  assetPath: string;
  graph?: string;
  graphGuid?: string;
  nodeClass?: string;
  nodeGuid?: string;
  nodeTitle?: string;
};

export type UnrealEditorFindReferences = {
  protocolVersion: typeof UNREAL_EDITOR_PROTOCOL_VERSION;
  indexState: UnrealEditorIndexState;
  complete: boolean;
  references: UnrealEditorReference[];
  skipped: number;
};

export type UnrealEditorOpenResult = {
  protocolVersion: typeof UNREAL_EDITOR_PROTOCOL_VERSION;
  opened: boolean;
  assetPath: string;
  focus?: UnrealEditorOpenFocus;
  error?: UnrealEditorOpenError;
};

export type UnrealEditorSelectResult = {
  protocolVersion: typeof UNREAL_EDITOR_PROTOCOL_VERSION;
  selected: boolean;
  assetPath: string;
  error?: UnrealEditorSelectError;
};

export type UnrealEditorSymbolQuery = {
  kind: "function" | "class";
  className: string;
  name?: string;
  module?: string;
  limit: number;
};

export type UnrealEditorOpenQuery = {
  assetPath: string;
  graphGuid?: string;
  nodeGuid?: string;
};

const FIND_LIMIT_DEFAULT = 100;
const FIND_LIMIT_MAX = 200;

export function projectFileKey(filePath: string): string {
  const trimmed = filePath.trim();
  if (!trimmed) return "";
  const slash = trimmed.replaceAll("\\", "/");
  if (/^[A-Za-z]:\//.test(slash)) {
    return win32.resolve(slash).replaceAll("\\", "/").toLowerCase();
  }
  if (slash.startsWith("/")) {
    const resolved = posix.resolve(slash);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  }
  const resolved = (process.platform === "win32" ? win32 : posix)
    .resolve(slash)
    .replaceAll("\\", "/");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function parseUnrealEditorCapabilities(
  text: string,
): UnrealEditorCapabilities | null {
  const value = parseJsonObject(text);
  return value ? readCapabilities(value) : null;
}

export function parseUnrealEditorStatus(value: unknown): UnrealEditorStatus | null {
  if (!isRecord(value)) return null;
  const capabilities = readCapabilities(value);
  if (!capabilities?.capabilities.includes(UNREAL_EDITOR_STATUS_PUSH_CAPABILITY)) {
    return null;
  }
  return {
    ...capabilities,
    heartbeatIntervalMs: readHeartbeat(value.heartbeatIntervalMs),
    shuttingDown: value.shuttingDown === true,
  };
}

export function parseUnrealEditorPushDeclaration(
  serverCapabilities: unknown,
): UnrealEditorPushDeclaration {
  if (!isRecord(serverCapabilities)) return { kind: "none" };
  const experimental = serverCapabilities.experimental;
  if (!isRecord(experimental) || !(UNREAL_EDITOR_PROTOCOL in experimental)) {
    return { kind: "none" };
  }
  const status = parseUnrealEditorStatus(experimental[UNREAL_EDITOR_PROTOCOL]);
  if (!status) return { kind: "invalid" };
  return { kind: "push", status: { ...status, shuttingDown: false } };
}

function readCapabilities(value: Record<string, unknown>): UnrealEditorCapabilities | null {
  if (value.protocol !== UNREAL_EDITOR_PROTOCOL) return null;
  if (value.protocolVersion !== UNREAL_EDITOR_PROTOCOL_VERSION) return null;
  if (typeof value.projectFile !== "string" || !value.projectFile.trim()) return null;
  if (typeof value.engineVersion !== "string") return null;
  if (typeof value.ready !== "boolean") return null;
  const capabilities = value.capabilities;
  if (!isStringArray(capabilities)) return null;
  if (!REQUIRED_CAPABILITIES.every((name) => capabilities.includes(name))) {
    return null;
  }
  return {
    protocol: UNREAL_EDITOR_PROTOCOL,
    protocolVersion: UNREAL_EDITOR_PROTOCOL_VERSION,
    projectFile: value.projectFile.trim(),
    engineVersion: value.engineVersion,
    ready: value.ready,
    capabilities,
  };
}

function readHeartbeat(value: unknown): number {
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= HEARTBEAT_MIN_MS &&
    value <= HEARTBEAT_MAX_MS
  ) {
    return value;
  }
  return UNREAL_EDITOR_HEARTBEAT_DEFAULT_MS;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function parseUnrealEditorFindReferences(
  text: string,
): UnrealEditorFindReferences | null {
  const value = parseJsonObject(text);
  if (!value) return null;
  if (value.protocolVersion !== UNREAL_EDITOR_PROTOCOL_VERSION) return null;
  if (!isIndexState(value.indexState)) return null;
  if (typeof value.complete !== "boolean") return null;
  if (!Array.isArray(value.references)) return null;
  const references: UnrealEditorReference[] = [];
  let skipped = 0;
  for (const item of value.references) {
    const reference = readReference(item);
    if (reference) references.push(reference);
    else skipped += 1;
  }
  return {
    protocolVersion: UNREAL_EDITOR_PROTOCOL_VERSION,
    indexState: value.indexState,
    complete: value.complete,
    references,
    skipped,
  };
}

export function parseUnrealEditorOpen(text: string): UnrealEditorOpenResult | null {
  const value = parseJsonObject(text);
  if (!value) return null;
  if (value.protocolVersion !== UNREAL_EDITOR_PROTOCOL_VERSION) return null;
  if (typeof value.opened !== "boolean") return null;
  if (typeof value.assetPath !== "string" || !isAssetPath(value.assetPath)) return null;
  if (value.opened) {
    if (!isOpenFocus(value.focus)) return null;
    return {
      protocolVersion: UNREAL_EDITOR_PROTOCOL_VERSION,
      opened: true,
      assetPath: value.assetPath,
      focus: value.focus,
    };
  }
  if (!isOpenError(value.error)) return null;
  return {
    protocolVersion: UNREAL_EDITOR_PROTOCOL_VERSION,
    opened: false,
    assetPath: value.assetPath,
    error: value.error,
  };
}

export function parseUnrealEditorSelect(text: string): UnrealEditorSelectResult | null {
  const value = parseJsonObject(text);
  if (!value) return null;
  if (value.protocolVersion !== UNREAL_EDITOR_PROTOCOL_VERSION) return null;
  if (typeof value.selected !== "boolean") return null;
  if (typeof value.assetPath !== "string" || !isAssetPath(value.assetPath)) return null;
  if (value.selected) {
    return {
      protocolVersion: UNREAL_EDITOR_PROTOCOL_VERSION,
      selected: true,
      assetPath: value.assetPath,
    };
  }
  if (!isSelectError(value.error)) return null;
  return {
    protocolVersion: UNREAL_EDITOR_PROTOCOL_VERSION,
    selected: false,
    assetPath: value.assetPath,
    error: value.error,
  };
}

export function hasUnrealEditorCapability(
  binding: UnrealEditorBinding,
  capability: string,
): boolean {
  return binding.capabilities.includes(capability);
}

export function readUnrealEditorSymbolQuery(
  args: Record<string, unknown>,
): { ok: true; query: UnrealEditorSymbolQuery } | { ok: false; message: string } {
  const kind = args.kind;
  if (kind !== "function" && kind !== "class") {
    return {
      ok: false,
      message: 'Invalid arguments: "kind" must be "function" or "class".',
    };
  }
  const className = readSymbolToken(args.className, "className");
  if (!className.ok) return className;
  const name = readOptionalSymbolToken(args.name, "name");
  if (!name.ok) return name;
  if (kind === "function" && !name.value) {
    return {
      ok: false,
      message: 'Invalid arguments: "name" is required when kind is "function".',
    };
  }
  const moduleName = readOptionalSymbolToken(args.module, "module");
  if (!moduleName.ok) return moduleName;
  const limit = readLimit(args.limit);
  if (!limit.ok) return limit;
  return {
    ok: true,
    query: {
      kind,
      className: className.value,
      ...(name.value ? { name: name.value } : {}),
      ...(moduleName.value ? { module: moduleName.value } : {}),
      limit: limit.value,
    },
  };
}

export function readUnrealEditorOpenQuery(
  args: Record<string, unknown>,
): { ok: true; query: UnrealEditorOpenQuery } | { ok: false; message: string } {
  const assetPath = typeof args.assetPath === "string" ? args.assetPath.trim() : "";
  if (!isAssetPath(assetPath)) {
    return {
      ok: false,
      message:
        'Invalid arguments: "assetPath" must be a soft object path such as /Game/Characters/BP_Hero.BP_Hero.',
    };
  }
  const graphGuid = readOptionalGuid(args.graphGuid, "graphGuid");
  if (!graphGuid.ok) return graphGuid;
  const nodeGuid = readOptionalGuid(args.nodeGuid, "nodeGuid");
  if (!nodeGuid.ok) return nodeGuid;
  return {
    ok: true,
    query: {
      assetPath,
      ...(graphGuid.value ? { graphGuid: graphGuid.value } : {}),
      ...(nodeGuid.value ? { nodeGuid: nodeGuid.value } : {}),
    },
  };
}

export function chooseUnrealEditor(
  bindings: readonly UnrealEditorBinding[],
  projectKey: string,
): UnrealEditorBinding | null {
  if (!projectKey) return null;
  let best: UnrealEditorBinding | null = null;
  for (const binding of bindings) {
    if (binding.projectKey !== projectKey) continue;
    if (!best) {
      best = binding;
      continue;
    }
    const readyRank = Number(binding.ready) - Number(best.ready);
    if (readyRank > 0 || (readyRank === 0 && binding.connectedAt >= best.connectedAt)) {
      best = binding;
    }
  }
  return best;
}

export function isUnrealEditorGuid(value: string): boolean {
  return GUID_PATTERN.test(value);
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim().replace(/^\uFEFF/, "");
  if (!trimmed) return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isIndexState(value: unknown): value is UnrealEditorIndexState {
  return typeof value === "string" && (INDEX_STATES as readonly string[]).includes(value);
}

function isOpenFocus(value: unknown): value is UnrealEditorOpenFocus {
  return typeof value === "string" && (OPEN_FOCUS as readonly string[]).includes(value);
}

function isOpenError(value: unknown): value is UnrealEditorOpenError {
  return typeof value === "string" && (OPEN_ERRORS as readonly string[]).includes(value);
}

function isSelectError(value: unknown): value is UnrealEditorSelectError {
  return typeof value === "string" && (SELECT_ERRORS as readonly string[]).includes(value);
}

function isReferenceKind(value: unknown): value is UnrealEditorReferenceKind {
  return typeof value === "string" && (REFERENCE_KINDS as readonly string[]).includes(value);
}

function isAssetPath(value: string): boolean {
  return value.startsWith("/") && value.includes(".") && value.length <= 512;
}

function readReference(value: unknown): UnrealEditorReference | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!isReferenceKind(record.kind)) return null;
  if (typeof record.assetPath !== "string" || !isAssetPath(record.assetPath.trim())) {
    return null;
  }
  const reference: UnrealEditorReference = {
    kind: record.kind,
    assetPath: record.assetPath.trim(),
  };
  const graph = optionalText(record.graph);
  const graphGuid = optionalGuid(record.graphGuid);
  const nodeClass = optionalText(record.nodeClass);
  const nodeGuid = optionalGuid(record.nodeGuid);
  const nodeTitle = optionalText(record.nodeTitle);
  if (graph) reference.graph = graph;
  if (graphGuid) reference.graphGuid = graphGuid;
  if (nodeClass) reference.nodeClass = nodeClass;
  if (nodeGuid) reference.nodeGuid = nodeGuid;
  if (nodeTitle) reference.nodeTitle = nodeTitle;
  return reference;
}

function optionalText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function optionalGuid(value: unknown): string | undefined {
  const text = optionalText(value);
  if (!text || !GUID_PATTERN.test(text)) return undefined;
  return text;
}

function readSymbolToken(
  value: unknown,
  field: string,
): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof value !== "string" || !value.trim()) {
    return { ok: false, message: `Invalid arguments: "${field}" is required.` };
  }
  const trimmed = value.trim();
  if (trimmed.length > 200 || /[\r\n]/.test(trimmed)) {
    return { ok: false, message: `Invalid arguments: "${field}" is not a symbol name.` };
  }
  return { ok: true, value: trimmed };
}

function readOptionalSymbolToken(
  value: unknown,
  field: string,
): { ok: true; value?: string } | { ok: false; message: string } {
  if (value === undefined || value === null || value === "") return { ok: true };
  return readSymbolToken(value, field);
}

function readLimit(
  value: unknown,
): { ok: true; value: number } | { ok: false; message: string } {
  if (value === undefined || value === null || value === "") {
    return { ok: true, value: FIND_LIMIT_DEFAULT };
  }
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isInteger(number) || number < 1 || number > FIND_LIMIT_MAX) {
    return {
      ok: false,
      message: `Invalid arguments: "limit" must be an integer from 1 to ${FIND_LIMIT_MAX}.`,
    };
  }
  return { ok: true, value: number };
}

function readOptionalGuid(
  value: unknown,
  field: string,
): { ok: true; value?: string } | { ok: false; message: string } {
  if (value === undefined || value === null || value === "") return { ok: true };
  if (typeof value !== "string" || !GUID_PATTERN.test(value.trim())) {
    return {
      ok: false,
      message: `Invalid arguments: "${field}" must be 32 hex characters without dashes.`,
    };
  }
  return { ok: true, value: value.trim() };
}
