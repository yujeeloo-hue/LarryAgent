/**
 * loops — LLM interface for Loops (scheduled background agent turns).
 *
 * Full CRUD over the same LoopsService the Loops screen uses: create /
 * list / get (with run history) / update (patch-merge) / delete / runs.
 * The service is reached through ToolExecuteContext.loops (LoopsToolPort);
 * absent port = Loops unavailable (never installed / platform off).
 *
 * Refs: `id` accepts the loop id or its (unique) name — id wins.
 * Create defaults mirror the UI editor: runMode agent, provider "" (session
 * default), reasoningEffort low, fullPermissions false, enabled true; the
 * workspace defaults to the current session's workspace.
 */
import { ToolReturnCode } from "../../session/returnCodes.js";
import { isValidCadence } from "../../loops/schedule.js";
import type { JsonObject, ToolDefinition, ToolHandler } from "../types.js";
import { abortIfSignaled, failureResult, textResult } from "../pathUtil.js";
import {
  describeLoopLine,
  describeRunLine,
  formatLoopTimestamp,
  resolveLoopRef,
  type LoopViewLike,
  type LoopsToolPort,
} from "../loopsTool.js";

const CADENCE_DOC = `cadence (object, local timezone): {"kind":"minute","n":15} | {"kind":"hour","minute":30} | {"kind":"day","time":"09:00"} | {"kind":"week","weekdays":[1,3],"time":"09:00"} (0=Sun..6=Sat, ascending) | {"kind":"month","day":1,"time":"09:00"} | {"kind":"year","month":2,"day":14,"time":"09:00"}. time is strict HH:MM 24h.`;

export const loopsDefinition: ToolDefinition = {
  name: "loops",
  description:
    "Manage Loops — scheduled background agent turns that run a prompt on a cadence (the Loops screen shows the same records). Actions: list (all loops, compact), get (one loop's full config + recent runs), create (new loop; name + prompt + cadence required), update (patch fields on an existing loop), delete (remove a loop), runs (run history). " +
    CADENCE_DOC +
    " The id argument accepts the loop id or its unique name. Deleting is permanent but only removes the loop record (never session transcripts).",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "get", "create", "update", "delete", "runs"],
        description:
          "list = all loops; get = one loop + recent runs; create = new loop; update = patch fields; delete = remove; runs = run history.",
      },
      id: {
        type: "string",
        description:
          "Loop id or unique name (get/update/delete/runs; id wins over name).",
      },
      name: {
        type: "string",
        description:
          "create: loop display name. update: rename the loop.",
      },
      prompt: {
        type: "string",
        description:
          "The prompt each scheduled turn runs (create required; update overwrites).",
      },
      cadence: {
        type: "object",
        description: `create/update: schedule. ${CADENCE_DOC}`,
      },
      workspaceId: {
        type: "string",
        description:
          "Workspace the loop runs in. Defaults to the current session's workspace.",
      },
      runMode: {
        type: "string",
        enum: ["agent", "plan", "ask"],
        description: "Turn mode for scheduled runs. Default agent.",
      },
      providerId: {
        type: "string",
        description:
          'LLM provider id for scheduled turns. Default "" = session default provider.',
      },
      reasoningEffort: {
        type: "string",
        enum: ["off", "low", "medium", "high", "max"],
        description: "Reasoning dial for scheduled turns. Default low.",
      },
      fullPermissions: {
        type: "boolean",
        description:
          "Bypass permissions inside scheduled turns. Default false — set true only when the user asks.",
      },
      enabled: {
        type: "boolean",
        description:
          "create: start enabled (default true). update: enable / pause the loop.",
      },
      limit: {
        type: "number",
        description: "Max runs returned by get/runs. Default 5 (runs cap 50).",
      },
    },
    required: ["action"],
    additionalProperties: false,
  },
  defaultPermissionLevel: 1,
};

/** Level-1 gate note when the port is absent. */
const PORT_MISSING =
  "Loops is not available in this host (no loops service port). The Loops screen and daemon must be running.";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Non-empty string arg or null (empty string = invalid, not "absent"). */
function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function parseLimit(args: JsonObject, fallback: number, cap: number): number {
  const raw = args.limit;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 1) {
    return fallback;
  }
  return Math.min(Math.floor(raw), cap);
}

/** Validate a cadence arg locally for a better message than the db guard. */
function validCadenceOrError(value: unknown): string | null {
  if (value === undefined) return "cadence is required.";
  if (!isValidCadence(value)) {
    return `Invalid cadence — ${CADENCE_DOC}`;
  }
  return null;
}

