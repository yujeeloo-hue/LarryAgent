import { mcpManager } from "../mcp/manager.js";
import type { JsonObject, ToolExecuteResult } from "../tools/types.js";
import { ToolReturnCode } from "../session/returnCodes.js";
import { textResult } from "../tools/pathUtil.js";
import { findUproject } from "./uproject.js";
import { listUnrealEditors } from "./editorBinding.js";
import {
  UNREAL_EDITOR_FIND_REFERENCES_TOOL,
  UNREAL_EDITOR_OPEN_TOOL,
  UNREAL_EDITOR_SELECT_CAPABILITY,
  UNREAL_EDITOR_SELECT_TOOL,
  chooseUnrealEditor,
  parseUnrealEditorFindReferences,
  parseUnrealEditorOpen,
  parseUnrealEditorSelect,
  projectFileKey,
  readUnrealEditorOpenQuery,
  readUnrealEditorSymbolQuery,
  type UnrealEditorBinding,
  type UnrealEditorFindReferences,
  type UnrealEditorOpenError,
  type UnrealEditorOpenResult,
  type UnrealEditorReference,
  type UnrealEditorSelectError,
  type UnrealEditorSymbolQuery,
} from "./editorProtocol.js";
import type {
  UnrealBlueprintOpenResult,
  UnrealBlueprintOpenTarget,
  UnrealBlueprintReferencesResult,
  UnrealBlueprintSelectResult,
  UnrealBlueprintSelectTarget,
  UnrealBlueprintSymbol,
} from "../shared/unrealBlueprintReferences.js";

export type UnrealEditorCaller = (
  serverId: string,
  toolName: string,
  args: JsonObject,
  signal?: AbortSignal,
) => Promise<ToolExecuteResult>;

export type UnrealEditorClientDeps = {
  locateProjectFile: (workspacePath: string) => string | null;
  bindings: readonly UnrealEditorBinding[];
  call: UnrealEditorCaller;
};

export function productionUnrealEditorDeps(): UnrealEditorClientDeps {
  return {
    locateProjectFile: (workspacePath) => findUproject(workspacePath)?.uproject ?? null,
    bindings: listUnrealEditors(),
    call: (serverId, toolName, args, signal) =>
      mcpManager.callTool(serverId, toolName, args, signal),
  };
}

export function findUnrealEditorReferences(
  workspacePath: string,
  args: JsonObject,
  signal?: AbortSignal,
): Promise<ToolExecuteResult> {
  return runUnrealEditorFindReferences(
    productionUnrealEditorDeps(),
    workspacePath,
    args,
    signal,
  );
}

export function openUnrealEditorAsset(
  workspacePath: string,
  args: JsonObject,
  signal?: AbortSignal,
): Promise<ToolExecuteResult> {
  return runUnrealEditorOpen(productionUnrealEditorDeps(), workspacePath, args, signal);
}

export async function runUnrealEditorFindReferences(
  deps: UnrealEditorClientDeps,
  workspacePath: string,
  args: JsonObject,
  signal?: AbortSignal,
): Promise<ToolExecuteResult> {
  const query = readUnrealEditorSymbolQuery(args);
  if (!query.ok) return textResult(query.message, ToolReturnCode.InvalidArguments);
  const session = resolveSession(deps, workspacePath);
  if (session.kind !== "ready") return session.result;

  const result = await deps.call(
    session.binding.serverId,
    UNREAL_EDITOR_FIND_REFERENCES_TOOL,
    symbolPayload(query.query),
    signal,
  );
  if (result.returnCode !== ToolReturnCode.Success) return result;
  const parsed = parseUnrealEditorFindReferences(toolResultText(result));
  if (!parsed) return invalidResponse(result);
  return textResult(formatFindReferences(query.query, parsed), ToolReturnCode.Success);
}

