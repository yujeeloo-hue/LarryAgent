import { randomUUID } from "node:crypto";
import { CocoEngine, type CocoContext } from "../coco/engine.js";
import { gitHeadFact } from "../coco/gitFacts.js";
import { CocoRepository } from "../coco/repository.js";
import { inCocoScope, sameExecutionAuthority } from "../coco/scope.js";
import { CocoToolRuntime } from "../coco/toolRuntime.js";
import type { CocoMcpEvent, CocoRule, CocoSettings, CocoWork } from "../coco/types.js";
import type { ToolApprovalRequestPayload, UserAskRequestPayload } from "../agent/ipcTypes.js";
import type { UserAskAnswer } from "../shared/askUser.js";
import { mcpManager } from "../mcp/manager.js";
import { getCocoPrompt } from "../settings/promptDefaults.js";
import { runCocoBackground } from "./cocoBackground.js";
import { cocoBackgroundTasks, pruneFinishedBackgroundSessions } from "./cocoBackgroundTasks.js";
import { createCocoAwareness } from "./cocoAwareness.js";
import { createCocoConversation } from "./cocoConversation.js";
import { COCO_DECISION_TIMEOUT_MS, createCocoDecide } from "./cocoDecide.js";
import { TOOL_APPROVAL_OPTIONS, parseToolApproval, requiresUserApproval, toolApprovalQuestion } from "../coco/toolApproval.js";
import { createCocoEventSources } from "./cocoEventSources.js";
import { createCocoMemory, ensureCocoHome, resetCocoAutonomousPrompt } from "./cocoHome.js";
import { createCocoExecution } from "./cocoExecution.js";
import { createCocoWorkResults } from "./cocoWorkResults.js";
import { backfillCocoSessionSources } from "./cocoSessionSource.js";
import { createCocoWakeSources } from "./cocoWakeSources.js";
import { projectVcsFact } from "../coco/vcsFacts.js";
import { migrateLegacyLoops } from "./cocoLegacyMigration.js";
import { meteredStream } from "./cocoMetering.js";
import { createCocoModel } from "./cocoModel.js";
import { createCocoRecover } from "./cocoRecovery.js";
import { retainCocoHistory } from "./cocoRetention.js";
import type { CocoServiceDeps } from "./cocoServiceDeps.js";
import { addAgentStreamSink, removeAgentStreamSink, type SessionStore } from "./sessionRuntime.js";
import { createCocoActivityFeed, trailing } from "./cocoActivityFeed.js";
import type { CocoActivity } from "../coco/activity.js";

const STREAM_NOISE = new Set(["text_delta", "reasoning_delta", "tool_call_delta", "usage", "context_display", "progress", "subagent_live", "tool_live"]);

/**
 * Context builder factory — exported for tests. Minimal visibility (v1):
 * recent MCP notifications become part of the model context ("see, don't
 * act" — no wake, no rule triggering).
 */
export function createCocoContextBuilder(
  store: SessionStore,
  repository: CocoRepository,
): (settings: CocoSettings, rule?: CocoRule) => CocoContext {
  return (settings, rule) => {
    const workspaces = store.listWorkspaces().filter(w => inCocoScope(settings, w.id, rule));
    const sessions = store.listSessions().filter(s => !s.archived && workspaces.some(w => w.id === s.workspaceId)).map(s => ({ id: s.id, workspaceId: s.workspaceId, title: s.title, status: s.status, updatedAt: s.updatedAt }));
    const mcpEvents = repository.list<CocoMcpEvent>("mcpEvent").slice(-20);
    return { workspaces: workspaces.map(w => ({ id: w.id, name: w.name, path: w.path })), sessions, changes: workspaces.map(w => ({ workspaceId: w.id, git: gitHeadFact(w.path) })), ...(mcpEvents.length ? { mcpEvents } : {}) };
  };
}

const HANDOVER_PLACEHOLDERS = ["title", "status", "workspace", "sessionId"] as const;

