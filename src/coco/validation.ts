import { normalizeCadence } from "../loops/schedule.js";
import { isValidProtectTokenRatio } from "../shared/protectTokenRatio.js";
import type { CocoCriterion, CocoGoalPlan, CocoRule, CocoSettings, CocoWorkChange } from "./types.js";

/** Actionable cadence error: names every accepted shape so a model can self-correct. */
const CADENCE_SHAPES =
  "{kind:'minute',n} | {kind:'hour',minute:0-59} | {kind:'day',time:'HH:mm'} | {kind:'week',weekdays:[0-6],time:'HH:mm'} (weekdays 0=Sun..6=Sat) | {kind:'month',day:1-31,time:'HH:mm'} | {kind:'year',month:1-12,day:1-31,time:'HH:mm'}";


const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("Expected an object");
  return v as Record<string, unknown>;
};
const string = (v: unknown, max = 12000): string => {
  if (typeof v !== "string" || !v.trim() || v.length > max) throw new Error("Missing or oversized text");
  return v.trim();
};
const strings = (v: unknown, max = 100): string[] => {
  if (!Array.isArray(v) || v.length > max) throw new Error("Invalid list");
  return v.map(s => string(s));
};
const integer = (v: unknown, min: number, max: number): number => {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) throw new Error(`Expected an integer between ${min} and ${max}`);
  return v;
};
const boolean = (v: unknown): boolean => { if (typeof v !== "boolean") throw new Error("Expected a boolean"); return v; };
/** Optional ratio knob: absent (or null) inherits the global default; invalid values are rejected. */
const ratio = (v: unknown, valid: (n: number) => boolean, message: string): number | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || !valid(v)) throw new Error(message);
  return v;
};
/** Stored plans may still use file or command kinds. Those fields are kept and are not evaluated. */
export function criteria(raw: unknown): CocoCriterion[] {
  if (!Array.isArray(raw) || !raw.length || raw.length > 30) throw new Error("Provide 1–30 acceptance criteria before execution");
  const result = raw.map((value, i) => {
    const v = object(value);
    if (v.kind !== "review" && v.kind !== "file_exists" && v.kind !== "file_contains" && v.kind !== "command_succeeded") throw new Error("Unknown acceptance check");
    return { id: typeof v.id === "string" ? string(v.id, 100) : `criterion-${i + 1}`, description: string(v.description, 2000), kind: v.kind,
      ...(v.kind === "file_exists" || v.kind === "file_contains" ? { path: string(v.path, 2000) } : {}),
      ...(v.kind === "file_contains" ? { text: string(v.text, 2000) } : {}),
      ...(v.kind === "command_succeeded" ? { command: string(v.command, 2000) } : {}) } as CocoCriterion;
  });
  if (new Set(result.map(c => c.id)).size !== result.length) throw new Error("Duplicate acceptance criterion");
  return result;
}
export function validatePlan(raw: unknown, allowedWorkspaces: Set<string>, allowedSessions: Set<string>, allowedWork: Set<string> = new Set(), sessionWorkspaces?: Map<string, string>): CocoGoalPlan {
  const v = object(raw);
  if (!Array.isArray(v.work) || v.work.length > 20) throw new Error("A plan supports at most 20 work items");
  const work = v.work.map(rawWork => {
    const w = object(rawWork);
    const workspaceId = string(w.workspaceId, 200);
    if (!allowedWorkspaces.has(workspaceId)) throw new Error("Plan references an unavailable project");
    const observeSessionId = w.observeSessionId ? string(w.observeSessionId, 200) : undefined;
    if (observeSessionId && !allowedSessions.has(observeSessionId)) throw new Error("Plan references an unavailable session");
    const requestedExecutionSessionId = w.executionSessionId ? string(w.executionSessionId, 200) : undefined;
    if (requestedExecutionSessionId && observeSessionId) throw new Error("Choose execution or observation for a session");
    if (w.sessionStrategy != null && !["continue", "steer", "append"].includes(String(w.sessionStrategy))) throw new Error("Invalid session strategy");
    if (w.sessionStrategy && !requestedExecutionSessionId) throw new Error("A session strategy needs an execution session");
    // A stale execution session (deleted or out of scope) falls back to a new session.
    const executionSessionId = requestedExecutionSessionId && allowedSessions.has(requestedExecutionSessionId) ? requestedExecutionSessionId : undefined;
    for (const id of [executionSessionId, observeSessionId]) if (id && sessionWorkspaces && sessionWorkspaces.get(id) !== workspaceId) throw new Error("Session belongs to a different project");
    return { key: string(w.key, 100), title: string(w.title, 200), objective: string(w.objective), workspaceId, priority: integer(w.priority ?? 50, 0, 100), ...(w.deadlineAt != null ? { deadlineAt: integer(w.deadlineAt, 0, Number.MAX_SAFE_INTEGER) } : {}), ...(w.userPriority != null ? { userPriority: boolean(w.userPriority) } : {}), dependsOn: strings(w.dependsOn ?? [], 20), steps: strings(w.steps, 30), acceptance: criteria(w.acceptance), deliverables: strings(w.deliverables ?? [], 30), ...(observeSessionId ? { observeSessionId } : {}), ...(executionSessionId ? { executionSessionId, sessionStrategy: (w.sessionStrategy ?? "steer") as "continue" | "steer" | "append" } : {}) };
  });
  const byKey = new Map(work.map(w => [w.key, w]));
  if (byKey.size !== work.length) throw new Error("Duplicate work key");
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (key: string): void => {
    if (visiting.has(key)) throw new Error("Cyclic work dependencies");
    if (visited.has(key)) return;
    const item = byKey.get(key); if (!item) throw new Error("Unknown dependency");
    visiting.add(key); item.dependsOn.forEach(visit); visiting.delete(key); visited.add(key);
  };
  work.forEach(w => visit(w.key));
  if (v.ruleSuggestions != null && !Array.isArray(v.ruleSuggestions)) throw new Error("Invalid rule suggestions");
  if (v.changes != null && (!Array.isArray(v.changes) || v.changes.length > 20)) throw new Error("Invalid work changes");
  const changes = ((v.changes ?? []) as unknown[]).map(raw => {
    const c = object(raw), workId = string(c.workId, 200);
    if (!allowedWork.has(workId) || !["pause", "resume", "cancel", "priority", "revise"].includes(String(c.action))) throw new Error("Invalid work change target or action");
    return { workId, action: c.action as CocoWorkChange["action"], ...(c.priority != null ? { priority: integer(c.priority, 0, 100) } : {}), ...(c.objective != null ? { objective: string(c.objective) } : {}), ...(c.steps != null ? { steps: strings(c.steps, 30) } : {}), ...(c.acceptance != null ? { acceptance: criteria(c.acceptance) } : {}), ...(c.answer != null ? { answer: string(c.answer) } : {}) };
  });
  return { activateRuleIds: strings(v.activateRuleIds ?? [], 10), changes, reply: string(v.reply), planOnly: boolean(v.planOnly ?? false), work, ruleSuggestions: (v.ruleSuggestions as unknown[] ?? []).slice(0, 10).map(r => {
    const rule = validateRule({ ...object(r), id: "suggestion", createdAt: 0, nextRunAt: 0, confirmed: false });
    if (!rule.scope.all && rule.scope.workspaceIds.some(id => !allowedWorkspaces.has(id))) throw new Error("Rule scope exceeds accessible projects");
    return rule;
  }) };
}
/** Rule-run work becomes the execution session's first user message verbatim, so it must stay a short brief. */
export const RULE_RUN_BRIEF_LIMITS = { objective: 500, steps: 5, step: 200, acceptance: 3, criterion: 200 } as const;

