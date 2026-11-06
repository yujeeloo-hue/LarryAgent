import type { SessionDatabase } from "./openDb.js";
import { parseSessionPlanJson } from "../plan.js";
import { parseSessionPlanDocJson } from "../planDoc.js";
import { parsePhase } from "../phase.js";
import {
  getSessionPhase,
  mergeLegacyPhaseColumnIntoBlackboard,
  SESSION_PHASE_BLACKBOARD_KEY,
} from "../sessionPhase.js";
import { parseSessionPendingUserAsk } from "../pendingUserAsk.js";
import { isReasoningEffort, type ReasoningEffort } from "../../llm/reasoningEffort.js";
import type {
  Message,
  MessageRole,
  Session,
  SessionContextBuckets,
  SessionSource,
  SessionStatus,
  SessionType,
} from "../types.js";
import { isSessionSource } from "../types.js";
import {
  parseStoredMessageParts,
  serializeStoredMessageParts,
} from "./sanitizeMessageParts.js";

type SessionRow = {
  id: string;
  type: string;
  source?: string;
  title: string;
  created_at: number;
  updated_at: number;
  status: string;
  progress_text: string;
  model: string;
  provider_id: string;
  workspace_id: string;
  workspace_path: string;
  pinned: number;
  archived: number;
  archived_at: number | null;
  context_usage: string;
  plan: string | null;
  plan_doc: string | null;
  phase: string | null;
  pending_user_ask: string | null;
  run_mode: string | null;
  infinite: number | null;
  reasoning_max: number | null;
  reasoning_effort: string | null;
  fsm_last_graph_mode: string | null;
  fsm_last_node_id: string | null;
  fsm_last_node_at: number | null;
  fsm_graph_id: string | null;
  fsm_last_graph_id: string | null;
  fsm_blackboard: string | null;
  handoff_enabled: number | null;
};

type MessageRow = {
  id: string;
  session_id: string;
  role: string;
  created_at: number;
  tool_call_id: string | null;
  parts: string;
  position: number;
};

function rowToMessage(row: MessageRow): Message {
  const parts = parseStoredMessageParts(row.parts);
  const role = row.role as MessageRole;
  const base = {
    id: row.id,
    parts,
    createdAt: row.created_at,
  };

  if (role === "tool") {
    if (!row.tool_call_id) {
      throw new Error(`Tool message ${row.id} missing tool_call_id`);
    }
    return { ...base, role: "tool", toolCallId: row.tool_call_id };
  }

  if (role === "assistant") {
    if (row.tool_call_id) {
      return { ...base, role: "assistant", toolCallId: row.tool_call_id };
    }
    return { ...base, role: "assistant" };
  }

  if (role === "user") {
    return { ...base, role: "user" };
  }

  return { ...base, role: "system" };
}

