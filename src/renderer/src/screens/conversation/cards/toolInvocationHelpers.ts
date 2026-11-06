import { Check, LoaderCircle, X } from "lucide";
import { createLucideIcon } from "../../../ui/originalIcons.js";
import { isShellToolName } from "../../../state/shellToolName.js";
import type { AgentFlashRange, AgentReadRange } from "../../../devmode/agentFlash.js";
import type { PlanProgressDisplay } from "../planSnapshots.js";
import type { SubagentStatusKind } from "./toolInvocationTypes.js";
import {
  patchChangedRangesFromText,
  patchHeaderPathFromText,
  patchHeaderPathsFromText,
} from "./parsePartialWriteArgs.js";

export function summarizeArgs(args: unknown): string {
  if (args === null || args === undefined) return "";
  if (typeof args !== "object") return String(args);
  const entries = Object.entries(args as Record<string, unknown>);
  if (entries.length === 0) return "{}";
  const parts = entries.slice(0, 3).map(([key, value]) => {
    if (key === "content" || key === "old_string" || key === "new_string") {
      const raw = typeof value === "string" ? value : JSON.stringify(value);
      const lines = raw.split(/\r?\n/).length;
      return `${key}=(${lines} line${lines === 1 ? "" : "s"})`;
    }
    const raw =
      typeof value === "string"
        ? value
        : value === null
          ? "null"
          : JSON.stringify(value);
    const clipped = raw.length > 40 ? `${raw.slice(0, 37)}…` : raw;
    return `${key}=${clipped}`;
  });
  const more = entries.length > 3 ? ` +${entries.length - 3}` : "";
  return parts.join(", ") + more;
}

export function statusLabel(status: string): string {
  switch (status) {
    case "pending":
      return "Executing tool…";
    case "running":
      return "Executing tool…";
    case "done":
      return "Success";
    case "error":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    default:
      return status || "Unknown";
  }
}

export function returnCodeLabel(code: number): string {
  switch (code) {
    case 0:
      return "Success";
    case 1:
      return "Failed";
    case 2:
      return "Permission denied";
    case 3:
      return "Not found";
    case 4:
      return "Timeout";
    case 5:
      return "Invalid arguments";
    case 6:
      return "Cancelled";
    default:
      return `Code ${code}`;
  }
}

export function buildFailureTip(returnCode: number, textParts: string[]): string {
  const detail = textParts.join("\n").trim();
  const label = returnCodeLabel(returnCode);
  if (!detail) return label;
  if (detail === label) return detail;
  return `${label}: ${detail}`;
}

export function pathFromArgs(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const path = (args as Record<string, unknown>).path;
  return typeof path === "string" ? path : undefined;
}

export function contentFromArgs(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const content = (args as Record<string, unknown>).content;
  return typeof content === "string" ? content : undefined;
}

export function planDocTitleFromArgs(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const title = (args as Record<string, unknown>).title;
  return typeof title === "string" && title.trim() ? title.trim() : undefined;
}

/**
 * Display path for a streaming/finished plan doc card. Mirrors
 * slugifyPlanDocTitle in src/session/planDoc.ts (renderer-safe, no node:path;
 * date prefix is added at write time and omitted here on purpose).
 */
