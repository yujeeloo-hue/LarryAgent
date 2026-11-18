import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionStore } from "./sessionRuntime.js";
import { runCocoBackground, readBackgroundInput } from "./cocoBackground.js";
import { CocoRepository } from "../coco/repository.js";
import { configureCredentialsRoot, configureLegacyKeyBridgeForTests } from "../llm/credentials.js";
import { configureUserMemoryRoot } from "../memory/store.js";
import { configurePromptDefaults } from "../settings/promptDefaults.js";
import { registerBuiltins } from "../tools/index.js";
import type { StreamChatFn } from "../agent/types.js";
import { cocoBackgroundTasks } from "./cocoBackgroundTasks.js";

test("background input pagination preserves the entire tail and rejects prototype paths",()=>{
  const text="前文".repeat(5000)+"TAIL_EVIDENCE";let offset=0,recovered="";
  do{const page=readBackgroundInput({text},{path:["text"],offset},513) as {content:string;nextOffset?:number};recovered+=page.content;if(page.nextOffset===undefined)break;offset=page.nextOffset;}while(true);
  assert.equal(recovered,text);assert.throws(()=>readBackgroundInput({}, {path:["__proto__"]},1000),/unavailable/);
  assert.deepEqual(readBackgroundInput({items:[{text:"Indexed evidence"}]},{path:["items",0,"text"]},100),{path:["items","0","text"],content:"Indexed evidence",totalCharacters:16});
});

test("large background input uses a persisted native session, pages evidence and automatically compacts",{timeout:20000},async()=>{
  const root=mkdtempSync(join(tmpdir(),"coco-native-background-"));
  configureCredentialsRoot(root);configureLegacyKeyBridgeForTests(null);configureUserMemoryRoot(root);configurePromptDefaults(join(process.cwd(),"resources/prompts"));registerBuiltins();
  writeFileSync(join(root,"settings.json"),JSON.stringify({providers:[{id:"local",name:"Fixture",baseUrl:"http://127.0.0.1:9/v1",modelId:"native-background"}],activeProviderId:"local",contextLimitTokens:16000,compactTriggerRatio:.5,iterationProtectRawIterationCount:1,iterationProtectTokenRatio:.1,maxModelIterations:30,userMemoryAutoExtract:false,projectMemoryAutoExtract:false}));
  let store=createSessionStore(root,{startBackgroundServices:false});
  const workspaceId=(await store.createWorkspace({name:"Background",path:root})).id;
  const source=Array.from({length:70000},(_,i)=>`finding-${i}: evidence is pending\n`).join("")+"TAIL_EVIDENCE";
  let calls=0,compactions=0,reads=0;
  const stream:StreamChatFn=async function*(_client,options){
    if(options.meta?.purpose==="compact"){compactions++;yield {type:"text_delta",text:"Earlier read-only evidence pages were inspected. No execution took place. The remaining task is to read the tail and return a structured check with uncertainty preserved."};return;}
    calls++;
    if(reads<26){const offset=reads===25?source.length-30:reads*1280;reads++;yield {type:"tool_call",id:`read-${reads}`,name:"coco_job_input",arguments:{path:["evidence","content"],offset},argumentsRaw:JSON.stringify({path:["evidence","content"],offset})};return;}
    const transcript=JSON.stringify(options.messages);assert.match(transcript,/TAIL_EVIDENCE/);
    yield {type:"tool_call",id:"submit",name:"submit_coco_result",arguments:{result:{checks:[{criterionId:"tail",passed:true,evidence:"The final page contains TAIL_EVIDENCE"}]}},argumentsRaw:JSON.stringify({result:{checks:[{criterionId:"tail",passed:true,evidence:"The final page contains TAIL_EVIDENCE"}]}})};
  };
  const invoke=(activeStore:typeof store,activeStream:StreamChatFn)=>runCocoBackground({root,store:activeStore,repository:new CocoRepository(activeStore.database),purpose:"verify",operationId:"same-verification",workspaceId,providerId:"local",signal:new AbortController().signal,valid:()=>true,stream:activeStream,prompt:"You independently verify the current task using the original evidence. Return checks for criterion tail.",input:{work:{id:"work",objective:"Check the tail evidence",acceptance:[{id:"tail",kind:"review",description:"The final page contains TAIL_EVIDENCE"}]},evidence:{content:source}}});
  try{
    const value=await invoke(store,stream) as {checks:{passed:boolean}[]};assert.equal(value.checks[0]?.passed,true);assert.ok(compactions>0,"uses the native automatic compaction strategy");assert.equal(calls,27);
    const repository=new CocoRepository(store.database),saved=repository.list<{sessionId:string}>("backgroundSession")[0]!;
    assert.equal(store.getSession(saved.sessionId)?.source,"coco_internal");assert.equal(store.listSessions().length,0,"internal sessions do not appear as project execution tasks");
    assert.ok(JSON.stringify(store.getSession(saved.sessionId)?.messages).includes("context_compaction"));
    await assert.rejects(store.startTurn({sessionId:saved.sessionId,userText:"Untrusted resume",fullPermissions:true}),/background capability/);
    store.memorySync.stop();store.database.close();store=createSessionStore(root,{startBackgroundServices:false});
    let rejected=false,forcedCompactions=0;
    const plain:StreamChatFn=async function*(_client,options){
      if(options.meta?.purpose==="compact"){forcedCompactions++;yield {type:"text_delta",text:"Previous read-only checks are saved. Re-read current evidence before returning the structured result."};return;}
      if(!rejected){rejected=true;yield {type:"error",message:"maximum context length exceeded"};return;}
      yield {type:"text_delta",text:JSON.stringify({checks:[{criterionId:"tail",passed:true,evidence:"Current persisted evidence checked"}]})};
    };
    await invoke(store,plain);
    assert.ok(forcedCompactions>0,"provider capacity rejection requests native forced compaction before retry");
    assert.equal(new CocoRepository(store.database).list<{sessionId:string}>("backgroundSession")[0]?.sessionId,saved.sessionId,"retry/reopen reuses the original background session");
    const retentionSource="retained evidence ".repeat(1500);let offset=0,premature=true,sawCoverageFeedback=false;
    const retentionStream:StreamChatFn=async function*(_client,options){
      if(options.meta?.purpose==="compact"){yield {type:"text_delta",text:"Earlier retention pages were read. Preserve uncertainty and complete source coverage before saving."};return;}
      if(JSON.stringify(options.messages).includes("First unread offset"))sawCoverageFeedback=true;
      if(premature){premature=false;yield {type:"tool_call",id:"premature",name:"submit_coco_result",arguments:{result:{summary:"Incomplete"}},argumentsRaw:'{"result":{"summary":"Incomplete"}}'};return;}
      if(offset<retentionSource.length){const start=offset;offset+=1280;const args={path:["retentionSource"],offset:start};yield {type:"tool_call",id:`page-${start}`,name:"coco_job_input",arguments:args,argumentsRaw:JSON.stringify(args)};return;}
      yield {type:"tool_call",id:"complete",name:"submit_coco_result",arguments:{result:{summary:"All required source pages were read."}},argumentsRaw:'{"result":{"summary":"All required source pages were read."}}'};
    };
    const retained=await runCocoBackground({root,store,repository:new CocoRepository(store.database),purpose:"retention",operationId:"coverage-check",workspaceId,providerId:"local",signal:new AbortController().signal,valid:()=>true,stream:retentionStream,prompt:"Read all retentionSource pages before producing a summary.",requireReadField:"retentionSource",input:{retentionSource}}) as {summary:string};
    assert.ok(sawCoverageFeedback,"premature retention submission is rejected through native tool feedback");assert.match(retained.summary,/All required/);
  }finally{store.memorySync.stop();store.database.close();rmSync(root,{recursive:true,force:true});}
});