function rowToSession(row: SessionRow, messages: Message[]): Session {
  const usageRaw: unknown = JSON.parse(row.context_usage);
  const usageObj =
    typeof usageRaw === "object" && usageRaw !== null
      ? (usageRaw as Record<string, unknown>)
      : null;
  const usedTokens =
    usageObj && typeof usageObj.usedTokens === "number"
      ? usageObj.usedTokens
      : 0;
  const displayUsedTokens =
    usageObj && typeof usageObj.displayUsedTokens === "number"
      ? usageObj.displayUsedTokens
      : undefined;
  const cachedTokens =
    usageObj && typeof usageObj.cachedTokens === "number"
      ? usageObj.cachedTokens
      : undefined;
  const source =
    usageObj &&
    (usageObj.source === "provider" || usageObj.source === "estimate")
      ? usageObj.source
      : undefined;
  const requestEstimateTokens =
    usageObj && typeof usageObj.requestEstimateTokens === "number"
      ? usageObj.requestEstimateTokens
      : undefined;

  let contextBuckets: SessionContextBuckets | undefined;
  const bucketsRaw = usageObj?.buckets;
  if (bucketsRaw && typeof bucketsRaw === "object" && !Array.isArray(bucketsRaw)) {
    const b = bucketsRaw as Record<string, unknown>;
    if (
      typeof b.hotTurnCount === "number" &&
      typeof b.hot === "number" &&
      typeof b.cold === "number" &&
      typeof b.updatedAt === "number"
    ) {
      contextBuckets = {
        hotTurnCount: b.hotTurnCount,
        warmTurnCount: 0,
        hot: b.hot,
        warm: 0,
        cold: b.cold,
        updatedAt: b.updatedAt,
      };
    }
  }

  return {
    id: row.id,
    type: row.type as SessionType,
    // Only surface non-default origins — plain app sessions stay unchanged.
    ...(isSessionSource(row.source) && row.source !== "app"
      ? { source: row.source as SessionSource }
      : {}),
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    status: row.status as SessionStatus,
    progressText: row.progress_text,
    messages,
    model: row.model,
    providerId: row.provider_id ?? "",
    workspaceId: row.workspace_id ?? "",
    workspacePath: row.workspace_path,
    pinned: row.pinned === 1,
    archived: row.archived === 1,
    archivedAt: row.archived_at,
    contextUsage: {
      usedTokens,
      ...(displayUsedTokens !== undefined ? { displayUsedTokens } : {}),
      ...(cachedTokens !== undefined ? { cachedTokens } : {}),
      ...(source !== undefined ? { source } : {}),
      ...(requestEstimateTokens !== undefined ? { requestEstimateTokens } : {}),
    },
    ...(contextBuckets ? { contextBuckets } : {}),
    plan: parseSessionPlanJson(row.plan),
    planDoc: (() => {
      const doc = parseSessionPlanDocJson(row.plan_doc);
      // Legacy rows: review phase + plan doc → treat as awaiting Approve.
      if (
        doc &&
        doc.approvalPending !== true &&
        parsePhase(row.phase) === "review"
      ) {
        return { ...doc, approvalPending: true };
      }
      return doc;
    })(),
    pendingUserAsk: parseSessionPendingUserAsk(row.pending_user_ask),
    composerRunMode:
      row.run_mode === "agent" ||
      row.run_mode === "ask" ||
      row.run_mode === "plan" ||
      row.run_mode === "custom"
        ? row.run_mode
        : null,
    composerFsmGraphId:
      typeof row.fsm_graph_id === "string" && row.fsm_graph_id.trim()
        ? row.fsm_graph_id.trim()
        : null,
    composerInfinite: row.infinite === null ? null : row.infinite === 1,
    reasoningEffort: parseRowReasoningEffort(row),
    fsmLastGraphMode:
      row.fsm_last_graph_mode === "react" ||
      row.fsm_last_graph_mode === "ask" ||
      row.fsm_last_graph_mode === "plan_execute" ||
      row.fsm_last_graph_mode === "subagent"
        ? row.fsm_last_graph_mode
        : null,
    fsmLastGraphId:
      typeof row.fsm_last_graph_id === "string" && row.fsm_last_graph_id.trim()
        ? row.fsm_last_graph_id.trim()
        : null,
    fsmLastNodeId: row.fsm_last_node_id,
    fsmLastNodeAt: row.fsm_last_node_at,
    ...(() => {
      const fsmBlackboard = mergeLegacyPhaseColumnIntoBlackboard(
        parseFsmBlackboard(row.fsm_blackboard),
        row.phase,
      );
      return {
        fsmBlackboard,
        // Mirror for legacy readers / upsert column until column is dropped.
        phase: getSessionPhase({ fsmBlackboard, phase: parsePhase(row.phase) }),
      };
    })(),
    handoffEnabled:
      row.handoff_enabled === null ? null : row.handoff_enabled === 1,
  };
}

/**
 * Reasoning-effort dial level from the row (schema v21). Falls back to the
 * legacy reasoning_max boolean for pre-v21 rows; NULL stays NULL (= follow
 * the settings.json default).
 */
function parseRowReasoningEffort(row: {
  reasoning_effort: string | null;
  reasoning_max: number | null;
}): ReasoningEffort | null {
  if (isReasoningEffort(row.reasoning_effort)) return row.reasoning_effort;
  if (row.reasoning_max === 1) return "max";
  if (row.reasoning_max === 0) return "low";
  return null;
}

/** Parse the fsm_blackboard JSON blob; malformed → null (self-heals on next write). */
function parseFsmBlackboard(
  raw: string | null,
): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Boot-load session rows WITHOUT messages (lazy hydration). Message arrays
 * are empty; callers hydrate on demand via loadSessionMessages.
 */
export function loadSessionRows(db: SessionDatabase): Session[] {
  const sessionRows = db
    .prepare(
      `SELECT id, type, source, title, created_at, updated_at, status, progress_text,
              model, provider_id, workspace_id, workspace_path, pinned, archived, archived_at,
              context_usage, plan, plan_doc, phase, pending_user_ask,
              run_mode, infinite, reasoning_max, reasoning_effort,
              fsm_last_graph_mode, fsm_last_node_id, fsm_last_node_at,
              fsm_graph_id, fsm_last_graph_id, fsm_blackboard, handoff_enabled
       FROM sessions
       ORDER BY updated_at DESC`,
    )
    .all() as SessionRow[];
  return sessionRows.map((row) => rowToSession(row, []));
}