function describeDetail(loop: LoopViewLike): string {
  const lines = [
    `Loop "${loop.name}" (${loop.id})`,
    `  cadence: ${loop.cadenceSummary}  (${loop.cadenceJson})`,
    `  workspace: ${loop.workspaceId}`,
    `  runMode: ${loop.runMode} · provider: ${loop.providerId || "(session default)"} · reasoning: ${loop.reasoningEffort}${loop.fullPermissions ? " · fullPermissions" : ""}`,
    `  enabled: ${loop.enabled} · next run: ${loop.enabled ? formatLoopTimestamp(loop.nextRunAt) : "paused"} · last run: ${formatLoopTimestamp(loop.lastRunAt)} · runs: ${loop.runCount}`,
    `  created: ${formatLoopTimestamp(loop.createdAt)} · updated: ${formatLoopTimestamp(loop.updatedAt)}`,
    `  prompt:`,
    ...loop.prompt.split("\n").map((line) => `    ${line}`),
  ];
  return lines.join("\n");
}

/** Resolve args.id against the port's list (id or unique name). */
function resolveRef(
  port: LoopsToolPort,
  args: JsonObject,
): { ok: true; loop: LoopViewLike } | { ok: false; message: string; code: number } {
  const ref = nonEmptyString(args.id);
  if (!ref) {
    return {
      ok: false,
      message: 'This action requires "id" (loop id or unique name).',
      code: ToolReturnCode.InvalidArguments,
    };
  }
  const resolved = resolveLoopRef(ref, port.list());
  if (!resolved.ok) {
    return { ok: false, message: resolved.message, code: ToolReturnCode.NotFound };
  }
  return { ok: true, loop: resolved.loop };
}