export async function runUnrealEditorOpen(
  deps: UnrealEditorClientDeps,
  workspacePath: string,
  args: JsonObject,
  signal?: AbortSignal,
): Promise<ToolExecuteResult> {
  const query = readUnrealEditorOpenQuery(args);
  if (!query.ok) return textResult(query.message, ToolReturnCode.InvalidArguments);
  const session = resolveSession(deps, workspacePath);
  if (session.kind !== "ready") return session.result;

  const payload: JsonObject = { assetPath: query.query.assetPath };
  if (query.query.graphGuid) payload.graphGuid = query.query.graphGuid;
  if (query.query.nodeGuid) payload.nodeGuid = query.query.nodeGuid;

  const result = await deps.call(
    session.binding.serverId,
    UNREAL_EDITOR_OPEN_TOOL,
    payload,
    signal,
  );
  if (result.returnCode !== ToolReturnCode.Success) return result;
  const parsed = parseUnrealEditorOpen(toolResultText(result));
  if (!parsed) return invalidResponse(result);
  return textResult(formatOpen(parsed), openReturnCode(parsed));
}

const BLUEPRINT_LOOKUP_LIMIT = 200;

export function lookupUnrealBlueprintReferences(
  workspacePath: string,
  symbol: UnrealBlueprintSymbol,
  signal?: AbortSignal,
): Promise<UnrealBlueprintReferencesResult> {
  return runUnrealBlueprintLookup(productionUnrealEditorDeps(), workspacePath, symbol, signal);
}

export function openUnrealBlueprintReference(
  workspacePath: string,
  target: UnrealBlueprintOpenTarget,
  signal?: AbortSignal,
): Promise<UnrealBlueprintOpenResult> {
  return runUnrealBlueprintOpen(productionUnrealEditorDeps(), workspacePath, target, signal);
}

export function selectUnrealBlueprintAsset(
  workspacePath: string,
  target: UnrealBlueprintSelectTarget,
  signal?: AbortSignal,
): Promise<UnrealBlueprintSelectResult> {
  return runUnrealBlueprintSelect(productionUnrealEditorDeps(), workspacePath, target, signal);
}

export async function runUnrealBlueprintLookup(
  deps: UnrealEditorClientDeps,
  workspacePath: string,
  symbol: UnrealBlueprintSymbol,
  signal?: AbortSignal,
): Promise<UnrealBlueprintReferencesResult> {
  const session = findSession(deps, workspacePath);
  if (session.kind === "none") return { status: "unavailable" };
  if (session.kind === "not_ready") return { status: "not_ready" };
  const query = readUnrealEditorSymbolQuery({ ...symbol, limit: BLUEPRINT_LOOKUP_LIMIT });
  if (!query.ok) return { status: "failed", message: query.message };
  try {
    const result = await deps.call(
      session.binding.serverId,
      UNREAL_EDITOR_FIND_REFERENCES_TOOL,
      symbolPayload(query.query),
      signal,
    );
    if (result.returnCode !== ToolReturnCode.Success) {
      return { status: "failed", message: toolResultText(result).trim() || "Unreal Editor request failed." };
    }
    const parsed = parseUnrealEditorFindReferences(toolResultText(result));
    if (!parsed) return { status: "failed", message: "Unreal Editor returned an invalid response." };
    return {
      status: "ok",
      complete: parsed.complete,
      references: parsed.references.slice(0, BLUEPRINT_LOOKUP_LIMIT),
    };
  } catch (err) {
    return { status: "failed", message: err instanceof Error ? err.message : String(err) };
  }
}