/** Hydrate one session's messages (position order). */
export function loadSessionMessages(
  db: SessionDatabase,
  sessionId: string,
): Message[] {
  const rows = db
    .prepare(
      `SELECT id, session_id, role, created_at, tool_call_id, parts, position
       FROM messages
       WHERE session_id = ?
       ORDER BY position ASC`,
    )
    .all(sessionId) as MessageRow[];
  return rows.map((row) => rowToMessage(row));
}

/**
 * Upsert the session row only (metadata persists for lazily-loaded sessions:
 * messages are untouched in the DB, which stays authoritative while the
 * in-memory array is empty).
 */
export function upsertSessionRow(db: SessionDatabase, session: Session): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    upsertSessionRowInner(db, session);
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // ignore rollback errors
    }
    throw err;
  }
}

/** Session-row upsert shared by upsertSession / upsertSessionRow. */
function upsertSessionRowInner(db: SessionDatabase, session: Session): void {
  db.prepare(
    `INSERT INTO sessions (
       id, type, source, title, created_at, updated_at, status, progress_text,
       model, provider_id, workspace_id, workspace_path, pinned, archived, archived_at,
       context_usage, plan, plan_doc, phase, pending_user_ask,
       run_mode, infinite, reasoning_max, reasoning_effort,
       fsm_last_graph_mode, fsm_last_node_id, fsm_last_node_at,
       fsm_graph_id, fsm_last_graph_id, fsm_blackboard, handoff_enabled
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       type = excluded.type,
       source = excluded.source,
       title = excluded.title,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at,
       status = excluded.status,
       progress_text = excluded.progress_text,
       model = excluded.model,
       provider_id = excluded.provider_id,
       workspace_id = excluded.workspace_id,
       workspace_path = excluded.workspace_path,
       pinned = excluded.pinned,
       archived = excluded.archived,
       archived_at = excluded.archived_at,
       context_usage = excluded.context_usage,
       plan = excluded.plan,
       plan_doc = excluded.plan_doc,
       phase = excluded.phase,
       pending_user_ask = excluded.pending_user_ask,
       -- Unlike composer prefs (preserved by dedicated updateComposerPrefs),
       -- FSM last-state always rides the in-memory session: every upsert of
       -- the same session carries the current telemetry values.
       fsm_last_graph_mode = excluded.fsm_last_graph_mode,
       fsm_last_node_id = excluded.fsm_last_node_id,
       fsm_last_node_at = excluded.fsm_last_node_at,
       fsm_last_graph_id = excluded.fsm_last_graph_id,
       fsm_blackboard = excluded.fsm_blackboard`,
  ).run(
    session.id,
    session.type,
    session.source ?? "app",
    session.title,
    session.createdAt,
    session.updatedAt,
    session.status,
    session.progressText,
    session.model,
    session.providerId,
    session.workspaceId,
    session.workspacePath,
    session.pinned ? 1 : 0,
    session.archived ? 1 : 0,
    session.archived ? session.archivedAt : null,
    JSON.stringify({
      ...session.contextUsage,
      ...(session.contextBuckets
        ? { buckets: session.contextBuckets }
        : {}),
    }),
    session.plan ? JSON.stringify(session.plan) : null,
    session.planDoc ? JSON.stringify(session.planDoc) : null,
    getSessionPhase(session),
    session.pendingUserAsk ? JSON.stringify(session.pendingUserAsk) : null,
    session.composerRunMode ?? null,
    session.composerInfinite === null || session.composerInfinite === undefined
      ? null
      : session.composerInfinite
        ? 1
        : 0,
    // Legacy boolean mirror kept in sync (old-build / rollback safety):
    // max → 1, every other level → 0, NULL → NULL.
    session.reasoningEffort === null || session.reasoningEffort === undefined
      ? null
      : session.reasoningEffort === "max"
        ? 1
        : 0,
    session.reasoningEffort ?? null,
    session.fsmLastGraphMode ?? null,
    session.fsmLastNodeId ?? null,
    session.fsmLastNodeAt ?? null,
    session.composerFsmGraphId ?? null,
    session.fsmLastGraphId ?? null,
    session.fsmBlackboard
      ? JSON.stringify(
          mergeLegacyPhaseColumnIntoBlackboard(
            session.fsmBlackboard,
            getSessionPhase(session),
          ),
        )
      : getSessionPhase(session)
        ? JSON.stringify({
            [SESSION_PHASE_BLACKBOARD_KEY]: getSessionPhase(session),
          })
        : null,
    session.handoffEnabled === null || session.handoffEnabled === undefined
      ? null
      : session.handoffEnabled
        ? 1
        : 0,
  );
}

