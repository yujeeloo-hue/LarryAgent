import { randomUUID } from "node:crypto";
import type { CocoPorts } from "../coco/engine.js";
import { registerCocoExecution } from "../coco/executionAccess.js";
import { cocoFingerprint } from "../coco/fingerprint.js";
import { createCocoPolicy, type CocoDeniedRoot } from "../coco/policy.js";
import { deniedWorkspacePaths, executionAuthority, inCocoScope, siblingWorkspacePaths } from "../coco/scope.js";
import { pausedForBudget, stoppedByUser } from "../coco/status.js";
import type { CocoDecisionPrompt } from "../coco/decisionPrompt.js";
import { TOOL_APPROVAL_OPTIONS, parseToolApproval, requiresUserApproval, toolApprovalQuestion } from "../coco/toolApproval.js";
import type { CocoRule, CocoToolApproval, CocoWork } from "../coco/types.js";
import { mcpManager } from "../mcp/manager.js";
import type { JsonObject } from "../session/types.js";
import type { StreamChatFn } from "../agent/types.js";
import { meteredStream } from "./cocoMetering.js";
import type { CocoServiceDeps } from "./cocoServiceDeps.js";
import { summarizeFromStream } from "./cocoTurn.js";
import { resolveClient } from "./sessionRuntime.js";
import { createCocoWorkResults } from "./cocoWorkResults.js";

const ruleAuthority = (rule: CocoRule | undefined) => rule ? {id:rule.id,enabled:rule.enabled,confirmed:rule.confirmed,scope:rule.scope,runMode:rule.runMode} : null;