export function planDocPathHintFromTitle(title: string | undefined): string {
  const slug = (title ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `docs/plans/${slug || "plan"}.md`;
}

export function isWriteFileTool(name: string): boolean {
  return name === "write_file" || name === "append_file";
}

export function isEditFileTool(name: string): boolean {
  return name === "edit_file";
}

export function isPatchTool(name: string): boolean {
  return name === "patch";
}

export function isPlanDocTool(name: string): boolean {
  return name === "write_plan_doc";
}

/** V4A / legacy GNU patch body from tool args (streaming preview source). */
export function patchTextFromArgs(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const rec = args as Record<string, unknown>;
  if (typeof rec.patch === "string") return rec.patch;
  if (typeof rec.patch_text === "string") return rec.patch_text;
  return undefined;
}

/**
 * Every file a working-tree write tool call (write_file / patch, replace
 * or V4A mode) will touch: the `path` arg plus all V4A Update/Add headers.
 * Order preserved, deduped. Empty for non-write args / unparseable bodies.
 */
export function writeToolFilePaths(args: unknown): string[] {
  if (!args || typeof args !== "object") return [];
  const record = args as Record<string, unknown>;
  const paths: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (trimmed && !paths.includes(trimmed)) paths.push(trimmed);
  };
  push(record.path);
  const patchText = patchTextFromArgs(record);
  if (patchText) {
    for (const header of patchHeaderPathsFromText(patchText)) push(header);
  }
  return paths;
}

/** One file of a write tool's open-and-flash plan (Dev Mode auto-open). */
export type AgentWriteFilePlan = {
  path: string;
  /** Changed-line flash ranges (patch hunks); empty = open without flash. */
  ranges: AgentFlashRange[];
};

/**
 * Dev Mode open-and-flash plan for a working-tree write: V4A patch bodies
 * map each touched file to its changed-line ranges (new-file side); replace
 * mode (plain `path` arg) opens without a flash. Legacy GNU bodies without
 * V4A headers fall back to the `path` arg, matching writeToolFilePaths.
 */
export function writeToolFilePlan(args: unknown): AgentWriteFilePlan[] {
  if (!args || typeof args !== "object") return [];
  const record = args as Record<string, unknown>;
  const patchText = patchTextFromArgs(record);
  if (patchText) {
    const plan = patchChangedRangesFromText(patchText);
    const seen = new Set<string>();
    const merged: AgentWriteFilePlan[] = [];
    for (const file of plan) {
      if (seen.has(file.path)) continue;
      seen.add(file.path);
      merged.push({ path: file.path, ranges: file.ranges });
    }
    if (merged.length > 0) return merged;
  }
  const path = typeof record.path === "string" ? record.path.trim() : "";
  return path ? [{ path, ranges: [] }] : [];
}

/**
 * read_file span for the Dev Mode open-and-flash: `offset`/`limit` args →
 * the exact lines; anything missing flashes through EOF (whole-file read).
 */
export function readRangeFromArgs(args: unknown): AgentReadRange {
  const record =
    args !== null && typeof args === "object"
      ? (args as Record<string, unknown>)
      : {};
  const positiveInt = (value: unknown): number | null => {
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : null;
  };
  const offset = positiveInt(record.offset) ?? 1;
  const limit = positiveInt(record.limit);
  return { start: offset, end: limit === null ? null : offset + limit - 1 };
}

/** First `Patching|Creating|Deleting|Moving file <path>` line of a patch result. */
export function patchPathHintFromResultText(resultText: string): string | undefined {
  const match = resultText.match(
    /^(?:Patching|Creating|Deleting|Moving) file (.+?)(?:\s+->\s+.+)?$/m,
  );
  const path = match?.[1]?.trim();
  return path && path.length > 0 ? path : undefined;
}

/** Number of per-file report lines in a patch result (multi-file V4A). */
export function patchFileCountFromResultText(resultText: string): number {
  return [
    ...resultText.matchAll(/^(?:Patching|Creating|Deleting|Moving) file .+$/gm),
  ].length;
}

export function isAskUserTool(name: string): boolean {
  return name === "ask_user" || name === "request_full_permissions";
}

export function isDemoTool(name: string): boolean {
  return name === "present_demo";
}

/**
 * Deferred `tool_call` bridge invocations carry the real tool name inside
 * arguments (`{ name, arguments }`) — the transcript part name stays
 * `tool_call`. Unwrap so cards render as the inner tool (e.g. upload_files
 * progress card, sleep countdown). Direct invocations pass through.
 */