test("background checks offer only usable tools and publish live, completed and reopened history",{timeout:10000},async()=>{
  const root=mkdtempSync(join(tmpdir(),"coco-visible-check-"));
  configureCredentialsRoot(root);configureLegacyKeyBridgeForTests(null);configureUserMemoryRoot(root);configurePromptDefaults(join(process.cwd(),"resources/prompts"));registerBuiltins();
  writeFileSync(join(root,"settings.json"),JSON.stringify({providers:[{id:"local",name:"Fixture",baseUrl:"http://127.0.0.1:9/v1",modelId:"visible-check"}],activeProviderId:"local",userMemoryAutoExtract:false,projectMemoryAutoExtract:false}));
  let store=createSessionStore(root,{startBackgroundServices:false});
  const workspaceId=(await store.createWorkspace({name:"Visible checks",path:root})).id;
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let held=false,calls=0,reads=0;
  const stream:StreamChatFn=async function*(_client,options){
    assert.deepEqual(options.tools?.map(tool=>tool.function.name).sort(),["coco_job_input","read_coco_context","submit_coco_result"]);
    if(calls++===0){yield {type:"reasoning_delta",text:"Inspect the saved file before choosing a continuation."};yield {type:"tool_call",id:"context",name:"read_coco_context",arguments:{workspaceId,path:"proof.txt"},argumentsRaw:JSON.stringify({workspaceId,path:"proof.txt"})};return;}
    held=true;await gate;
    yield {type:"tool_call",id:"result",name:"submit_coco_result",arguments:{result:{action:"verify",summary:"The saved output is ready for acceptance."}},argumentsRaw:'{"result":{"action":"verify","summary":"The saved output is ready for acceptance."}}'};
  };
  const repository=new CocoRepository(store.database);
  const promise=runCocoBackground({root,store,repository,purpose:"recover",operationId:"recover-task",workspaceId,providerId:"local",signal:new AbortController().signal,valid:()=>true,stream,prompt:"Check saved task state",input:{work:{id:"work",workspaceId}},readContext:async args=>{reads++;assert.equal(args.path,"proof.txt");return {content:"saved output"};}});
  try{
    for(let i=0;i<100&&!held;i++)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(held);
    const running=cocoBackgroundTasks(repository,store,[workspaceId])[0]!;assert.equal(running.status,"running");assert.equal(running.purpose,"recover");assert.equal(running.workId,"work");assert.equal(reads,1);
    assert.match(JSON.stringify(store.getSession(running.sessionId)?.messages),/Inspect the saved file/);
    assert.deepEqual(cocoBackgroundTasks(repository,store,[]),[],"excluded project history is not projected");
    release();await promise;
    const done=cocoBackgroundTasks(repository,store,[workspaceId])[0]!;assert.equal(done.status,"completed");assert.match(done.summary,/ready for acceptance/);
    store.memorySync.stop();store.database.close();store=createSessionStore(root,{startBackgroundServices:false});
    const reopened=new CocoRepository(store.database);assert.equal(cocoBackgroundTasks(reopened,store,[workspaceId])[0]?.sessionId,running.sessionId);
    reopened.setMeta("contextSince",Date.now());assert.deepEqual(cocoBackgroundTasks(reopened,store,[workspaceId]),[],"revoked context history stays out of the current Chat");
  }finally{release();await promise.catch(()=>{});store.memorySync.stop();store.database.close();rmSync(root,{recursive:true,force:true});}
});

