import { createHash, randomUUID } from "node:crypto";
import { estimateTokensFromText } from "../agent/estimateTokens.js";
import type { StreamChatFn } from "../agent/types.js";
import type { CocoContextReadArgs } from "./cocoContextReader.js";
import { cancelOwnedTurn, summarizeFromStream, waitForTurn } from "./cocoTurn.js";
import { CocoContextCapacityError, isContextCapacityError } from "../coco/contextErrors.js";
import { registerCocoExecution } from "../coco/executionAccess.js";
import type { CocoRepository } from "../coco/repository.js";
import type { JsonObject } from "../session/types.js";
import { readWorkspaceSettings, resolveContextLimitTokens } from "../settings/index.js";
import { getCocoPrompt } from "../settings/promptDefaults.js";
import type { RegisteredTool, ToolExecuteResult } from "../tools/types.js";
import { resolveClient, type SessionStore } from "./sessionRuntime.js";
import { pruneFinishedBackgroundSessions, type CocoBackgroundSession } from "./cocoBackgroundTasks.js";

const record=(value:unknown):Record<string,unknown>=>value && typeof value==="object" && !Array.isArray(value)?value as Record<string,unknown>:{};
const result=(value:unknown):ToolExecuteResult=>({returnCode:0,content:[{type:"text",text:JSON.stringify(value)}]});

/** A preview is explicitly incomplete. Every original value remains addressable. */
export function previewBackgroundInput(value:unknown,path:string[]=[],depth=0):unknown {
  if(typeof value==="string")return value.length<=320?value:{preview:value.slice(0,320),characters:value.length,readPath:path};
  if(Array.isArray(value))return {items:value.slice(0,12).map((v,i)=>previewBackgroundInput(v,[...path,String(i)],depth+1)),total:value.length,readPath:path};
  if(value && typeof value==="object"){
    if(depth>=4)return {fields:Object.keys(value),readPath:path};
    return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,previewBackgroundInput(v,[...path,k],depth+1)]));
  }
  return value;
}
export function readBackgroundInput(input:unknown,args:JsonObject,limit:number):unknown {
  const path=args.path??[];
  if(!Array.isArray(path)||path.length>30||path.some(k=>typeof k!=="string" && !(typeof k==="number" && Number.isSafeInteger(k) && k>=0)))throw new Error("Use an array of input field names and array indexes.");
  const keys = path.map(String);
  let value:unknown=input;
  for(const key of keys){
    if(!value||typeof value!=="object"||!Object.hasOwn(value,key)||["__proto__","prototype","constructor"].includes(key))throw new Error("Input field is unavailable.");
    value=(value as Record<string,unknown>)[key];
  }
  const offset=args.offset??0;
  if(typeof offset!=="number"||!Number.isSafeInteger(offset)||offset<0)throw new Error("Invalid input offset.");
  if(typeof value==="string")return {path:keys,content:value.slice(offset,offset+limit),totalCharacters:value.length,...(offset+limit<value.length?{nextOffset:offset+limit}:{})};
  if(Array.isArray(value))return {path:keys,items:value.slice(offset,offset+12).map((v,i)=>previewBackgroundInput(v,[...keys,String(offset+i)])),total:value.length,...(offset+12<value.length?{nextOffset:offset+12}:{})};
  return previewBackgroundInput(value,keys);
}

