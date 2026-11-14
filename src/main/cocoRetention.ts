import type { CocoJob, CocoMessage, CocoSettings, CocoWork } from "../coco/types.js";
import type { CocoRepository } from "../coco/repository.js";
import type { SessionStore } from "./sessionRuntime.js";
import type { CocoRetentionSlice } from "../session/cocoRetention.js";

type BackgroundRecord={id:string;sessionId:string;operationId?:string;workId?:string;purpose?:string;detailsClearedAt?:number;at:number};
export async function retainCocoHistory(input:{store:SessionStore;repository:CocoRepository;settings:CocoSettings;now:number;signal:AbortSignal;canContinue():boolean;summarize(slice:CocoRetentionSlice,operationId:string):Promise<{summary:string}>}):Promise<void>{
  const {store,repository,settings,signal}=input;
  if(!settings.historyRetentionDays)return;
  // A crash may occur after pruning the source but before disposing of the
  // temporary analysis transcript. Remove those stale copies without new LLM
  // calls; the source conversation's retained summary remains authoritative.
  for(const temporary of repository.list<BackgroundRecord>("backgroundSession").filter(s=>s.purpose==="retention"&&!s.detailsClearedAt)){
    if(store.isTurnActive(temporary.sessionId))continue;
    const copy=store.cocoRetentionCandidates(input.now+1000).find(s=>s.sessionId===temporary.sessionId);
    if(!copy || store.pruneCocoHistory(copy,"Temporary retention analysis was cleared. The source conversation and its retained summary remain authoritative."))repository.put("backgroundSession",{...temporary,detailsClearedAt:input.now});
    repository.remove("backgroundInput",temporary.id);
  }
  const cutoff=input.now-settings.historyRetentionDays*86400000;
  const candidates=store.cocoRetentionCandidates(cutoff);
  const protectedWork=()=>repository.list<CocoWork>("work").filter(w=>!["completed","cancelled"].includes(w.status));
  const protectedSlice=(slice:CocoRetentionSlice)=>{
    if(settings.excludedWorkspaceIds.includes(slice.workspaceId))return true;
    const work=protectedWork(),pending=repository.pending<CocoJob>("job").filter(j=>j.kind!=="cleanup");
    if(slice.source==="coco_chat" && (work.length || pending.some(j=>["chat","plan","decision"].includes(j.kind))))return true;
    const source=repository.list<BackgroundRecord>("backgroundSession").find(s=>s.sessionId===slice.sessionId);
    if(settings.excludedWorkspaceIds.length && (source?!source.id.endsWith(`:${repository.meta("contextSince",0)}`):slice.sessionId!==repository.meta("chatSessionId","")))return true;
    const jobId=source?.operationId??source?.id.split(":")[0],job=jobId?repository.get<CocoJob>("job",jobId):undefined;
    if(job && job.status!=="done")return true;
    return work.some(w=>w.sessionId===slice.sessionId || w.observeSessionId===slice.sessionId || w.id===source?.workId || w.id===job?.workId || (job?.messageId && (w.goalId===job.messageId||w.goalIds?.includes(job.messageId))));
  };
  let processed=0;
  for(const slice of candidates){
    signal.throwIfAborted();if(!input.canContinue())break;if(protectedSlice(slice))continue;if(processed++>=20)break;
    const operationId=`retention-${slice.sessionId}-${Math.floor(cutoff/86400000)}`;
    let summary="",pruned=false;
    try{
      ({summary}=await input.summarize(slice,operationId));signal.throwIfAborted();
      if(!summary.trim()||summary.length>100000)throw new Error("History summary was empty or oversized; details were preserved.");
      if(protectedSlice(slice))continue;
      pruned=store.pruneCocoHistory(slice,summary);
      if(!pruned)continue;
      repository.put("retainedHistory",{id:slice.sessionId,at:input.now,cutoff,summary,messageIds:slice.messageIds});
      if(slice.source==="coco_chat"){
        const latestExpired=Math.max(...slice.messages.filter(m=>!m.parts.some(p=>p.type==="context_compaction")).map(m=>m.createdAt));
        for(const message of repository.list<CocoMessage>("message"))if(message.at<cutoff && message.at<=latestExpired)repository.put("message",{...message,text:"[Detailed conversation removed by history retention. Task links and the retained summary remain.]"});
      }
      const source=repository.list<BackgroundRecord>("backgroundSession").find(s=>s.sessionId===slice.sessionId);
      if(source)repository.remove("backgroundInput",source.id);
    }finally{
      // Retention analysis itself contains copies of old evidence. Retain only
      // its summary/status, including on failure; never delete the source first.
      const temporary=repository.list<BackgroundRecord>("backgroundSession").find(s=>s.operationId===operationId||s.id.startsWith(`${operationId}:`));
      if(temporary){
        const copy=store.cocoRetentionCandidates(Date.now()+1000).find(s=>s.sessionId===temporary.sessionId);
        if(!copy || store.pruneCocoHistory(copy,summary || "Retention analysis did not finish. The source conversation was preserved."))repository.put("backgroundSession",{...temporary,detailsClearedAt:input.now});
        repository.remove("backgroundInput",temporary.id);
      }
      repository.put("retentionAudit",{id:`${operationId}:${input.now}`,at:input.now,sessionId:slice.sessionId,status:pruned?"pruned":"preserved",removedMessages:pruned?slice.messageIds.length:0});
    }
  }
}