export function unwrapToolCallBridge(
  name: string,
  args: unknown,
): { name: string; arguments: unknown } {
  if (name !== "tool_call") return { name, arguments: args };
  if (args !== null && typeof args === "object" && !Array.isArray(args)) {
    const record = args as Record<string, unknown>;
    const inner = record.name;
    const innerArgs = record.arguments;
    if (
      typeof inner === "string" &&
      inner.length > 0 &&
      innerArgs !== null &&
      typeof innerArgs === "object" &&
      !Array.isArray(innerArgs)
    ) {
      return { name: inner, arguments: innerArgs };
    }
  }
  return { name, arguments: args };
}

export function isReadFileTool(name: string): boolean {
  return name === "read_file";
}

/**
 * Full-width expandable cards: file writes/edits, plan doc writes, and
 * interactive ask panels. Everything else is a compact ≤520px
 * non-expandable status row.
 */
export function isCocoBackgroundTool(name: string): boolean {
  return ["coco_job_input", "read_coco_context", "submit_coco_result"].includes(name);
}
export function isRichToolCard(name: string): boolean {
  return (
    isCocoBackgroundTool(name) ||
    isWriteFileTool(name) ||
    isEditFileTool(name) ||
    isPatchTool(name) ||
    isPlanDocTool(name) ||
    isAskUserTool(name) ||
    isDemoTool(name)
  );
}

/** Basename only — no parent directories. */
export function fileBasenameFromPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  const base = slash >= 0 ? normalized.slice(slash + 1) : normalized;
  return base.trim() || path.trim() || "file";
}

/**
 * Compact read_file hint: `name.ts · 12–50 · 39 lines` (or whole-file line count).
 */