/** Throws an actionable rewrite request when a rule-run plan's task brief exceeds {@link RULE_RUN_BRIEF_LIMITS}. */
export function checkRuleRunBrief(raw: unknown): void {
  const L = RULE_RUN_BRIEF_LIMITS, problems: string[] = [];
  const work = raw && typeof raw === "object" && Array.isArray((raw as { work?: unknown }).work) ? (raw as { work: unknown[] }).work : [];
  work.forEach((item, i) => {
    const w = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const label = `work[${i}]`;
    const len = (v: unknown): number => typeof v === "string" ? v.trim().length : 0;
    if (len(w.objective) > L.objective) problems.push(`${label}.objective is ${len(w.objective)} characters (max ${L.objective})`);
    const steps = Array.isArray(w.steps) ? w.steps : [];
    if (steps.length > L.steps) problems.push(`${label} has ${steps.length} steps (max ${L.steps})`);
    steps.forEach((s, j) => { if (len(s) > L.step) problems.push(`${label}.steps[${j}] is ${len(s)} characters (max ${L.step})`); });
    const acceptance = Array.isArray(w.acceptance) ? w.acceptance : [];
    if (acceptance.length > L.acceptance) problems.push(`${label} has ${acceptance.length} acceptance criteria (max ${L.acceptance})`);
    acceptance.forEach((c, j) => { const d = c && typeof c === "object" ? (c as { description?: unknown }).description : undefined; if (len(d) > L.criterion) problems.push(`${label}.acceptance[${j}] is ${len(d)} characters (max ${L.criterion})`); });
  });
  if (problems.length) throw new Error(`The rule-run task brief is too long and would be sent verbatim to the execution session: ${problems.join("; ")}. Rewrite it as a short brief: state what this run does and any fact the executor cannot look up itself; leave the investigation (commit lists, baselines, file sections) for the executor; do not repeat the rule's own acceptance criteria, they are appended automatically. Then call submit_coco_result again.`);
}
export function defaultSettings(): CocoSettings {
  return { enabled: false, providerId: "", fastProviderId: "", hourlyTokens: 200000, dailyTokens: 1000000, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, excludedWorkspaceIds: [], fullPermissions: true, heartbeatMinutes: 15, repairLimit: 3, reportTime: "18:00", historyRetentionDays: 30 };
}
export function validateSettings(raw: unknown): CocoSettings {
  const v = object(raw);
  const timezone = string(v.timezone, 100); new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
  if (typeof v.providerId !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v.reportTime))) throw new Error("Invalid provider or report time");
  // Legacy per-CoCo permissions, Shell/MCP grants and session exclusions no
  // longer apply. Runtime tuning stays on established defaults — the per-CoCo
  // Chat compaction ratios below are the one user-tunable exception; unset
  // values inherit the global Agent settings.
  const retention=integer(v.historyRetentionDays ?? 30,0,90);if(![0,30,90].includes(retention))throw new Error("Choose a supported conversation retention period");
  const compactTriggerRatio=ratio(v.compactTriggerRatio,n=>n>=0.5&&n<=0.95,"Compact trigger ratio must be between 0.5 and 0.95");
  const iterationProtectTokenRatio=ratio(v.iterationProtectTokenRatio,isValidProtectTokenRatio,"Compact keep ratio must be within (0, 0.9]");
  return { historyRetentionDays: retention, ...(compactTriggerRatio!==undefined?{compactTriggerRatio}:{}), ...(iterationProtectTokenRatio!==undefined?{iterationProtectTokenRatio}:{}), enabled: boolean(v.enabled), providerId: v.providerId, fastProviderId: typeof v.fastProviderId === "string" ? v.fastProviderId : "", hourlyTokens: integer(v.hourlyTokens, 1, 1000000000), dailyTokens: integer(v.dailyTokens, 1, 1000000000), timezone, excludedWorkspaceIds: strings(v.excludedWorkspaceIds ?? []), fullPermissions: true, heartbeatMinutes: integer(v.heartbeatMinutes ?? 15, 1, 240), repairLimit: 3, reportTime: String(v.reportTime) };
}
export function validateRule(raw: unknown): CocoRule {
  const v = object(raw), scope = object(v.scope);
  if (v.mode !== "fixed" && v.mode !== "inspection") throw new Error("Unknown rule mode");
  const cadence = normalizeCadence(v.cadence);
  if (!cadence) throw new Error(`Invalid schedule. Supported cadence shapes: ${CADENCE_SHAPES}`);
  const workspaceIds = strings(scope.workspaceIds);
  if (!scope.all && !workspaceIds.length) throw new Error("Select at least one project");
  if (v.runMode !== undefined && !["agent", "plan", "ask"].includes(String(v.runMode))) throw new Error("Invalid execution mode");
  if (v.reasoningEffort !== undefined && !["off", "low", "medium", "high", "max"].includes(String(v.reasoningEffort))) throw new Error("Invalid reasoning effort");
  return { ...(v.runMode ? { runMode: v.runMode as CocoRule["runMode"] } : {}), ...(v.reasoningEffort ? { reasoningEffort: v.reasoningEffort as CocoRule["reasoningEffort"] } : {}), id: string(v.id, 200), name: string(v.name, 200), objective: string(v.objective), mode: v.mode, scope: { all: boolean(scope.all), workspaceIds, excludedWorkspaceIds: strings(scope.excludedWorkspaceIds ?? []) }, enabled: boolean(v.enabled), confirmed: boolean(v.confirmed), cadence: cadence, fullPermissions: true, providerId: typeof v.providerId === "string" ? v.providerId : "", acceptance: Array.isArray(v.acceptance) && v.acceptance.length ? criteria(v.acceptance) : [], nextRunAt: integer(v.nextRunAt ?? 0, 0, Number.MAX_SAFE_INTEGER), createdAt: integer(v.createdAt ?? 0, 0, Number.MAX_SAFE_INTEGER) };
}