export async function runUnrealBlueprintOpen(
  deps: UnrealEditorClientDeps,
  workspacePath: string,
  target: UnrealBlueprintOpenTarget,
  signal?: AbortSignal,
): Promise<UnrealBlueprintOpenResult> {
  const query = readUnrealEditorOpenQuery({ ...target });
  if (!query.ok) return { ok: false, message: query.message };
  const session = findSession(deps, workspacePath);
  if (session.kind === "none") {
    return { ok: false, message: "Unreal Editor is not connected to this project." };
  }
  if (session.kind === "not_ready") return { ok: false, message: "Unreal Editor is not ready yet." };
  const payload: JsonObject = { assetPath: query.query.assetPath };
  if (query.query.graphGuid) payload.graphGuid = query.query.graphGuid;
  if (query.query.nodeGuid) payload.nodeGuid = query.query.nodeGuid;
  try {
    const result = await deps.call(session.binding.serverId, UNREAL_EDITOR_OPEN_TOOL, payload, signal);
    if (result.returnCode !== ToolReturnCode.Success) {
      return { ok: false, message: toolResultText(result).trim() || "Unreal Editor could not open the asset." };
    }
    const parsed = parseUnrealEditorOpen(toolResultText(result));
    if (!parsed) return { ok: false, message: "Unreal Editor returned an invalid response." };
    if (parsed.opened) return { ok: true };
    return { ok: false, message: openErrorMessage(parsed.error) };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export async function runUnrealBlueprintSelect(
  deps: UnrealEditorClientDeps,
  workspacePath: string,
  target: UnrealBlueprintSelectTarget,
  signal?: AbortSignal,
): Promise<UnrealBlueprintSelectResult> {
  const query = readUnrealEditorOpenQuery({ assetPath: target.assetPath });
  if (!query.ok) return { status: "failed", message: query.message };
  const session = findSession(deps, workspacePath);
  if (session.kind === "none") return { status: "unavailable" };
  if (session.kind === "not_ready") {
    return { status: "failed", message: "Unreal Editor is not ready yet." };
  }
  if (!session.binding.capabilities.includes(UNREAL_EDITOR_SELECT_CAPABILITY)) {
    return { status: "unsupported" };
  }
  try {
    const result = await deps.call(
      session.binding.serverId,
      UNREAL_EDITOR_SELECT_TOOL,
      { assetPath: query.query.assetPath },
      signal,
    );
    if (result.returnCode !== ToolReturnCode.Success) {
      return {
        status: "failed",
        message: toolResultText(result).trim() || "Unreal Editor could not select this asset.",
      };
    }
    const parsed = parseUnrealEditorSelect(toolResultText(result));
    if (!parsed) return { status: "failed", message: "Unreal Editor returned an invalid response." };
    if (parsed.selected) return { status: "ok" };
    return { status: "failed", message: selectErrorMessage(parsed.error) };
  } catch (err) {
    return { status: "failed", message: err instanceof Error ? err.message : String(err) };
  }
}

function openErrorMessage(error: UnrealEditorOpenError | undefined): string {
  if (error === "not_found") return "Unreal Editor could not find this asset.";
  if (error === "invalid_target") return "The Blueprint graph or node no longer exists.";
  return "Unreal Editor cannot open this reference.";
}

function selectErrorMessage(error: UnrealEditorSelectError | undefined): string {
  if (error === "not_found") return "Unreal Editor could not find this asset.";
  return "Unreal Editor cannot select this asset.";
}

function symbolPayload(query: UnrealEditorSymbolQuery): JsonObject {
  const payload: JsonObject = {
    kind: query.kind,
    className: query.className,
    limit: query.limit,
  };
  if (query.name) payload.name = query.name;
  if (query.module) payload.module = query.module;
  return payload;
}

type EditorSession =
  | { kind: "none"; detail: string }
  | { kind: "not_ready"; binding: UnrealEditorBinding }
  | { kind: "ready"; binding: UnrealEditorBinding };

function findSession(deps: UnrealEditorClientDeps, workspacePath: string): EditorSession {
  const root = workspacePath.trim();
  if (!root) return { kind: "none", detail: "This session has no workspace path." };
  const projectFile = deps.locateProjectFile(root);
  if (!projectFile) return { kind: "none", detail: "This workspace has no Unreal project file." };
  const binding = chooseUnrealEditor(deps.bindings, projectFileKey(projectFile));
  if (!binding) {
    return {
      kind: "none",
      detail: `No Unreal Editor session matches ${displaySlash(projectFile)}. Blueprint results were not queried.`,
    };
  }
  return binding.ready ? { kind: "ready", binding } : { kind: "not_ready", binding };
}

function resolveSession(
  deps: UnrealEditorClientDeps,
  workspacePath: string,
):
  | { kind: "ready"; binding: UnrealEditorBinding }
  | { kind: "stop"; result: ToolExecuteResult } {
  const session = findSession(deps, workspacePath);
  if (session.kind === "none") return { kind: "stop", result: notConnected(session.detail) };
  if (session.kind === "not_ready") {
    return {
      kind: "stop",
      result: textResult(
        `unreal-editor: not_ready\nUnreal Editor is connected for ${displaySlash(session.binding.projectFile)} but is not ready. Blueprint results were not queried.`,
        ToolReturnCode.GenericFailure,
      ),
    };
  }
  return session;
}

function notConnected(detail: string): ToolExecuteResult {
  return textResult(
    `unreal-editor: not_connected\n${detail}`,
    ToolReturnCode.NotFound,
  );
}

function formatFindReferences(
  query: UnrealEditorSymbolQuery,
  parsed: UnrealEditorFindReferences,
): string {
  const symbol = formatSymbol(query);
  const partial = parsed.complete
    ? ""
    : " Index is still building. This list is partial.";
  const skipped = parsed.skipped > 0 ? ` skipped=${parsed.skipped}` : "";
  const lines = [
    `unreal-editor: ${parsed.indexState} complete=${parsed.complete} hits=${parsed.references.length}${skipped}`,
    symbol + partial,
  ];
  for (const reference of parsed.references.slice(0, query.limit)) {
    lines.push(formatReference(reference));
  }
  if (parsed.references.length > query.limit) {
    lines.push(`truncated: showing first ${query.limit}`);
  }
  return lines.join("\n");
}

function formatSymbol(query: UnrealEditorSymbolQuery): string {
  const owner = query.module ? `${query.module}.` : "";
  if (query.kind === "function") return `function ${owner}${query.className}.${query.name ?? ""}`;
  return `class ${owner}${query.className}`;
}

function formatReference(reference: UnrealEditorReference): string {
  const parts = [reference.kind, `asset=${reference.assetPath}`];
  if (reference.graph) parts.push(`graph=${reference.graph}`);
  if (reference.graphGuid) parts.push(`graphGuid=${reference.graphGuid}`);
  if (reference.nodeClass) parts.push(`node=${reference.nodeClass}`);
  if (reference.nodeGuid) parts.push(`nodeGuid=${reference.nodeGuid}`);
  if (reference.nodeTitle) parts.push(`title=${reference.nodeTitle}`);
  return parts.join(" ");
}

function formatOpen(parsed: UnrealEditorOpenResult): string {
  if (parsed.opened) {
    return `unreal-editor: opened focus=${parsed.focus} asset=${parsed.assetPath}`;
  }
  return `unreal-editor: opened=false error=${parsed.error} asset=${parsed.assetPath}`;
}

function openReturnCode(parsed: UnrealEditorOpenResult): number {
  if (parsed.opened) return ToolReturnCode.Success;
  return openErrorCode(parsed.error);
}

function openErrorCode(error: UnrealEditorOpenError | undefined): number {
  if (error === "not_found") return ToolReturnCode.NotFound;
  if (error === "invalid_target") return ToolReturnCode.InvalidArguments;
  return ToolReturnCode.GenericFailure;
}

function invalidResponse(result: ToolExecuteResult): ToolExecuteResult {
  const body = toolResultText(result).trim();
  const clipped = body.length > 500 ? `${body.slice(0, 500)}…` : body;
  return textResult(
    clipped
      ? `unreal-editor: invalid response\n${clipped}`
      : "unreal-editor: invalid response",
    ToolReturnCode.GenericFailure,
  );
}

export function toolResultText(result: ToolExecuteResult): string {
  return result.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter((text) => text.length > 0)
    .join("\n");
}

function displaySlash(filePath: string): string {
  return filePath.replaceAll("\\", "/");
}