export function readFileCardHint(
  args: unknown,
  resultText: string,
): string {
  const path = pathFromArgs(args);
  const name = path ? fileBasenameFromPath(path) : "file";
  const ranged = resultText.match(/^Lines\s+(\d+)-(\d+)\s+of\s+(\d+)/m);
  if (ranged) {
    const start = Number(ranged[1]);
    const end = Number(ranged[2]);
    const count = Math.max(0, end - start + 1);
    return `${name} · ${start}–${end} · ${count} line${count === 1 ? "" : "s"}`;
  }
  const beyond = resultText.match(
    /Lines none \(offset \d+ beyond end; file has (\d+) lines?\)/m,
  );
  if (beyond) {
    const total = Number(beyond[1]);
    return `${name} · 0 lines (beyond EOF · ${total} total)`;
  }
  // Whole-file read: count newlines in the returned body (ignore truncation footer).
  const body = resultText.replace(/\n\n\[Truncated:[\s\S]*$/, "");
  const lines = body.length === 0 ? 0 : body.split(/\r?\n/).length;
  return `${name} · ${lines} line${lines === 1 ? "" : "s"}`;
}

export function questionFromArgs(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const record = args as Record<string, unknown>;
  const question = record.question;
  if (typeof question === "string" && question.trim()) {
    return question.trim();
  }
  const reason = record.reason;
  if (typeof reason === "string" && reason.trim()) {
    return reason.trim();
  }
  return undefined;
}

export function isReadSkillTool(name: string): boolean {
  return name === "read_skill";
}

export function isSearchToolsTool(name: string): boolean {
  return name === "search_tools";
}

export function isSearchSkillsTool(name: string): boolean {
  return name === "search_skills";
}

/** Keywords from search_tools `query` arg. */
export function searchToolsQueryFromArgs(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const query = (args as Record<string, unknown>).query;
  if (typeof query === "string" && query.trim()) {
    return query.trim();
  }
  return undefined;
}

export function isReadUserMemoryTool(name: string): boolean {
  return name === "read_user_memory" || name === "read_project_memory";
}

export function isSubagentTool(name: string): boolean {
  return (
    name === "dispatch_subagent" ||
    name === "await_subagent" ||
    name === "get_subagent_status" ||
    name === "list_subagents" ||
    name === "stop_subagent" ||
    name === "subagent_batch_result"
  );
}

export function isPlanProgressTool(name: string): boolean {
  return name === "update_plan" || name === "complete_plan";
}

function clipHint(text: string, max = 64): string {
  const one = text.replace(/\s+/g, " ").trim();
  if (one.length <= max) return one;
  return `${one.slice(0, max - 1)}…`;
}

function argStringHint(args: unknown, key: string): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * One-line card hint: necessary args / result only — never repeats the tool name.
 * Returns undefined when the title already carries the param (skill / search_tools).
 */
export function toolCardHint(input: {
  name: string;
  arguments: unknown;
  resultText?: string;
}): string | undefined {
  const { name, arguments: args } = input;
  const resultText = input.resultText ?? "";

  if (isAskUserTool(name)) return undefined;
  if (isReadSkillTool(name) || isSearchToolsTool(name) || isSearchSkillsTool(name)) {
    return undefined;
  }
  if (isSubagentTool(name) || isPlanProgressTool(name)) return undefined;

  if (isReadFileTool(name)) {
    return readFileCardHint(args, resultText);
  }

  if (isShellToolName(name)) {
    const command = argStringHint(args, "command");
    return command ? clipHint(command, 56) : undefined;
  }

  if (name === "grep") {
    const pattern = argStringHint(args, "pattern");
    const scope = argStringHint(args, "path");
    if (!pattern) return undefined;
    if (scope) {
      return clipHint(`"${pattern}" in ${fileBasenameFromPath(scope)}`, 56);
    }
    return clipHint(`"${pattern}"`, 56);
  }

  if (name === "batch_search") {
    const queries =
      args &&
      typeof args === "object" &&
      Array.isArray((args as { queries?: unknown }).queries)
        ? (args as { queries: unknown[] }).queries.length
        : 0;
    return queries > 0
      ? `${queries} ${queries === 1 ? "query" : "queries"}`
      : undefined;
  }

  if (name === "list_dir") {
    const path = pathFromArgs(args);
    return path ? fileBasenameFromPath(path) || path : undefined;
  }

  if (isWriteFileTool(name) || isEditFileTool(name)) {
    const path = pathFromArgs(args);
    return path ? fileBasenameFromPath(path) : undefined;
  }

  if (isPatchTool(name)) {
    const fromResult = patchPathHintFromResultText(resultText);
    if (fromResult) {
      const count = patchFileCountFromResultText(resultText);
      if (count > 1) return `${count} files`;
      return fileBasenameFromPath(fromResult);
    }
    const path = pathFromArgs(args);
    if (path) return fileBasenameFromPath(path);
    const patchText = patchTextFromArgs(args);
    if (patchText) {
      const header = patchHeaderPathFromText(patchText);
      if (header) return fileBasenameFromPath(header);
    }
    return undefined;
  }

  if (isPlanDocTool(name)) {
    const title = planDocTitleFromArgs(args);
    return title ? clipHint(title, 56) : undefined;
  }

  if (name === "get_workspace_path") {
    const line = resultText.trim().split(/\r?\n/)[0]?.trim();
    return line ? clipHint(line, 56) : undefined;
  }

  if (name === "get_current_time") {
    const iso = resultText.match(/\d{4}-\d{2}-\d{2}T[^\s]+/);
    return iso?.[0];
  }

  if (name === "read_image" || name === "convert_to_pdf") {
    const path = pathFromArgs(args);
    return path ? fileBasenameFromPath(path) : undefined;
  }

  // Generic: prefer path / name / query args — never executionSummary prose.
  const path = pathFromArgs(args);
  if (path) return fileBasenameFromPath(path);

  const named =
    argStringHint(args, "name") ??
    argStringHint(args, "query") ??
    argStringHint(args, "title") ??
    argStringHint(args, "app_name") ??
    argStringHint(args, "prompt");
  if (named) return clipHint(named, 56);

  const summary = summarizeArgs(args);
  if (!summary || summary === "{}") return undefined;
  return clipHint(summary, 56);
}

export function skillRefFromArgs(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const raw = args as Record<string, unknown>;
  if (typeof raw.name === "string" && raw.name.trim()) {
    return raw.name.trim();
  }
  if (typeof raw.id === "string" && raw.id.trim()) {
    return raw.id.trim();
  }
  return undefined;
}

export function planProgressTitleFromArgs(name: string, args: unknown): string {
  if (name === "complete_plan") {
    return "Plan";
  }

  if (!args || typeof args !== "object") return "Plan";
  const steps = (args as Record<string, unknown>).steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    const title = (args as Record<string, unknown>).title;
    if (typeof title === "string" && title.trim()) {
      return `Plan → ${title.trim()}`;
    }
    return "Plan";
  }

  for (const raw of steps) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    const id = typeof entry.id === "string" ? entry.id : "";
    const stepTitle =
      typeof entry.title === "string" && entry.title.trim()
        ? entry.title.trim()
        : id;
    if (stepTitle) return `Plan → ${stepTitle}`;
  }

  return "Plan";
}