test("a result rejected by check is returned to the model as tool feedback and rewritten in place",{timeout:10000},async()=>{
  const root=mkdtempSync(join(tmpdir(),"coco-result-check-"));
  configureCredentialsRoot(root);configureLegacyKeyBridgeForTests(null);configureUserMemoryRoot(root);configurePromptDefaults(join(process.cwd(),"resources/prompts"));registerBuiltins();
  writeFileSync(join(root,"settings.json"),JSON.stringify({providers:[{id:"local",name:"Fixture",baseUrl:"http://127.0.0.1:9/v1",modelId:"check"}],activeProviderId:"local",userMemoryAutoExtract:false,projectMemoryAutoExtract:false}));
  const store=createSessionStore(root,{startBackgroundServices:false}),workspaceId=(await store.createWorkspace({name:"Check",path:root})).id,repository=new CocoRepository(store.database);
  let sawFeedback=false,submits=0;
  const stream:StreamChatFn=async function*(_client,options){
    if(JSON.stringify(options.messages).includes("BRIEF_TOO_LONG"))sawFeedback=true;
    const objective=submits++===0?"long investigation":"short brief";
    yield {type:"tool_call",id:`submit-${submits}`,name:"submit_coco_result",arguments:{result:{objective}},argumentsRaw:JSON.stringify({result:{objective}})};
  };
  try{
    const value=await runCocoBackground({root,store,repository,purpose:"plan",operationId:"check",workspaceId,providerId:"local",signal:new AbortController().signal,valid:()=>true,stream,prompt:"Plan",input:{},check:result=>{if(result.objective!=="short brief")throw new Error("BRIEF_TOO_LONG");}}) as {objective:string};
    assert.equal(value.objective,"short brief");assert.ok(sawFeedback,"the rejection reaches the model before it resubmits");
  }finally{store.memorySync.stop();store.database.close();rmSync(root,{recursive:true,force:true});}
});

test("an unresponsive recovery request is cancelled and recorded instead of staying Recovering",{timeout:5000},async()=>{
  const root=mkdtempSync(join(tmpdir(),"coco-recovery-timeout-"));
  configureCredentialsRoot(root);configureLegacyKeyBridgeForTests(null);configureUserMemoryRoot(root);configurePromptDefaults(join(process.cwd(),"resources/prompts"));registerBuiltins();
  writeFileSync(join(root,"settings.json"),JSON.stringify({providers:[{id:"local",name:"Fixture",baseUrl:"http://127.0.0.1:9/v1",modelId:"timeout"}],activeProviderId:"local",userMemoryAutoExtract:false,projectMemoryAutoExtract:false}));
  const store=createSessionStore(root,{startBackgroundServices:false}),workspaceId=(await store.createWorkspace({name:"Timeout",path:root})).id,repository=new CocoRepository(store.database);
  const stream:StreamChatFn=async function*(_client,options){yield {type:"reasoning_delta",text:"Checking interrupted work"};await new Promise<void>((_resolve,reject)=>{if(options.signal?.aborted)reject(options.signal.reason);else options.signal?.addEventListener("abort",()=>reject(options.signal!.reason),{once:true});});};
  try{
    await assert.rejects(runCocoBackground({root,store,repository,purpose:"recover",operationId:"timeout",workspaceId,providerId:"local",signal:new AbortController().signal,timeoutMs:80,valid:()=>true,stream,prompt:"Check interruption",input:{}}),/Recovery review timed out/);
    const task=cocoBackgroundTasks(repository,store,[workspaceId])[0]!;assert.equal(task.status,"error");assert.match(task.summary,/timed out/);assert.equal(store.isTurnActive(task.sessionId),false);
  }finally{store.memorySync.stop();store.database.close();rmSync(root,{recursive:true,force:true});}
});