/** Read-only background work uses the same persisted native turn host as Chat/execution. */
export async function runCocoBackground(input:{
  root:string;store:SessionStore;repository:CocoRepository;purpose:string;input:unknown;prompt:string;
  workspaceId:string|undefined;providerId:string;operationId:string|undefined;signal:AbortSignal;
  /** When set, this plain text is the user message. `input` stays available to coco_job_input. */
  userText?: string; workId?: string;
  requireReadField?:string; timeoutMs?:number;
  /** Throws to reject a submitted result; the message is returned to the model so it can rewrite in place. */
  check?(result:Record<string,unknown>):void;
  valid():boolean;stream:StreamChatFn;readContext?(args:CocoContextReadArgs):Promise<unknown>;
}):Promise<unknown>{
  const {store,repository}=input;
  const timeout = input.timeoutMs ?? (input.purpose === "recover" ? 300000 : undefined);
  const timeoutSignal = timeout === undefined ? undefined : AbortSignal.timeout(timeout);
  const signal = timeoutSignal ? AbortSignal.any([input.signal, timeoutSignal]) : input.signal;
  if(!input.workspaceId)throw new Error("No accessible project is available for this background operation.");
  const workspace=store.listWorkspaces().find(w=>w.id===input.workspaceId);if(!workspace)throw new Error("Background project is unavailable.");
  const serialized=input.userText ?? JSON.stringify(input.input);
  const key=input.operationId??`${input.purpose}:${createHash("sha256").update(serialized).digest("hex")}`;
  const id=`${key}:${repository.meta("contextSince",0)}`;
  const saved=repository.get<CocoBackgroundSession>("backgroundSession",id);
  let sessionId=saved?.sessionId;
  const existing=sessionId?store.getSessionTail(sessionId,{turns:1})?.session:undefined;
  const reusable=existing?.source==="coco_internal"&&existing.workspaceId===workspace.id;
  if(!reusable)sessionId=undefined;
  const startedAt=Date.now();
  let background: CocoBackgroundSession = { id, sessionId, purpose:input.purpose, operationId:input.operationId,
    workId: input.workId ?? (typeof record(record(input.input).work).id === "string" ? String(record(record(input.input).work).id) : undefined),
    at:startedAt, startedAt:saved?.startedAt ?? saved?.at ?? startedAt, contextSince:repository.meta("contextSince",0), status:"running" };
  const complete=(value:unknown):unknown=>{
    const data=record(value);
    const summary=[data.summary,data.reply,data.markdown].find(value=>typeof value==="string")
      ?? (Array.isArray(data.checks)?data.checks.map(check=>{const item=record(check);return `${item.passed===true?"Passed":"Failed"}: ${item.evidence??item.criterionId??"Check"}`;}).join("\n"):"Check completed.");
    background={...background,status:"completed",summary:String(summary).slice(0,2000)};
    return value;
  };
  repository.put("backgroundInput",{id,input:input.input,at:Date.now()});
  const limit=resolveContextLimitTokens(await readWorkspaceSettings(input.root));
  const pageCharacters=Math.max(512,Math.min(12000,Math.floor(limit*.08)));
  const fullInitial=estimateTokensFromText(serialized)<=Math.min(16000,Math.floor(limit*.15));
  const initial=input.userText
    ? (fullInitial ? input.userText : `${input.userText.slice(0, pageCharacters)}\n\nThe rest of this review was left out. Read it with coco_job_input before deciding. Do not guess the omitted part.`)
    : (fullInitial ? serialized : JSON.stringify({inputPreview:previewBackgroundInput(input.input),guidance:"This preview is incomplete. Use coco_job_input with the supplied readPath and offsets to read the complete current goal, criteria and relevant evidence. Do not assume omitted content or infer success from a preview."}));
  const requiredSource=input.requireReadField?record(input.input)[input.requireReadField]:undefined;
  const ranges:[number,number][]=[];
  const requireComplete=()=>{
    if(fullInitial||typeof requiredSource!=="string")return;
    let through=0;for(const [start,end] of [...ranges].sort((a,b)=>a[0]-b[0])){if(start>through)break;through=Math.max(through,end);}
    if(through<requiredSource.length)throw new Error(`Read the full ${input.requireReadField} with coco_job_input before saving a retention summary. First unread offset: ${through}. Source details will be preserved until coverage is complete.`);
  };
  let submitted:unknown;
  const ensureValid=()=>{signal.throwIfAborted();if(!input.valid())throw new Error("CoCo background access changed.");};
  const localTools:RegisteredTool[]=[{
    definition:{name:"coco_job_input",description:"Read the complete current background operation input by field path. Empty path shows the index. Follow nextOffset until the required goal, acceptance criteria or evidence has been read; previews are incomplete.",defaultPermissionLevel:0,parameters:{type:"object",properties:{path:{type:"array",items:{anyOf:[{type:"string"},{type:"integer",minimum:0}]}},offset:{type:"integer",minimum:0}}}},
    execute:async args=>{ensureValid();const page=readBackgroundInput(input.input,args,pageCharacters);if(input.requireReadField && Array.isArray(args.path) && args.path.length===1 && args.path[0]===input.requireReadField && typeof record(page).content==="string"){const offset=typeof args.offset==="number"?args.offset:0;ranges.push([offset,offset+String(record(page).content).length]);}return result(page);},
  },{
    definition:{name:"submit_coco_result",description:"Save the structured background result once all required input and evidence have been inspected.",defaultPermissionLevel:0,parameters:{type:"object",properties:{result:{type:"object"}},required:["result"]}},
    execute:async args=>{ensureValid();if(!args.result||typeof args.result!=="object"||Array.isArray(args.result))throw new Error("Use a result object.");requireComplete();input.check?.(args.result as Record<string,unknown>);submitted=args.result;return result({saved:true});},
  }];
  if(input.readContext)localTools.push({definition:{name:"read_coco_context",description:"Read an authorized project file, list a directory, search file text with pattern, or read a session. Large results are stored and can be paged with coco_job_input at readResults.<readId>.",defaultPermissionLevel:0,parameters:{type:"object",properties:{workspaceId:{type:"string"},sessionId:{type:"string"},path:{type:"string"},pattern:{type:"string",description:"Case-insensitive text to find under path, or under the project root when path is omitted."},query:{type:"string"},workId:{type:"string"}},required:["workspaceId"]}},execute:async args=>{
    ensureValid();const value=await input.readContext!(args);const text=JSON.stringify(value);
    if(text.length<=pageCharacters)return result(value);
    const readId=randomUUID(),data=record(input.input);data.readResults={...record(data.readResults),[readId]:value};
    repository.put("backgroundInput",{id,input:input.input,at:Date.now()});
    return result({readId,readPath:["readResults",readId],preview:previewBackgroundInput(value,["readResults",readId])});
  }});
  const summarize=summarizeFromStream(input.stream,signal,{purpose:"compact"});
  const stream:StreamChatFn=async function*(client,options){
    // Result submission is terminal for this internal operation. Let the native
    // host finish/checkpoint the tool round without another paid model request.
    if(submitted!==undefined){yield {type:"text_delta",text:"Structured background result saved."};return;}
    yield* input.stream(client,{...options,signal:options.signal ? AbortSignal.any([signal,options.signal]) : signal});
  };
  const assertTool=(name:string)=>{ensureValid();if(!localTools.some(t=>t.definition.name===name))throw new Error("Background planning and verification use read-only context tools. Delegate execution to a project work session.");};
  const access=registerCocoExecution({role:"background",workspaceId:workspace.id,signal,canStartTurn:input.valid,stream,summarize,additionalTools:localTools,extraSystemPrompt:`${input.prompt}\n${getCocoPrompt("background")}`,
    onSessionClaim:sessionId=>{background={...background,sessionId};repository.put("backgroundSession",background);},
    assertTool,beforeToolExecute:assertTool,assertPath:()=>{throw new Error("Use the scoped context reader.");},
  });
  try{
    if(sessionId){const client=await resolveClient(input.root,workspace.path,input.providerId||undefined);await store.setSessionProvider(sessionId,client.providerId);}
    let retryPrompt="This background operation requires a structured result. Call submit_coco_result with the requested result object. Use coco_job_input to inspect current input if necessary; do not return a Markdown list.";
    for(let attempt=0;attempt<3;attempt++){
      ensureValid();
      const started=await store.startTurn({...(sessionId?{sessionId}:{}),workspaceId:workspace.id,providerId:input.providerId,source:"coco_internal",userText:attempt===0?initial:retryPrompt,...(attempt>0?{continuation:"retry" as const}:{}),runMode:"agent",composerInfinite:false,fullPermissions:true,cocoExecutionId:access.id});
      sessionId=started.sessionId;
      await waitForTurn(store,sessionId,()=>signal.aborted||!input.valid(),20);
      ensureValid();
      const session=store.getSessionTail(sessionId,{turns:1})?.session;
      if(session?.status==="error"){
        const error=store.getTurnLifecycle(sessionId)?.error??session.progressText??"Background session failed.";
        if(isContextCapacityError(error)){
          if(attempt>=2)throw new CocoContextCapacityError();
          await store.compactSession(sessionId,access.id);
          ensureValid();retryPrompt="Context compaction was requested through the native Session mechanism. Continue the current operation using the saved context and coco_job_input. Re-read only the necessary current evidence, then submit the structured result.";
          continue;
        }
        throw new Error(error);
      }
      if(submitted!==undefined)return complete(submitted);
      const text=session?.messages.filter(m=>m.role==="assistant").flatMap(m=>m.parts.flatMap(p=>p.type==="text"?[p.text]:[])).join("\n").trim().replace(/^```(?:json)?\s*/i,"").replace(/\s*```$/,"");
      let value:unknown;
      try{value=JSON.parse(text??"");}catch{ /* Native retry receives corrective feedback in the same session. */ }
      if(value&&typeof value==="object"&&!Array.isArray(value)){
        try{requireComplete();input.check?.(value as Record<string,unknown>);return complete(value);}
        catch(error){retryPrompt=`${error instanceof Error?error.message:String(error)} Submit the corrected result with submit_coco_result.`;}
      }
    }
    throw new Error("CoCo could not produce a structured result. No new work was accepted.");
  }catch(error){
    const timedOut=timeoutSignal?.aborted && !input.signal.aborted;
    const message=timedOut ? "Recovery review timed out. CoCo will retry within its recovery limit; the saved task is preserved." : error instanceof Error?error.message:String(error);
    background={...background,status:input.signal.aborted?"interrupted":"error",summary:message};
    throw timedOut?new Error(message):error;
  }finally{
    await cancelOwnedTurn(store,sessionId,access.id);
    access.release();
    repository.put("backgroundSession",{...background,endedAt:Date.now()});
    try{pruneFinishedBackgroundSessions(repository,store,Date.now());}catch(error){console.warn("[coco] background session prune failed",error);}
  }
}