export function planProgressKindFromArgs(
  name: string,
  args: unknown,
): PlanProgressDisplay["kind"] {
  if (name === "complete_plan") {
    if (args && typeof args === "object") {
      const status = (args as Record<string, unknown>).status;
      if (status === "cancelled") return "cancelled";
    }
    return "completed";
  }
  if (!args || typeof args !== "object") return "updated";
  const steps = (args as Record<string, unknown>).steps;
  if (!Array.isArray(steps)) return "updated";
  for (const raw of steps) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const status = (raw as Record<string, unknown>).status;
    if (status === "in_progress") return "in_progress";
    if (status === "completed") return "completed";
    if (status === "cancelled") return "cancelled";
  }
  return "updated";
}

export function createSubagentStatusIcon(
  kind: SubagentStatusKind,
): SVGElement | null {
  if (kind === "completed") {
    const el = createLucideIcon(Check, { size: 14, strokeWidth: 2.25 });
    // Dormant until armed by the live finished-card swap (see
    // armLiveOutcomeFade) — history renders keep the success mark hidden.
    el.classList.add(
      "content-card-subagent-status-icon",
      "is-completed",
      "is-dormant",
    );
    el.dataset.statusKind = "completed";
    return el;
  }
  if (kind === "running" || kind === "queued") {
    const el = createLucideIcon(LoaderCircle, { size: 14 });
    el.classList.add("content-card-subagent-status-icon", "is-in-progress");
    el.dataset.statusKind = "in-progress";
    return el;
  }
  if (kind === "error" || kind === "cancelled") {
    const el = createLucideIcon(X, { size: 14 });
    el.classList.add("content-card-subagent-status-icon", "is-cancelled");
    el.dataset.statusKind = "cancelled";
    return el;
  }
  return null;
}

/** Visual bucket for spinner/check/x — used to avoid restarting CSS spin. */
export function subagentStatusVisualKind(
  kind: SubagentStatusKind,
): "completed" | "in-progress" | "cancelled" {
  if (kind === "completed") return "completed";
  if (kind === "error" || kind === "cancelled") return "cancelled";
  return "in-progress";
}

export function createPlanProgressStatusIcon(
  kind: PlanProgressDisplay["kind"],
): SVGElement | null {
  if (kind === "completed") {
    const el = createLucideIcon(Check, { size: 14, strokeWidth: 2.25 });
    el.classList.add("content-card-plan-tool-status-icon", "is-completed");
    return el;
  }
  if (kind === "in_progress") {
    const el = createLucideIcon(LoaderCircle, { size: 14 });
    el.classList.add("content-card-plan-tool-status-icon", "is-in-progress");
    return el;
  }
  if (kind === "cancelled") {
    const el = createLucideIcon(X, { size: 14 });
    el.classList.add("content-card-plan-tool-status-icon", "is-cancelled");
    return el;
  }
  return null;
}
