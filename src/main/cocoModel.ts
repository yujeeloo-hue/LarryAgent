import type { CocoContext, CocoPorts } from "../coco/engine.js";
import { sameExecutionAuthority } from "../coco/scope.js";
import type { CocoWork, CocoWorkResult } from "../coco/types.js";
import { checkRuleRunBrief } from "../coco/validation.js";
import { getCocoPrompt } from "../settings/promptDefaults.js";
import { runCocoBackground } from "./cocoBackground.js";
import { createCocoContextReader, type CocoContextReadArgs } from "./cocoContextReader.js";
import { meteredStream } from "./cocoMetering.js";
import { buildVerifyInput } from "./cocoVerifyInput.js";
import type { CocoServiceDeps } from "./cocoServiceDeps.js";

/** Structured read-only model operations (plan / verify / decide / recover / report) on a native background session. */
export function createCocoModel(deps: CocoServiceDeps): CocoPorts["model"] {
  const { root, store, repository } = deps;
  const model = async (purpose: string, input: unknown, signal: AbortSignal, usage: (tokens: number, estimated: boolean, id: string) => void, providerId: string, operationId?: string): Promise<unknown> => {
    if (!deps.engine().ownsExecution()) throw new Error("CoCo execution ownership changed");
    const settings = deps.engine().settings();
    const allowed=(input as {context?:CocoContext}).context ?? deps.context(settings);
    const scopedWork=(input as {work?:CocoWork}).work;
    if (scopedWork && ["recover","verify"].includes(purpose)) {
      allowed.workspaces=allowed.workspaces.filter(workspace=>workspace.id===scopedWork.workspaceId);
      allowed.sessions=allowed.sessions.filter(session=>session.workspaceId===scopedWork.workspaceId);
    }
    const sessionId = scopedWork?.sessionId ?? scopedWork?.observeSessionId;
    const review = (purpose === "verify" || purpose === "recover") && scopedWork
      ? buildVerifyInput(scopedWork, sessionId ? store.getSession(sessionId)?.messages : undefined, repository.forWork<CocoWorkResult>("workResult", scopedWork.id).filter(result => result.revision === scopedWork.revision))
      : undefined;
    return runCocoBackground({root,store,repository,purpose,input:review === undefined ? input : { review },...(review === undefined ? {} : { userText: review, workId: scopedWork!.id }),signal,providerId,operationId,stream:meteredStream(signal,usage),
      prompt:getCocoPrompt(purpose === "plan" || purpose === "verify" || purpose === "decide" || purpose === "recover" ? purpose : "report"),
      ...(purpose === "plan" && (input as {rule?:unknown}).rule ? { check: checkRuleRunBrief } : {}),
      valid:()=>deps.alive() && deps.engine().ownsExecution() && sameExecutionAuthority(settings, deps.engine().settings()),
      workspaceId:(input as {preferredWorkspaceId?:string}).preferredWorkspaceId ?? (input as {work?:CocoWork;reference?:CocoWork}).work?.workspaceId ?? (input as {reference?:CocoWork}).reference?.workspaceId ?? allowed?.workspaces[0]?.id ?? deps.context(settings).workspaces[0]?.id,
      ...(["plan","recover","verify"].includes(purpose)?{readContext:async(args: CocoContextReadArgs)=>{
        try { return await createCocoContextReader({ store, repository, allowed: () => allowed, valid: () => deps.alive() && !signal.aborted })(args); }
        catch(error) {
          signal.throwIfAborted(); if(!deps.alive() || !deps.engine().ownsExecution())throw error;
          return {error:error instanceof Error?error.message:String(error),guidance:"Correct this read using the authorized project IDs and paths. A failed read does not revoke Full permissions."};
        }
      }}:{})
    });
  };
  return model;
}