export const loopsHandler: ToolHandler = async (args, context) => {
  const aborted = abortIfSignaled(context.signal);
  if (aborted) return aborted;

  const port = context.loops;
  if (!port) return failureResult(PORT_MISSING, ToolReturnCode.GenericFailure);
  const action = typeof args.action === "string" ? args.action : "";

  // ------------------------------------------------------------- list
  if (action === "list") {
    const loops = port.list();
    if (loops.length === 0) {
      return textResult(
        "No loops exist yet. Create one with action=create (name + prompt + cadence required).",
        ToolReturnCode.Success,
      );
    }
    return textResult(
      `Loops (${loops.length}):\n${loops.map(describeLoopLine).join("\n")}`,
      ToolReturnCode.Success,
    );
  }

  // -------------------------------------------------------------- get
  if (action === "get") {
    const resolved = resolveRef(port, args);
    if (!resolved.ok) return failureResult(resolved.message, resolved.code);
    const limit = parseLimit(args, 5, 50);
    const runs = port.listRuns(resolved.loop.id, limit);
    const body =
      describeDetail(resolved.loop) +
      (runs.length > 0
        ? `\n  recent runs (latest ${runs.length}):\n${runs.map(describeRunLine).map((l) => `    ${l}`).join("\n")}`
        : "\n  recent runs: none yet");
    return textResult(body, ToolReturnCode.Success);
  }

  // ----------------------------------------------------------- create
  if (action === "create") {
    const name = nonEmptyString(args.name);
    if (!name) return failureResult('create requires "name".', ToolReturnCode.InvalidArguments);
    const prompt = nonEmptyString(args.prompt);
    if (!prompt) return failureResult('create requires "prompt".', ToolReturnCode.InvalidArguments);
    const cadenceError = validCadenceOrError(args.cadence);
    if (cadenceError) return failureResult(cadenceError, ToolReturnCode.InvalidArguments);
    const workspaceId = nonEmptyString(args.workspaceId) ?? context.workspaceId ?? "";
    if (!workspaceId) {
      return failureResult(
        'create requires "workspaceId" (no workspace is active in this session).',
        ToolReturnCode.InvalidArguments,
      );
    }
    const payload: Record<string, unknown> = {
      name,
      prompt,
      cadence: args.cadence,
      workspaceId,
      enabled: typeof args.enabled === "boolean" ? args.enabled : true,
    };
    if (typeof args.runMode === "string") payload.runMode = args.runMode;
    if (typeof args.providerId === "string") payload.providerId = args.providerId;
    if (typeof args.reasoningEffort === "string") payload.reasoningEffort = args.reasoningEffort;
    if (typeof args.fullPermissions === "boolean") payload.fullPermissions = args.fullPermissions;
    try {
      const created = port.create(payload);
      return textResult(
        `Created loop "${created.name}" (${created.id}) — ${created.cadenceSummary}, next run ${created.enabled ? formatLoopTimestamp(created.nextRunAt) : "paused"}.\nIt appears on the Loops screen; the scheduler picks it up automatically.`,
        ToolReturnCode.Success,
      );
    } catch (err) {
      return failureResult(
        err instanceof Error ? err.message : String(err),
        ToolReturnCode.InvalidArguments,
      );
    }
  }

  // ----------------------------------------------------------- update
  if (action === "update") {
    const resolved = resolveRef(port, args);
    if (!resolved.ok) return failureResult(resolved.message, resolved.code);
    const existing = resolved.loop;

    let cadence: unknown;
    let cadenceJson: string;
    if (args.cadence !== undefined) {
      const cadenceError = validCadenceOrError(args.cadence);
      if (cadenceError) return failureResult(cadenceError, ToolReturnCode.InvalidArguments);
      cadence = args.cadence;
      cadenceJson = JSON.stringify(args.cadence);
    } else {
      cadenceJson = existing.cadenceJson;
      try {
        cadence = JSON.parse(existing.cadenceJson);
      } catch {
        return failureResult(
          `Stored cadence is unreadable — re-send the full cadence object to repair it.`,
          ToolReturnCode.GenericFailure,
        );
      }
    }

    const name = args.name !== undefined ? nonEmptyString(args.name) : existing.name;
    if (name === null) {
      return failureResult('"name" must be a non-empty string.', ToolReturnCode.InvalidArguments);
    }
    const prompt = args.prompt !== undefined ? nonEmptyString(args.prompt) : existing.prompt;
    if (prompt === null) {
      return failureResult('"prompt" must be a non-empty string.', ToolReturnCode.InvalidArguments);
    }
    const workspaceId = nonEmptyString(args.workspaceId) ?? existing.workspaceId;
    const runMode =
      typeof args.runMode === "string" ? args.runMode : existing.runMode;
    const providerId =
      typeof args.providerId === "string" ? args.providerId : existing.providerId;
    const reasoningEffort =
      typeof args.reasoningEffort === "string"
        ? args.reasoningEffort
        : existing.reasoningEffort;
    const fullPermissions =
      typeof args.fullPermissions === "boolean"
        ? args.fullPermissions
        : existing.fullPermissions;
    const enabled =
      typeof args.enabled === "boolean" ? args.enabled : existing.enabled;

    const touched = [
      "name",
      "prompt",
      "cadence",
      "workspaceId",
      "runMode",
      "providerId",
      "reasoningEffort",
      "fullPermissions",
      "enabled",
    ].filter((key) => (args as Record<string, unknown>)[key] !== undefined);
    if (touched.length === 0) {
      return failureResult(
        'update needs at least one settable field (name/prompt/cadence/workspaceId/runMode/providerId/reasoningEffort/fullPermissions/enabled).',
        ToolReturnCode.InvalidArguments,
      );
    }

    try {
      const updated = port.update(existing.id, {
        name,
        prompt,
        cadence,
        workspaceId,
        runMode,
        providerId,
        reasoningEffort,
        fullPermissions,
        enabled,
      });
      if (!updated) {
        return failureResult(`Loop ${existing.id} disappeared during update.`, ToolReturnCode.NotFound);
      }
      return textResult(
        `Updated loop "${updated.name}" (${updated.id}) — changed: ${touched.join(", ")}.\nNow: ${updated.cadenceSummary}, ${updated.enabled ? `next run ${formatLoopTimestamp(updated.nextRunAt)}` : "paused"}.`,
        ToolReturnCode.Success,
      );
    } catch (err) {
      return failureResult(
        err instanceof Error ? err.message : String(err),
        ToolReturnCode.InvalidArguments,
      );
    }
  }

  // ----------------------------------------------------------- delete
  if (action === "delete") {
    const resolved = resolveRef(port, args);
    if (!resolved.ok) return failureResult(resolved.message, resolved.code);
    const { id, name, runCount } = resolved.loop;
    const ok = port.remove(id);
    if (!ok) {
      return failureResult(`Loop ${id} disappeared before delete.`, ToolReturnCode.NotFound);
    }
    return textResult(
      `Deleted loop "${name}" (${id}) — had ${runCount} run(s). Scheduled turns stop; past session transcripts are untouched.`,
      ToolReturnCode.Success,
    );
  }

  // ------------------------------------------------------------- runs
  if (action === "runs") {
    const resolved = resolveRef(port, args);
    if (!resolved.ok) return failureResult(resolved.message, resolved.code);
    const limit = parseLimit(args, 10, 50);
    const runs = port.listRuns(resolved.loop.id, limit);
    if (runs.length === 0) {
      return textResult(
        `Loop "${resolved.loop.name}" has never run (next: ${resolved.loop.enabled ? formatLoopTimestamp(resolved.loop.nextRunAt) : "paused"}).`,
        ToolReturnCode.Success,
      );
    }
    return textResult(
      `Runs for "${resolved.loop.name}" (latest ${runs.length}):\n${runs.map(describeRunLine).join("\n")}`,
      ToolReturnCode.Success,
    );
  }

  return failureResult(
    `action must be one of list|get|create|update|delete|runs (got ${JSON.stringify(action)}).`,
    ToolReturnCode.InvalidArguments,
  );
};