export function loadAllSessions(db: SessionDatabase): Session[] {
  const sessionRows = db
    .prepare(
      `SELECT id, type, source, title, created_at, updated_at, status, progress_text,
              model, provider_id, workspace_id, workspace_path, pinned, archived, archived_at,
              context_usage, plan, plan_doc, phase, pending_user_ask,
              run_mode, infinite, reasoning_max, reasoning_effort,
              fsm_last_graph_mode, fsm_last_node_id, fsm_last_node_at,
              fsm_graph_id, fsm_last_graph_id, fsm_blackboard, handoff_enabled
       FROM sessions
       ORDER BY updated_at DESC`,
    )
    .all() as SessionRow[];

  const messageStmt = db.prepare(
    `SELECT id, session_id, role, created_at, tool_call_id, parts, position
     FROM messages
     WHERE session_id = ?
     ORDER BY position ASC`,
  );

  const sessions: Session[] = [];
  for (const row of sessionRows) {
    const messageRows = messageStmt.all(row.id) as MessageRow[];
    sessions.push(
      rowToSession(
        row,
        messageRows.map((m) => rowToMessage(m)),
      ),
    );
  }
  return sessions;
}

/** Upsert a full session and replace its messages (transactional). */
export function upsertSession(db: SessionDatabase, session: Session): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    upsertSessionRowInner(db, session);

    db.prepare("DELETE FROM messages WHERE session_id = ?").run(session.id);

    const insertMessage = db.prepare(
      `INSERT INTO messages (
         id, session_id, role, created_at, tool_call_id, parts, position
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    session.messages.forEach((message, position) => {
      const toolCallId =
        message.role === "tool"
          ? message.toolCallId
          : message.role === "assistant" && message.toolCallId
            ? message.toolCallId
            : null;
      insertMessage.run(
        message.id,
        session.id,
        message.role,
        message.createdAt,
        toolCallId,
        serializeStoredMessageParts(message.parts),
        position,
      );
    });

    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // ignore rollback errors
    }
    throw err;
  }
}

/** Delete a session and its messages (CASCADE). Returns whether a row was removed. */
export function deleteSession(db: SessionDatabase, sessionId: string): boolean {
  const result = db
    .prepare("DELETE FROM sessions WHERE id = ?")
    .run(sessionId) as { changes: number };
  return result.changes > 0;
}

/**
 * Flip a single session's archive flag. Archiving stamps `archived_at = ts`;
 * unarchiving clears it. `updated_at` is bumped so a restored session returns
 * to the top of its list. Returns whether a row was changed.
 */
export function setSessionArchived(
  db: SessionDatabase,
  sessionId: string,
  archived: boolean,
  ts: number,
): boolean {
  const result = db
    .prepare(
      `UPDATE sessions
       SET archived = ?, archived_at = ?
       WHERE id = ? AND archived != ?`,
    )
    .run(archived ? 1 : 0, archived ? ts : null, sessionId, archived ? 1 : 0) as {
    changes: number;
  };
  return result.changes > 0;
}

/**
 * Explicitly write per-session composer prefs (schema v14).
 * Only provided keys are updated; `null` resets a field to un-pinned
 * (fall back to settings.json defaults). Regular upserts never touch
 * these columns — this is the only write path for them.
 * Returns whether a row was changed.
 */
export type ComposerPrefsPatch = {
  runMode?: "agent" | "ask" | "plan" | "custom" | null;
  /** Library graph id when mode is custom; null clears. */
  fsmGraphId?: string | null;
  infinite?: boolean | null;
  /** Reasoning-effort dial level (schema v21); null = un-pin. */
  reasoningEffort?: ReasoningEffort | null;
  /** turn_handoff gate (schema v20); null = un-pin (back to disabled). */
  handoffEnabled?: boolean | null;
};

/** Validate an IPC composer-prefs patch (enum + booleans; null = un-pin). */
export function validateComposerPrefsPatch(
  patch: ComposerPrefsPatch,
): void {
  if (
    patch.runMode !== undefined &&
    patch.runMode !== null &&
    patch.runMode !== "agent" &&
    patch.runMode !== "ask" &&
    patch.runMode !== "plan" &&
    patch.runMode !== "custom"
  ) {
    throw new Error("runMode must be agent, ask, plan, custom, or null");
  }
  if (
    patch.fsmGraphId !== undefined &&
    patch.fsmGraphId !== null &&
    (typeof patch.fsmGraphId !== "string" || !patch.fsmGraphId.trim())
  ) {
    throw new Error("fsmGraphId must be a non-empty string or null");
  }
  if (
    patch.infinite !== undefined &&
    patch.infinite !== null &&
    typeof patch.infinite !== "boolean"
  ) {
    throw new Error("infinite must be a boolean or null");
  }
  if (
    patch.reasoningEffort !== undefined &&
    patch.reasoningEffort !== null &&
    !isReasoningEffort(patch.reasoningEffort)
  ) {
    throw new Error("reasoningEffort must be off|low|medium|high|max or null");
  }
  if (
    patch.handoffEnabled !== undefined &&
    patch.handoffEnabled !== null &&
    typeof patch.handoffEnabled !== "boolean"
  ) {
    throw new Error("handoffEnabled must be a boolean or null");
  }
}

export function updateComposerPrefs(
  db: SessionDatabase,
  sessionId: string,
  patch: ComposerPrefsPatch,
): boolean {
  const sets: string[] = [];
  const args: Array<string | number | null> = [];
  if (patch.runMode !== undefined) {
    sets.push("run_mode = ?");
    args.push(patch.runMode ?? null);
  }
  if (patch.fsmGraphId !== undefined) {
    sets.push("fsm_graph_id = ?");
    args.push(
      patch.fsmGraphId === null || patch.fsmGraphId === undefined
        ? null
        : patch.fsmGraphId.trim(),
    );
  }
  if (patch.infinite !== undefined) {
    sets.push("infinite = ?");
    args.push(patch.infinite === null ? null : patch.infinite ? 1 : 0);
  }
  if (patch.reasoningEffort !== undefined) {
    sets.push("reasoning_effort = ?");
    args.push(patch.reasoningEffort ?? null);
    // Legacy boolean mirror (old-build / rollback safety).
    sets.push("reasoning_max = ?");
    args.push(
      patch.reasoningEffort === null || patch.reasoningEffort === undefined
        ? null
        : patch.reasoningEffort === "max"
          ? 1
          : 0,
    );
  }
  if (patch.handoffEnabled !== undefined) {
    sets.push("handoff_enabled = ?");
    args.push(
      patch.handoffEnabled === null ? null : patch.handoffEnabled ? 1 : 0,
    );
  }
  if (sets.length === 0) return false;
  args.push(sessionId);
  const result = db
    .prepare(`UPDATE sessions SET ${sets.join(", ")} WHERE id = ?`)
    .run(...args) as { changes: number };
  return result.changes > 0;
}

/** Hard cap for one session's serialized blackboard (UTF-8 bytes). */
export const FSM_BLACKBOARD_MAX_BYTES = 64 * 1024;

/**
 * Write a session's full blackboard (schema v19). Dedicated immediate-write
 * path — blackboard writes land without waiting for the next persistSession
 * cadence. `null` clears. updated_at is NOT bumped (blackboard writes are
 * not conversation activity). Returns whether a row was changed.
 */
export function updateFsmBlackboard(
  db: SessionDatabase,
  sessionId: string,
  data: Record<string, unknown> | null,
): boolean {
  const serialized =
    data && Object.keys(data).length > 0 ? JSON.stringify(data) : null;
  const result = db
    .prepare(`UPDATE sessions SET fsm_blackboard = ? WHERE id = ?`)
    .run(serialized, sessionId) as { changes: number };
  return result.changes > 0;
}

/**
 * Archive/unarchive every session under a workspace in one atomic UPDATE.
 * Archiving stamps `archived_at = ts`; unarchiving clears it. `updated_at`
 * tracks conversation activity, so neither direction touches it — restored
 * sessions keep their real last-activity time in the list.
 * Returns the number of affected rows.
 */
export function setAllSessionsArchivedForWorkspace(
  db: SessionDatabase,
  workspaceId: string,
  archived: boolean,
  ts: number,
): number {
  const result = db
    .prepare(
      `UPDATE sessions
       SET archived = ?, archived_at = ?
       WHERE workspace_id = ? AND archived != ?`,
    )
    .run(archived ? 1 : 0, archived ? ts : null, workspaceId, archived ? 1 : 0) as {
    changes: number;
  };
  return result.changes;
}
