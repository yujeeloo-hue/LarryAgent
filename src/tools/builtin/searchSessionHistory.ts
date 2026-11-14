import {
  clampSessionHistoryLimit,
  formatSessionHistoryArchiveRead,
  formatSessionHistoryHits,
  formatSessionHistoryRead,
  mergeSessionHistoryHits,
  parseTimeBound,
  readSessionHistory,
  readSessionHistoryArchive,
  searchSessionHistory,
  searchSessionHistoryArchive,
  type WorkspaceNameMap,
} from "../../agent/searchSessionHistory.js";
import type { Session } from "../../session/types.js";
import { ToolReturnCode } from "../../session/returnCodes.js";
import {
  abortIfSignaled,
  failureResult,
  textResult,
} from "../pathUtil.js";
import type { ToolDefinition, ToolHandler } from "../types.js";

/** Default level: 0 (read-only session history). */
export const searchSessionHistoryDefinition: ToolDefinition = {
  name: "search_session_history",
  description:
    "Search or read agent conversation history across all workspaces (default) or one workspace. " +
    'mode="search" (default): use query / after / before / limit / session_id / workspace / scope — do not send around_message_id, before_count, or after_count. ' +
    'scope="sessions" (default) searches live sessions; "history" searches summarized records of deleted sessions (archived work records); "all" merges both. ' +
    'mode="read": require around_message_id or session_id (optionally before_count / after_count / limit); do not send query / after / before / scope. ' +
    "Reading a deleted session's session_id returns its archived summary.",
  parameters: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["search", "read"],
        description:
          'search (default): keyword/time search. read: message window around around_message_id or for a session_id.',
      },
      query: {
        type: "string",
        description: "search only: keywords (AND; space/comma split).",
      },
      session_id: {
        type: "string",
        description:
          'Session id, or "current". search: optional scope. read: required when around_message_id is omitted.',
      },
      workspace: {
        type: "string",
        description:
          'Scope: "all" (default, all workspaces), "current", or a workspace name/id.',
      },
      scope: {
        type: "string",
        enum: ["sessions", "history", "all"],
        description:
          'search only: "sessions" (default, live sessions), "history" (summarized records of deleted sessions), or "all" (both merged, newest first).',
      },
      after: {
        type: "string",
        description: "search only: inclusive lower time bound (ISO or Unix ms).",
      },
      before: {
        type: "string",
        description: "search only: inclusive upper time bound (ISO or Unix ms).",
      },
      limit: {
        type: "number",
        description: "Max hits/messages (default 12, max 20).",
      },
      around_message_id: {
        type: "string",
        description: "read only: center window on this message id.",
      },
      before_count: {
        type: "number",
        description: "read only: messages before center (default 3, max 8).",
      },
      after_count: {
        type: "number",
        description: "read only: messages after center (default 3, max 8).",
      },
    },
    required: [],
  },
  defaultPermissionLevel: 0,
};

function resolveSessions(context: {
  listAgentSessions?: () => Session[];
}): Session[] {
  if (typeof context.listAgentSessions === "function") {
    return context.listAgentSessions();
  }
  return [];
}

/**
 * Resolve the `workspace` argument into a scope + label map.
 * Returns an error string when the argument names no known workspace.
 */
function resolveWorkspaceScope(
  raw: unknown,
  context: {
    workspaceId?: string;
    listWorkspaces?: () => { id: string; name: string }[];
  },
): { error: string } | { workspaceId: string; names: WorkspaceNameMap } {
  const workspaces = context.listWorkspaces?.() ?? [];
  const names: WorkspaceNameMap = new Map(
    workspaces.map((w) => [w.id, w.name]),
  );

  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed || trimmed.toLowerCase() === "all") {
    return { workspaceId: "", names };
  }
  if (trimmed.toLowerCase() === "current") {
    const current = context.workspaceId?.trim() ?? "";
    if (!current) {
      return { error: "Current session has no workspace bound." };
    }
    return { workspaceId: current, names };
  }

  const needle = trimmed.toLowerCase();
  const match = workspaces.find(
    (w) =>
      w.id === trimmed || w.name.trim().toLowerCase() === needle,
  );
  if (match) {
    return { workspaceId: match.id, names };
  }
  if (workspaces.length === 0) {
    // No workspace registry available: treat the raw string as an id.
    return { workspaceId: trimmed, names };
  }
  const available = workspaces
    .map((w) => `"${w.name}"`)
    .join(", ");
  return {
    error: `Unknown workspace "${trimmed}". Available: ${available}.`,
  };
}