/** Dispatch saved work into an ordinary project session and supervise it until the turn settles. */
export function createCocoExecution(deps: CocoServiceDeps): { execute: CocoPorts["execute"]; followup: NonNullable<CocoPorts["followup"]> } {
  const { root, store, repository, tools } = deps;
  const workResults = createCocoWorkResults(deps);
  const executing = new Map<string, { id: string; sessionId?: string; enqueue(work: CocoWork, mode: "steer" | "append"): void }>();
  const instruction = (work: CocoWork): string => {
    const steps = work.steps.map(step => step.trim()).filter(Boolean);
    const acceptance = work.acceptance.map(criterion => criterion.description.trim()).filter(Boolean);
    return [
      work.objective.trim(),
      ...(steps.length ? ["", "Steps:", ...steps] : []),
      ...(acceptance.length ? ["", "Acceptance criteria:", ...acceptance] : []),
    ].join("\n");
  };
  const followup: NonNullable<CocoPorts["followup"]> = async (work, mode) => {
    const current = executing.get(work.id);
    if (!current?.sessionId) throw new Error("Execution session is not ready to receive updated instructions");
    current.enqueue(work, mode);
  };
  const execute: CocoPorts["execute"] = async (work, settings, signal, usage, attachSession) => {
    if (work.observeSessionId && !work.sessionId) return { summary: "Existing session finished; inspect its outcome", evidence: {} };
    const workspace = store.listWorkspaces().find(w => w.id === work.workspaceId);
    if (!workspace) throw new Error("Project was removed");
    let decision = "", interruption = "";
    let awaitingUser = false;
    let decisionPrompt: CocoDecisionPrompt | undefined;
    let sessionId: string | undefined;
    let dispatching = false;
    let unsupervise: (() => void) | undefined;
    const budget = deps.engine().budget;
    const cooling = (): boolean => budget.cooling();
    let budgetPaused = false;
    const budgetPause = (): void => {
      if (!sessionId || !store.isTurnActive(sessionId) || !store.isCocoTurnActive(sessionId, access.id)) return;
      if (store.pauseTurn(sessionId, "coco_budget").ok) budgetPaused = true;
    };
    const canStartTurn = (): boolean => !cooling() && deps.engine().canContinueWork(work.id);
    const rules = work.ruleIds.map(id => repository.get<CocoRule>("rule", id));
    // An executing session touches only its own project: excluded projects and
    // sibling projects covered by the same rules are both denied, so
    // multi-project goals run as one work item and one project session per project.
    const scopedWorkspaces = store.listWorkspaces();
    const excludedPaths = deniedWorkspacePaths(scopedWorkspaces, settings, rules);
    const siblingPaths = siblingWorkspacePaths(scopedWorkspaces, work.workspaceId, settings, rules);
    const deniedRoots: CocoDeniedRoot[] = [
      ...excludedPaths.map(path => ({ path, code: "excluded_project" as const })),
      ...siblingPaths.map(path => ({ path, code: "other_project" as const })),
    ];
    const deniedPaths = [...new Set([...excludedPaths, ...siblingPaths])];
    const scope = cocoFingerprint({ settings:executionAuthority(settings), rules:rules.map(ruleAuthority), workspace, workspacePaths: store.listWorkspaces().map(w => [w.id,w.path]), servers: mcpManager.getConfigs() });
    const valid = (): boolean => deps.alive() && deps.engine().ownsExecution() && !signal.aborted && inCocoScope(deps.engine().settings(), work.workspaceId) && store.listWorkspaces().find(w => w.id === work.workspaceId)?.path === workspace.path && scope === cocoFingerprint({ settings: executionAuthority(deps.engine().settings()), rules: (repository.get<CocoWork>("work", work.id)?.ruleIds ?? work.ruleIds).map(id => ruleAuthority(repository.get<CocoRule>("rule", id))), workspace: store.listWorkspaces().find(w => w.id === work.workspaceId), workspacePaths: store.listWorkspaces().map(w => [w.id,w.path]), servers: mcpManager.getConfigs() });
    const decide = (question: string, prompt?: CocoDecisionPrompt): void => {
      decision = question;
      decisionPrompt = prompt;
      if (sessionId && store.isCocoTurnActive(sessionId, access.id)) store.cancelTurn(sessionId,"coco_stopped");
    };
    let approved = repository.list<CocoToolApproval>("toolApproval").find(a => a.workId === work.id && a.revision === work.revision && a.status === "approved");
    if (approved && approved.scope !== scope) { repository.put("toolApproval", { ...approved, status: "denied" }); return { summary: "Authorization changed. Review the tool invocation again.", waiting: "Authorization changed. Review the tool invocation again.", evidence: {} }; }
    const matchesApproval = (name: string, args: JsonObject): boolean => Boolean(approved?.status === "approved" && repository.get<CocoWork>("work", work.id)?.revision === approved.revision && approved.toolName === name && cocoFingerprint(approved.arguments) === cocoFingerprint(args) && approved.scope === scope);
    const askApproval = (name: string, args: JsonObject, reason: string): void => {
      const pending = repository.list<CocoToolApproval>("toolApproval").find(a => a.workId === work.id && a.revision === work.revision && a.scope === scope && a.status === "pending" && a.toolName === name && cocoFingerprint(a.arguments) === cocoFingerprint(args));
      if (!pending) repository.put("toolApproval", { id: randomUUID(), workId: work.id, revision: work.revision, scope, toolName: name, arguments: args, reason, at: Date.now(), status: "pending" } satisfies CocoToolApproval);
      decide(reason);
    };
    const configuredMcp = (name: string) => {
      const server = mcpManager.listRuntime().find(s => s.enabled && s.status === "connected" && s.tools.some(t => t.registryName === name));
      if (!server) throw new Error("MCP service is disabled or disconnected");
      return { server, tool: server.tools.find(t => t.registryName === name)! };
    };
    const policy = createCocoPolicy(workspace.path, deniedRoots, work.runMode !== "ask", valid, { fullAccess: true, assertMcp: name => { configuredMcp(name); } });
    policy.assertPath(workspace.path);
    let toolAudit: { id: string; toolName: string; at: number; workId: string; revision: number; turnId?: string | undefined; argumentsHash: string; status: string } | undefined;
    const beforeToolExecute = (name: string, args: JsonObject): void => {
      policy.assertTool(name, args);
      if (matchesApproval(name, args)) { approved = { ...approved!, status: "consumed" }; repository.put("toolApproval", approved); }
      if (!name.startsWith("mcp__") && !["run_shell", "exec_command"].includes(name)) return;
      toolAudit = { id: randomUUID(), toolName: name, at: Date.now(), workId: work.id, revision: repository.get<CocoWork>("work", work.id)?.revision ?? work.revision, turnId:sessionId?store.getTurnLifecycle(sessionId)?.turnId:undefined, argumentsHash: cocoFingerprint(args), status: "admitted" };
      repository.put("toolInvocation", toolAudit);
    };
    const baseStream = meteredStream(signal, usage);
    const stream: StreamChatFn = async function* (client, options) {
      if (!deps.engine().ownsExecution()) throw new Error("CoCo execution ownership changed");
      yield* baseStream(client, options);
    };
    const summarize = summarizeFromStream(stream, signal);
    const access = registerCocoExecution({
      additionalTools: [workResults.tool(work.id, () => sessionId, () => valid() && !signal.aborted)],
      extraSystemPrompt: "When this task requires a report, publish the finished report with publish_coco_report before your final reply, using its complete Markdown or the exact path to its Markdown/text file. This saves the readable deliverable in CoCo's run results. Keep progress notes in the conversation. Publishing is not independent acceptance verification.",
      onSessionClaim: id => { sessionId=id;attachSession(id);const active=executing.get(work.id);if(active)active.sessionId=id; }, workspaceId: work.workspaceId, canStartTurn, allowWorkspace: id => id === work.workspaceId, signal, stream, summarize, ...policy, beforeToolExecute,
      ask: async question => {
        if (!valid()) return null;
        const latest = repository.get<CocoWork>("work", work.id);
        const result = await deps.engine().ask(work.id, { ...question, sessionId }, signal) as { action?: unknown; answer?: unknown; selections?: unknown; reason?: unknown };
        if (!valid() || latest?.revision !== repository.get<CocoWork>("work", work.id)?.revision) { decide("Requirements changed while resolving an execution question. Review the latest plan."); return null; }
        const options = Array.isArray(result?.selections) ? result.selections.filter((v): v is string => typeof v === "string") : typeof result?.answer === "string" ? [result.answer] : [];
        const custom = options.some(value => !question.options.includes(value));
        const answer = options.join(", ");
        const accepted = result?.action === "answer" && options.length > 0 && answer.length <= 12000 && (question.allowMultiple || options.length === 1) && (!custom || question.allowCustom);
        repository.put("supervision", { id: randomUUID(), at: Date.now(), workId: work.id, revision: latest?.revision, sessionId, question, action: accepted ? "answer" : "needs_user", answer: accepted ? answer : null, reason: typeof result?.reason === "string" ? result.reason.slice(0,4000) : "No reliable supervisory answer" });
        if (!accepted) {
          const reason = typeof result?.reason === "string" ? result.reason : "Your decision is needed.";
          const asked = Array.isArray(question.options) ? question.options.filter((value): value is string => typeof value === "string" && value.trim().length > 0) : [];
          const prompt: CocoDecisionPrompt = {
            question: question.question,
            options: asked,
            allowCustom: question.allowCustom !== false,
            ...(question.allowMultiple ? { allowMultiple: true } : {}),
          };
          const userAbort = new AbortController();
          const stopWait = (): void => userAbort.abort();
          signal.addEventListener("abort", stopWait, { once: true });
          const watch = setInterval(() => { if (sessionId && !store.isTurnActive(sessionId)) userAbort.abort(); }, 200);
          awaitingUser = true;
          let picked: string | null = null;
          try {
            picked = await deps.engine().awaitWorkAnswer(work.id, `${question.question}\n${reason}`, prompt, userAbort.signal);
          } finally {
            clearInterval(watch);
            signal.removeEventListener("abort", stopWait);
            awaitingUser = false;
          }
          if (!picked) return null;
          const parts = question.allowMultiple ? picked.split(", ").map(part => part.trim()).filter(Boolean) : [picked];
          const pickedCustom = asked.length === 0 || parts.some(part => !asked.includes(part));
          repository.put("supervision", { id: randomUUID(), at: Date.now(), workId: work.id, revision: latest?.revision, sessionId, question, action: "answer", answer: picked.slice(0, 12000), reason: "Answered by you" });
          return { selected: picked, custom: pickedCustom, ...(parts.length > 1 && !pickedCustom ? { selections: parts } : {}) };
        }
        return { selected: answer, custom, ...(options.length > 1 ? { selections: options } : {}) };
      },
      confirm: async input => {
        if (matchesApproval(input.toolName, input.arguments)) return true;
        const escalate = (): false => { askApproval(input.toolName, input.arguments, `Approval required: ${input.toolName}. ${input.risk?.reason ?? "Review the exact arguments before continuing."}`); return false; };
        if (requiresUserApproval(input) || !valid()) return escalate();
        const latest = repository.get<CocoWork>("work", work.id);
        let result: { reason?: unknown } | undefined;
        try {
          result = await deps.engine().ask(work.id, { question: toolApprovalQuestion(input, latest?.objective ?? work.objective), options: [...TOOL_APPROVAL_OPTIONS], allowCustom: false, sessionId }, signal) as typeof result;
        } catch {
          if (signal.aborted) return false;
          return escalate();
        }
        if (!valid() || latest?.revision !== repository.get<CocoWork>("work", work.id)?.revision) { decide("Requirements changed while reviewing a tool approval. Review the latest plan."); return false; }
        const verdict = parseToolApproval(result);
        repository.put("supervision", { id: randomUUID(), at: Date.now(), workId: work.id, revision: latest?.revision, sessionId, question: { question: `Tool approval: ${input.toolName}`, options: [...TOOL_APPROVAL_OPTIONS], allowCustom: false }, action: verdict === "needs-user" ? "needs_user" : "answer", answer: verdict === "needs-user" ? null : verdict ? "Approve" : "Deny", reason: typeof result?.reason === "string" ? result.reason.slice(0, 4000) : "No reliable supervisory answer" });
        return verdict === "needs-user" ? escalate() : verdict;
      },
      cocoShell: async input => {
        if (!valid()) throw new Error("CoCo authorization changed");
        const audit = toolAudit;
        if (audit) repository.put("toolInvocation", { ...audit, status: "started" });
        const result = await tools.shell({ ...input, signal: input.signal ? AbortSignal.any([signal, input.signal]) : signal }, deniedPaths);
        if (audit) repository.put("toolInvocation", { ...audit, status: result.status, exitCode: result.exitCode });
        return result;
      },
      cocoMcpCall: async (serverId, originalName, args, callSignal) => {
        const runtime = mcpManager.getRuntime(serverId), name = runtime?.tools.find(t => t.name === originalName)?.registryName;
        if (!name || !valid()) throw new Error("MCP authorization changed");
        configuredMcp(name);
        const config = mcpManager.getConfigs().find(s => s.id === serverId && s.enabled);
        if (!config) throw new Error("MCP service is no longer enabled");
        const audit = toolAudit;
        let sent = false;
        try {
          if (!valid()) throw new Error("MCP authorization changed");
          sent = true; if (audit) repository.put("toolInvocation", { ...audit, status: "started" });
          const result = await mcpManager.callTool(serverId, originalName, args, callSignal ? AbortSignal.any([signal, callSignal]) : signal);
          if (audit) repository.put("toolInvocation", { ...audit, status: "finished", returnCode: result.returnCode });
          return result;
        } catch (error) {
          if (audit) repository.put("toolInvocation", { ...audit, status: sent ? "outcome_unknown" : "not_sent" });
          interruption=sent ? "MCP outcome is unknown. Inspect the external system before retrying." : `MCP did not start: ${String(error)}`;
          if(sessionId&&store.isCocoTurnActive(sessionId,access.id))store.cancelTurn(sessionId,"coco_stopped");
          throw error;
        }
      },
    });
    const cancel = (): void => {
      store.clearCocoPrompts(access.id);
      if (sessionId && store.isCocoTurnActive(sessionId, access.id)) store.cancelTurn(sessionId,"coco_stopped");
    };
    const enqueue = (next: CocoWork, mode: "steer" | "append"): void => {
      if (!valid() || !sessionId) throw new Error("CoCo session changed");
      const queued = store.enqueueCocoPrompt({ sessionId, userText: instruction(next), mode: mode === "append" ? "deferred" : "interrupt" }, access.id);
      repository.put("dispatch", { id: queued.queued.id, at: Date.now(), workId: next.id, revision: next.revision, sessionId, mode, status: "queued" });
    };
    signal.addEventListener("abort", cancel, { once: true });
    executing.set(work.id, { id: access.id, enqueue });
    const offExhausted = budget.on("exhausted", budgetPause);
    try {
      // A deleted or archived linked session falls back to a new session; one moved to another project still fails.
      const existing = work.sessionId ? store.listSessions().find(s => s.id === work.sessionId && !s.archived) : undefined;
      if (existing && existing.workspaceId !== work.workspaceId) throw new Error("Linked session belongs to a different project");
      const linkedSessionId = existing?.id;
      const lifecycle=existing?store.getTurnLifecycle(existing.id):undefined;
      if(work.recovery && stoppedByUser(lifecycle))return {summary:"Paused by you",paused:"This session was stopped or paused by you. Resume it explicitly to continue.",evidence:{}};
      if (existing && ["paused", "cancelled"].includes(existing.status) && !work.resumeSession) throw new Error("The linked session was paused or cancelled. Resume it explicitly before CoCo continues.");
      if (existing && store.isTurnActive(existing.id)) {
        if (approved) throw new Error("Wait for the linked session to finish before replaying the approved operation");
        sessionId = existing.id;
        unsupervise = store.superviseCocoSession(sessionId, access.id);
        attachSession(sessionId);
        executing.set(work.id, { id: access.id, sessionId, enqueue });
        enqueue(work, work.sessionStrategy === "append" ? "append" : "steer");
      } else {
        if (linkedSessionId) {
          const selected = await resolveClient(root, workspace.path, work.providerId || settings.providerId || undefined);
          await store.setSessionProvider(linkedSessionId, selected.providerId);
        }
        signal.throwIfAborted();
        const replay = approved && linkedSessionId ? store.prepareCocoTool(linkedSessionId, access.id, approved.toolName, approved.arguments) : undefined;
        const advance = work.advancePrompt?.trim() ?? "";
        if (advance) {
          const saved = repository.get<CocoWork>("work", work.id);
          if (saved?.advancePrompt) repository.put("work", { ...saved, advancePrompt: undefined });
        }
        dispatching = true;
        const started = await store.startTurn({ ...(replay ? { suppressUserMessage: true, resumeToolBatch: replay } : {}), ...(linkedSessionId ? { sessionId: linkedSessionId } : {}), workspaceId: work.workspaceId, providerId: work.providerId || settings.providerId, title: work.title, userText: advance && linkedSessionId ? advance : work.recovery && linkedSessionId ? "Continue" : instruction(work), ...(work.recovery?{continuation:"retry" as const}:{}), fullPermissions: true, source: "coco", runMode: work.runMode ?? "agent", ...(work.reasoningEffort ? { reasoningEffort: work.reasoningEffort } : {}), composerInfinite: false, cocoExecutionId: access.id });
        dispatching = false;
        sessionId = started.sessionId;
        unsupervise = store.superviseCocoSession(sessionId, access.id);
        executing.set(work.id, { id: access.id, sessionId, enqueue });
        if (signal.aborted) cancel();
        else attachSession(sessionId);
        repository.put("dispatch", { id: randomUUID(), at: Date.now(), workId: work.id, revision: work.revision, sessionId, mode: existing ? "continue" : "create", status: "started" });
      }
      const deadline = Date.now() + 30 * 60000;
      // The turn may have started after an `exhausted` edge already fired.
      if (cooling()) budgetPause();
      while (store.isTurnActive(sessionId) || store.hasCocoPrompts(access.id) || dispatching) {
        if (decision && !store.isCocoTurnActive(sessionId, access.id)) break;
        if (!store.isTurnActive(sessionId) && store.hasCocoPrompts(access.id)) {
          if (!canStartTurn()) return { summary: cooling() ? "Token budget reached; paused until the budget resets." : "Saved continuation returned to the queue for updated instructions or higher-priority work", deferred: true, ...(cooling() ? { budgetHold: true } : {}), evidence: {} };
          const pending = store.getSessionTail(sessionId, { turns: 1 })?.session;
          if (pending && (pending.pendingUserAsk || ["error", "cancelled", "paused"].includes(pending.status))) { decision = "The linked session stopped or is waiting for input. Review its state before continuing."; break; }
        }
        if (!awaitingUser && Date.now() > deadline) { interruption = "The execution turn exceeded its time limit. Inspect progress and recover the saved session."; cancel(); if (!store.isCocoTurnActive(sessionId, access.id)) break; }
        if (signal.aborted) { cancel(); if (!store.isCocoTurnActive(sessionId, access.id)) break; }
        if (!valid()) { decision = "CoCo authorization or service configuration changed. Review before continuing."; cancel(); if (!store.isCocoTurnActive(sessionId, access.id)) break; }
        await new Promise(resolveWait => setTimeout(resolveWait, 100));
      }
      signal.throwIfAborted();
      const session = store.getSessionTail(sessionId, { turns: 1 });
      if (!session) throw new Error("Execution session disappeared");
      const status = store.listSessions().find(s => s.id === sessionId)?.status;
      const ended=store.getTurnLifecycle(sessionId);
      if (!decision && (budgetPaused || pausedForBudget(ended) || (cooling() && status === "paused"))) {
        return { summary: "Token budget reached; paused until the budget resets.", deferred: true, budgetHold: true, evidence: session };
      }
      if(!decision && stoppedByUser(ended))return {summary:"Paused by you",paused:"The task session was stopped or paused by you. CoCo will wait for an explicit resume.",evidence:session};
      if (!decision && ["error", "cancelled", "paused", "running"].includes(status ?? "")) interruption ||= ended?.error || session.session.progressText || "The task session was interrupted before completion.";
      return { summary: decision || interruption || "Turn finished; awaiting independent verification", ...(decision ? { waiting: decision, ...(decisionPrompt ? { decisionPrompt } : {}) } : interruption ? { interrupted:interruption } : {}), evidence: session };
    } finally { offExhausted(); signal.removeEventListener("abort", cancel); unsupervise?.(); store.clearCocoPrompts(access.id); executing.delete(work.id); access.release(); }
  };
  return { execute, followup };
}
