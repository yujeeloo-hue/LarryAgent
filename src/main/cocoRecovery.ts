import type { CocoPorts } from "../coco/engine.js";
import { ruleAuthorizes } from "../coco/scope.js";
import { abnormalInterruption, stoppedByUser } from "../coco/status.js";
import type { CocoRule } from "../coco/types.js";
import type { CocoServiceDeps } from "./cocoServiceDeps.js";

/** Decide how an interrupted task continues: resume the saved session, verify, wait, or ask the user. */
export function createCocoRecover(deps: CocoServiceDeps, ports: Pick<CocoPorts, "model">): NonNullable<CocoPorts["recover"]> {
  const { store, repository } = deps;
  const { model } = ports;
  const recover: NonNullable<CocoPorts["recover"]> = async (work,settings,signal,usage) => {
    if(!work.sessionId)return {action:"needs_user",summary:"The interrupted task has no saved execution session."};
    const current=deps.context(settings), session=store.getSessionTail(work.sessionId,{turns:3})?.session;
    if(!session || !current.workspaces.some(w=>w.id===work.workspaceId) || session.workspaceId!==work.workspaceId) return {action:"needs_user",summary:"The execution session or its project is unavailable. Review the task before continuing."};
    for(const id of work.ruleIds){const rule=repository.get<CocoRule>("rule",id);if(!ruleAuthorizes(rule, work.workspaceId))return {action:"wait",summary:"A source rule was paused, removed or restricted. This task remains paused."};}
    const lifecycle=store.getTurnLifecycle(work.sessionId);
    if(lifecycle && stoppedByUser(lifecycle)) return {action:"wait",summary:"This session was stopped or paused by you. CoCo will wait for an explicit resume.",turnId:lifecycle.turnId};
    if(!lifecycle)return {action:"needs_user",summary:"The previous session has no reliable interruption record. Review it before resuming."};
    if(store.isTurnActive(work.sessionId))return {action:"wait",summary:"The session is already being followed by an active turn. Its existing work is preserved.",turnId:lifecycle.turnId};
    const audits=repository.list<{workId:string;turnId?:string;at:number;status:string;toolName:string}>("toolInvocation").filter(a=>a.workId===work.id&&(a.turnId?a.turnId===lifecycle.turnId:a.at>=lifecycle.startedAt)&&["admitted","started","timeout","cancelled","outcome_unknown"].includes(a.status));
    const uncertainEffects=lifecycle.pendingEffects.length>0 || audits.length>0;
    if (uncertainEffects) return { action: "needs_user", summary: "The interrupted operation may already have taken effect. Review it before continuing.", turnId: lifecycle.turnId, uncertainEffects: true };
    if (abnormalInterruption(lifecycle)) {
      store.normalizeInterruptedTurn(work.sessionId);
      return { action: "resume", summary: "The session was interrupted. Continuing it.", turnId: lifecycle.turnId, uncertainEffects: false };
    }
    signal.throwIfAborted();
    const result=await model("recover",{work,interruption:lifecycle,uncertainEffects,toolAudits:audits},signal,usage,work.providerId||settings.providerId,`recover:${work.id}:${lifecycle.turnId}`) as {action?:unknown;summary?:unknown};
    if(!["resume","verify","needs_user"].includes(String(result?.action)) || typeof result?.summary!=="string" || !result.summary.trim())throw new Error("Recovery did not produce a reliable continuation decision");
    const now=store.getTurnLifecycle(work.sessionId);
    if(now?.turnId!==lifecycle.turnId || stoppedByUser(now))return {action:"wait",summary:"The session changed while recovery was being checked. Your current session state is preserved.",turnId:now?.turnId};
    if(result.action==="resume")store.normalizeInterruptedTurn(work.sessionId);
    return {action:result.action as "resume"|"verify"|"needs_user",summary:result.summary.slice(0,12000),turnId:lifecycle.turnId,uncertainEffects};
  };
  return recover;
}