export const searchSessionHistoryHandler: ToolHandler = async (
  args,
  context,
) => {
  const aborted = abortIfSignaled(context.signal);
  if (aborted) return aborted;

  const currentSessionId = context.sessionId?.trim() ?? "";
  if (!currentSessionId) {
    return failureResult(
      "No current session id; session history is unavailable.",
      ToolReturnCode.NotFound,
    );
  }

  const sessions = resolveSessions(context);
  const scopeRaw =
    typeof args.scope === "string" ? args.scope.trim().toLowerCase() : "";
  if (
    scopeRaw !== "" &&
    scopeRaw !== "sessions" &&
    scopeRaw !== "history" &&
    scopeRaw !== "all"
  ) {
    return failureResult(
      'Invalid arguments: scope must be "sessions", "history", or "all".',
      ToolReturnCode.InvalidArguments,
    );
  }
  const searchScope = scopeRaw || "sessions";

  if (sessions.length === 0 && searchScope === "sessions") {
    return failureResult(
      "Session store is unavailable for this turn.",
      ToolReturnCode.NotFound,
    );
  }
  const historyRecords =
    typeof context.listSessionHistory === "function"
      ? context.listSessionHistory()
      : [];

  const scope = resolveWorkspaceScope(args.workspace, context);
  if ("error" in scope) {
    return failureResult(
      `Invalid arguments: ${scope.error}`,
      ToolReturnCode.InvalidArguments,
    );
  }

  const modeRaw = typeof args.mode === "string" ? args.mode.trim() : "search";
  const mode = modeRaw === "read" ? "read" : "search";

  const sessionIdArg =
    typeof args.session_id === "string" && args.session_id.trim()
      ? args.session_id.trim()
      : undefined;

  if (mode === "search") {
    if (
      args.around_message_id !== undefined ||
      args.before_count !== undefined ||
      args.after_count !== undefined
    ) {
      return failureResult(
        'Invalid arguments: mode="search" does not accept around_message_id, before_count, or after_count (use mode="read").',
        ToolReturnCode.InvalidArguments,
      );
    }
  }

  if (mode === "read") {
    if (
      args.query !== undefined ||
      args.after !== undefined ||
      args.before !== undefined ||
      args.scope !== undefined
    ) {
      return failureResult(
        'Invalid arguments: mode="read" does not accept query, after, before, or scope (use mode="search").',
        ToolReturnCode.InvalidArguments,
      );
    }
    const around =
      typeof args.around_message_id === "string" && args.around_message_id.trim()
        ? args.around_message_id.trim()
        : undefined;
    if (!around && !sessionIdArg) {
      return failureResult(
        'Invalid arguments: mode="read" requires around_message_id or session_id.',
        ToolReturnCode.InvalidArguments,
      );
    }
    const result = readSessionHistory({
      sessions,
      currentSessionId,
      workspaceId: scope.workspaceId,
      workspaceNames: scope.names,
      ...(sessionIdArg ? { sessionId: sessionIdArg } : {}),
      ...(around ? { aroundMessageId: around } : {}),
      ...(typeof args.before_count === "number"
        ? { beforeCount: args.before_count }
        : {}),
      ...(typeof args.after_count === "number"
        ? { afterCount: args.after_count }
        : {}),
      ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
    });
    if (!result) {
      // Deleted session: fall back to its archived summary. Needs an
      // explicit session_id — an around_message_id window cannot exist.
      const archiveRead = sessionIdArg
        ? readSessionHistoryArchive({
            records: historyRecords,
            sessionId: sessionIdArg,
            workspaceNames: scope.names,
          })
        : null;
      if (archiveRead) {
        return textResult(
          formatSessionHistoryArchiveRead(archiveRead),
          ToolReturnCode.Success,
        );
      }
      return failureResult(
        around
          ? "Session or around_message_id not found in scope."
          : "Session not found in scope.",
        ToolReturnCode.NotFound,
      );
    }
    return textResult(formatSessionHistoryRead(result), ToolReturnCode.Success);
  }

  let afterMs: number | undefined;
  let beforeMs: number | undefined;
  if (args.after !== undefined && args.after !== null) {
    const parsed = parseTimeBound(args.after);
    if (parsed === null) {
      return failureResult(
        'Invalid arguments: "after" must be ISO-8601 or Unix ms.',
        ToolReturnCode.InvalidArguments,
      );
    }
    afterMs = parsed;
  }
  if (args.before !== undefined && args.before !== null) {
    const parsed = parseTimeBound(args.before);
    if (parsed === null) {
      return failureResult(
        'Invalid arguments: "before" must be ISO-8601 or Unix ms.',
        ToolReturnCode.InvalidArguments,
      );
    }
    beforeMs = parsed;
  }
  if (
    afterMs !== undefined &&
    beforeMs !== undefined &&
    afterMs > beforeMs
  ) {
    return failureResult(
      'Invalid arguments: "after" must be <= "before".',
      ToolReturnCode.InvalidArguments,
    );
  }

  const query =
    typeof args.query === "string" && args.query.trim()
      ? args.query.trim()
      : undefined;

  const limit = clampSessionHistoryLimit(
    typeof args.limit === "number" ? args.limit : undefined,
  );

  const sessionHits =
    searchScope === "history"
      ? []
      : searchSessionHistory({
          sessions,
          currentSessionId,
          workspaceId: scope.workspaceId,
          workspaceNames: scope.names,
          ...(query ? { query } : {}),
          ...(sessionIdArg ? { sessionId: sessionIdArg } : {}),
          ...(afterMs !== undefined ? { afterMs } : {}),
          ...(beforeMs !== undefined ? { beforeMs } : {}),
          limit,
        });

  const archiveHits =
    searchScope === "sessions"
      ? []
      : searchSessionHistoryArchive({
          records: historyRecords,
          workspaceId: scope.workspaceId,
          workspaceNames: scope.names,
          ...(query ? { query } : {}),
          ...(sessionIdArg ? { sessionId: sessionIdArg } : {}),
          ...(afterMs !== undefined ? { afterMs } : {}),
          ...(beforeMs !== undefined ? { beforeMs } : {}),
          limit,
        });

  const hits =
    searchScope === "all"
      ? mergeSessionHistoryHits(sessionHits, archiveHits, limit)
      : searchScope === "history"
        ? archiveHits
        : sessionHits;

  return textResult(formatSessionHistoryHits(hits), ToolReturnCode.Success);
};