/** Renders coco/handover.md ({{title}} … placeholders) into the wake message. */
function renderCocoHandoverPrompt(values: Record<(typeof HANDOVER_PLACEHOLDERS)[number], string>): string {
  return HANDOVER_PLACEHOLDERS.reduce((text, key) => text.split(`{{${key}}}`).join(values[key]), getCocoPrompt("handover")).trim();
}

/** Composition root: wires the CoCo engine to its main-process ports. */
export function createCocoService(root: string, store: SessionStore, notify?: (title: string, text: string) => void, tools = new CocoToolRuntime(), options: { proactive?: boolean; projectAwareness?: boolean; onActivity?: (activity: CocoActivity) => void; onChanged?: () => void } = {}) {
  const repository = new CocoRepository(store.database);
  backfillCocoSessionSources(store, repository);
  let alive = true;
  const context = createCocoContextBuilder(store, repository);
  const deps: CocoServiceDeps = { root, store, repository, tools, alive: () => alive, engine: () => engine, context };
  const model = createCocoModel(deps);
  const { execute, followup } = createCocoExecution(deps);
  const workResults = createCocoWorkResults(deps);
  const sources = createCocoEventSources(deps);
  const home = ensureCocoHome(root, store.database);
  const memory = createCocoMemory({ home, repository, timezone: () => engine.settings().timezone });
  const awareness = createCocoAwareness({ ...deps, memory, home });
  const awarenessOn = options.proactive !== false && options.projectAwareness !== false;
  const syncAwareness = (): void => {
    if (!awarenessOn || !alive) return;
    // Deferred: callers may sit inside an engine transaction.
    setTimeout(() => { void awareness.sync().catch(error => console.warn("[coco] project awareness sync failed", error)); }, 0).unref?.();
  };
  const wakeSources = createCocoWakeSources({ alive: () => alive, engine: () => engine, context, onWorkspaceChanged: syncAwareness });
  const chat = createCocoConversation({ root, store, repository, tools, home, memory, settings: () => engine.settings(), context: () => context(engine.settings()), ownsExecution: () => alive && engine.ownsExecution(), budget: () => engine.budget.state(), stream: meteredStream });
  const decide = createCocoDecide(deps);
  // Sidebar hand-overs (D-3): between the click and the moment the wake job
  // actually starts running, questions on that session still go to the user.
  // Memory-only — the permanent state is the session's `source === "coco"`.
  const pendingHandovers = new Set<string>();
  const handoverMessages = new Map<string, string>();
  const clearStartedHandovers = (): void => {
    if (!handoverMessages.size) return;
    const job = engine.snapshot().chatJob;
    if (!job?.messageId) return;
    const sessionId = handoverMessages.get(job.messageId);
    if (!sessionId) return;
    handoverMessages.delete(job.messageId);
    pendingHandovers.delete(sessionId);
  };
  const engine: CocoEngine = new CocoEngine(repository, {
    cleanup: async (settings, signal, usage) => {
      const unchanged = (): boolean => alive && engine.ownsExecution() && !signal.aborted && engine.settings().historyRetentionDays === settings.historyRetentionDays;
      const canContinue = (): boolean => unchanged() && engine.settings().enabled && !engine.budget.cooling();
      await retainCocoHistory({ store, repository, settings, signal, now: Date.now(), canContinue, summarize: async (slice, operationId) => {
        const value = await runCocoBackground({ root, store, repository, purpose: "retention", operationId, workspaceId: slice.workspaceId, providerId: settings.providerId, signal,
          valid: () => unchanged() && sameExecutionAuthority(engine.settings(), settings),
          stream: meteredStream(signal, usage), requireReadField: "retentionSource",
          input: { sessionId: slice.sessionId, cutoff: slice.cutoff, retentionSource: JSON.stringify({ messages: slice.messages, previousSummary: slice.previousSummary }) },
          prompt: getCocoPrompt("retention") }) as { summary?: unknown };
        if (typeof value?.summary !== "string") throw new Error("No reliable history summary was produced; original details were kept.");
        return { summary: value.summary };
      } });
    },
    ...(awarenessOn ? { project: { pending: awareness.pending, run: awareness.run } } : {}),
    vcs: async projects => Object.fromEntries(await Promise.all(projects.map(async p => [p.id, await projectVcsFact(p.path)] as const))),
    projectDocNote: entry => entry.doc === "PROJECT.md" ? awareness.docNote(entry.workspaceId, entry.at) : undefined,
    resetAutonomousPrompt: () => resetCocoAutonomousPrompt(home),
    scopeChanged: syncAwareness,
    conversation: chat.converse, chatState: chat.state, chatStatus: chat.status, chatControl: chat.control, notice: chat.notice,
    changed: () => { activity.schedule(); notifyChanged(); clearStartedHandovers(); },
    backgroundTasks: () => cocoBackgroundTasks(repository, store, store.listWorkspaces().filter(workspace => inCocoScope(engine.settings(), workspace.id)).map(workspace => workspace.id)),
    settingsOptions: () => ({ mcpOptions: mcpManager.listToolOptions(), workspaceOptions: store.listWorkspaces().map(w => ({ id: w.id, name: w.name })) }),
    context, model, decide, execute, followup,
    captureResults: async workId => { await workResults.capture(workId); },
    resumeBudgetHold: async sessionId => {
      const session = store.listSessions().find(s => s.id === sessionId);
      if (!session || session.status !== "paused") return;
      const result = await store.resumeTurn({
        sessionId,
        fullPermissions: true,
        note: "Continuing after automation budget reset.",
        startContinuation: false,
      });
      if (!result.ok && result.reason !== "not_paused") throw new Error(result.reason ?? "Could not clear the budget pause");
    },
    recover: createCocoRecover(deps, { model }),
    ...(notify ? { notify } : {}),
  });
  const activity = createCocoActivityFeed(() => engine.activity(), next => options.onActivity?.(next));
  const notifyChanged = trailing(() => options.onChanged?.(), 200);
  // Session supervision (sidebar hand-over): CoCo answers ask_user / tool
  // approvals of handed-over sessions with the decide model. D-3: not before
  // the wake job has started (pendingHandovers); permanent afterwards — the
  // `source === "coco"` marker survives restarts with no restore machinery.
  const supervisedSession = (sessionId: string) => {
    if (!alive || !engine.ownsExecution() || !engine.settings().enabled || pendingHandovers.has(sessionId)) return undefined;
    const row = store.listSessions().find(s => s.id === sessionId);
    return row && !row.archived && row.source === "coco" ? row : undefined;
  };
  const decideForSession = (row: { workspaceId: string }, sessionId: string, question: unknown): Promise<unknown> => {
    // The decide port only reads workspaceId/sessionId off the work record; a
    // synthetic carrier keeps session supervision work-free. Unmetered: one
    // compact request per ask is beneath the budget's accounting granularity.
    const work = { workspaceId: row.workspaceId, sessionId } as CocoWork;
    return decide({ work, question }, AbortSignal.timeout(COCO_DECISION_TIMEOUT_MS), () => {}, "");
  };
  const needsUser = (): "needs-user" => {
    // The runtime parks the ask on the CoCo Chat card; nudge its refresh.
    setTimeout(() => notifyChanged(), 0).unref?.();
    return "needs-user";
  };
  const superviseDecide = async (sessionId: string, payload: UserAskRequestPayload): Promise<UserAskAnswer | "needs-user" | null> => {
    const row = supervisedSession(sessionId);
    if (!row) return null;
    let result: { action?: unknown; answer?: unknown; selections?: unknown; reason?: unknown };
    try { result = await decideForSession(row, sessionId, payload) as typeof result; } catch { return needsUser(); }
    const options = Array.isArray(result.selections) ? result.selections.filter((v): v is string => typeof v === "string") : typeof result.answer === "string" ? [result.answer] : [];
    const custom = options.some(value => !payload.options.includes(value));
    const answer = options.join(", ");
    const accepted = result.action === "answer" && options.length > 0 && answer.length <= 12000 && (payload.allowMultiple || options.length === 1) && (!custom || payload.allowCustom);
    repository.put("supervision", { id: randomUUID(), at: Date.now(), sessionId, question: payload, action: accepted ? "answer" : "needs_user", answer: accepted ? answer : null, reason: typeof result.reason === "string" ? result.reason.slice(0, 4000) : "No reliable supervisory answer" });
    return accepted ? { selected: answer, custom, ...(options.length > 1 ? { selections: options } : {}) } : needsUser();
  };
  const superviseApprove = async (sessionId: string, payload: ToolApprovalRequestPayload): Promise<boolean | "needs-user" | null> => {
    const row = supervisedSession(sessionId);
    if (!row) return null;
    const recorded = { question: `Tool approval: ${payload.toolName}`, options: [...TOOL_APPROVAL_OPTIONS], allowCustom: false };
    if (requiresUserApproval(payload)) {
      repository.put("supervision", { id: randomUUID(), at: Date.now(), sessionId, question: recorded, action: "needs_user", answer: null, reason: `Fatal risk always goes to the user: ${payload.risk?.reason ?? payload.toolName}` });
      return needsUser();
    }
    let result: { action?: unknown; answer?: unknown; selections?: unknown; reason?: unknown };
    try { result = await decideForSession(row, sessionId, { question: toolApprovalQuestion(payload), options: [...TOOL_APPROVAL_OPTIONS], allowCustom: false }) as typeof result; } catch { return needsUser(); }
    const verdict = parseToolApproval(result);
    repository.put("supervision", { id: randomUUID(), at: Date.now(), sessionId, question: recorded, action: verdict === "needs-user" ? "needs_user" : "answer", answer: verdict === "needs-user" ? null : verdict ? "Approve" : "Deny", reason: typeof result.reason === "string" ? result.reason.slice(0, 4000) : "No reliable supervisory answer" });
    return verdict === "needs-user" ? needsUser() : verdict;
  };
  let releaseSupervision: (() => void) | undefined;
  const bindSupervision = (): void => {
    releaseSupervision?.();
    releaseSupervision = store.setCocoSessionSupervisionHandler({ decide: superviseDecide, approve: superviseApprove, supervises: sessionId => supervisedSession(sessionId) !== undefined });
  };
  let releaseChatQueue: (() => void) | undefined;
  const bindChatQueue = (): void => {
    releaseChatQueue?.();
    releaseChatQueue = store.setCocoChatPromptHandler({
      start: (sessionId, prompt) => {
        if (!alive || !engine.ownsExecution() || !engine.settings().enabled || chat.status()?.sessionId !== sessionId || prompt.attachments.length) return false;
        engine.command({ type: "chat", text: prompt.userText, ...(prompt.cocoWorkId ? { workId: prompt.cocoWorkId } : {}) });
        return true;
      },
      // User speech becomes a fresh Chat job (after a running autonomous turn,
      // instead of an automatic greeting), so automatic tools and trailing notes never leak.
      canInsert: sessionId => alive && chat.status()?.sessionId === sessionId && engine.snapshot().chatJob?.kind === "chat",
    });
  };
  /** A CoCo-managed session (hand-over or CoCo origin) gets its finished turns reviewed and, when useful, continued. */
  const watchManagedSession = (sessionId: string): void => {
    if (!alive) return;
    const row = store.listSessions().find(s => s.id === sessionId);
    if (!row || row.archived || row.source !== "coco" || !["idle", "running"].includes(row.status)) return;
    const session = store.getSessionTail(sessionId, { turns: 1 })?.session;
    if (!session || session.pendingUserAsk) return;
    const mode = session.composerRunMode;
    try {
      engine.watchSession({ sessionId, workspaceId: row.workspaceId, title: row.title, providerId: session.providerId, runMode: mode === "plan" || mode === "ask" ? mode : "agent", ...(session.reasoningEffort ? { reasoningEffort: session.reasoningEffort } : {}) });
    } catch (error) { console.warn("[coco] hand-over watch failed", error); }
  };
  /** Chat and execution turns change activity without an engine emit. */
  const activitySink = (payload: { sessionId?: string; event: unknown }): void => {
    const event = payload.event as { type?: unknown; reason?: unknown } | null;
    const type = event?.type;
    if (typeof type === "string" && !STREAM_NOISE.has(type)) { activity.schedule(); clearStartedHandovers(); }
    if (type === "done" && event?.reason === "completed" && payload.sessionId) {
      const sessionId = payload.sessionId;
      setTimeout(() => watchManagedSession(sessionId), 0).unref?.();
    }
  };
  /** Sidebar hand-over: mark the session CoCo-managed; the instruction rides the wake turn only (handoverInstruction + suppressed user message) so it never persists in Chat context. */
  const handoverSession = (sessionId: string): { ok: true } | { ok: false; error: string } => {
    if (!alive || !engine.ownsExecution()) return { ok: false, error: "CoCo is initializing or stopping; try again in a moment." };
    if (!engine.settings().enabled) return { ok: false, error: "Enable CoCo before handing over a session." };
    const blocked = engine.snapshot().error;
    if (blocked) return { ok: false, error: blocked };
    if (engine.snapshot().chat?.question) return { ok: false, error: "CoCo Chat is waiting for an answer; reply there first." };
    const row = store.listSessions().find(s => s.id === sessionId);
    if (!row) return { ok: false, error: "Unknown session." };
    if (row.archived) return { ok: false, error: "This session is archived." };
    if (row.source === "coco") { watchManagedSession(sessionId); return { ok: true }; }
    const workspace = store.listWorkspaces().find(w => w.id === row.workspaceId);
    const instruction = renderCocoHandoverPrompt({ title: row.title, status: row.status, workspace: workspace?.name ?? "unknown", sessionId });
    const marker = `Session handed over: ${row.title} (${sessionId}) — project ${workspace?.name ?? "unknown"}`;
    try {
      engine.command({ type: "chat", text: marker, handoverInstruction: instruction, ...(workspace ? { workspaceId: workspace.id } : {}) });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (!store.setSessionSource(sessionId, "coco")) return { ok: false, error: "Unknown session." };
    const published = engine.snapshot().messages.filter(m => m.role === "user" && m.text === marker).at(-1);
    if (published) { pendingHandovers.add(sessionId); handoverMessages.set(published.id, sessionId); }
    watchManagedSession(sessionId);
    return { ok: true };
  };
  /** Take-back: stop reviewing / continuing the session's turns. */
  const releaseSession = (sessionId: string): void => {
    try { engine.releaseSession(sessionId); } catch (error) { console.warn("[coco] hand-over release failed", error); }
  };
  return {
    engine,
    workResults: workResults.read,
    home,
    memory,
    activity: activity.current,
    handoverSession,
    releaseSession,
    handoverPending: (sessionId: string) => pendingHandovers.has(sessionId),
    start: () => {
      alive = true;
      bindChatQueue();
      bindSupervision();
      addAgentStreamSink(activitySink); activity.start();
      if (!engine.snapshot().error) migrateLegacyLoops(root, repository);
      try { pruneFinishedBackgroundSessions(repository, store, Date.now()); } catch (error) { console.warn("[coco] background session prune failed", error); }
      engine.start();
      wakeSources.start();
      if (awarenessOn) awareness.start();
      // One reconcile at start catches edits made while the app was closed; later syncs are event-driven.
      syncAwareness();
    },
    shutdown: async () => { alive = false; releaseChatQueue?.(); releaseSupervision?.(); wakeSources.stop(); engine.stop(); await Promise.allSettled([tools.close(), engine.settled()]); },
    stop: () => { alive = false; releaseChatQueue?.(); releaseSupervision?.(); wakeSources.stop(); sources.stop(); awareness.stop(); removeAgentStreamSink(activitySink); activity.stop(); },
  };
}
