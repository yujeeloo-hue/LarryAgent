import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSessionStore } from "./sessionRuntime.js";
import { createCocoService } from "./cocoService.js";
import { configureCredentialsRoot, configureLegacyKeyBridgeForTests } from "../llm/credentials.js";
import { configureUserMemoryRoot } from "../memory/store.js";
import { configurePromptDefaults } from "../settings/promptDefaults.js";
import { registerBuiltins } from "../tools/index.js";
import { CocoRepository } from "../coco/repository.js";
import { SessionTurnLifecycles } from "../session/turnLifecycle.js";
import { openSessionDb, upsertSession } from "../session/db/index.js";
import type { Session } from "../session/types.js";
import type { CocoWork } from "../coco/types.js";

type WireMessage={role:string;content?:unknown;tool_calls?:{id:string;function:{name:string;arguments:string}}[]};
const isCommander=(messages:WireMessage[])=>messages.some(m=>m.role==="system"&&String(m.content).includes("You are CoCo, the user's commander"));
const currentTurn=(messages:WireMessage[])=>{let n=messages.length-1;while(n>=0&&messages[n]?.role!=="user")n--;return messages.slice(n);};
const calls=(messages:WireMessage[],name:string)=>messages.flatMap(m=>m.tool_calls?.filter(c=>c.function.name===name)??[]);
const until=async(predicate:()=>boolean,detail:()=>unknown=()=>null)=>{for(let i=0;i<600&&!predicate();i++)await new Promise(resolve=>setTimeout(resolve,15));assert.ok(predicate(),JSON.stringify(detail()));};
function configure(root:string){configureCredentialsRoot(root);configureLegacyKeyBridgeForTests(null);configureUserMemoryRoot(root);configurePromptDefaults(join(process.cwd(),"resources/prompts"));registerBuiltins();}
function delta(res:import("node:http").ServerResponse,value:unknown){res.write(`data: ${JSON.stringify({choices:[{index:0,delta:value,finish_reason:null}]})}\n\n`);}
function finish(res:import("node:http").ServerResponse,tool=false){res.write(`data: ${JSON.stringify({choices:[{index:0,delta:{},finish_reason:tool?"tool_calls":"stop"}],usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}})}\n\n`);res.end("data: [DONE]\n\n");}

for(const mode of ["network","user_stop"] as const)test(`CoCo separates live chat and ${mode==="network"?"automatically recovers an interrupted task":"respects a task session's manual stop"}`,{timeout:20000},async()=>{
  const root=mkdtempSync(join(tmpdir(),"coco-live-recovery-"));configure(root);
  let projectId="",sequence=0,held=false,recoveries=0,firstWrites=0,secondWrites=0,cut=false;
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  const firstFile=join(root,"first.txt"),secondFile=join(root,"second.txt");
  const server=createServer(async(req,res)=>{
    try{
      let body="";for await(const part of req)body+=String(part);const messages=JSON.parse(body).messages as WireMessage[];
      const first=messages.filter((m: {role:string})=>m.role==="system").map((m: {content?:unknown})=>String(m.content??"")).join("\n");let content:unknown;
      if(isCommander(messages)){
        const turn=currentTurn(messages),prompt=String(turn[0]?.content??"");
        if(prompt.includes("discuss"))content={content:"Yes, we can discuss the goal while the task continues."};
        else if(!calls(turn,"coco_work").length)content={tool_calls:[{index:0,id:`plan-${++sequence}`,type:"function",function:{name:"coco_work",arguments:JSON.stringify({action:"submit",plan:{reply:"Saved",planOnly:false,work:[{key:"task",title:"Produce two outputs",objective:"Create both files without repeating completed operations",workspaceId:projectId,steps:["Write first.txt","Write second.txt"],acceptance:[{id:"first",kind:"review",description:"first.txt contains first"},{id:"second",kind:"review",description:"second.txt contains second"}]}],ruleSuggestions:[]}})}}]};
        else content={content:"The task is saved and its execution can proceed separately."};
      }else if(first.includes("checking an interrupted project task")){recoveries++;content={content:JSON.stringify({action:"resume",summary:"The connection failed after a confirmed file write; continue the original session and keep the completed effect."})};}
      else if(first.includes("evaluating whether a project task is complete"))content={content:JSON.stringify({action:"complete",reason:"Both outputs exist"})};
      else{
        const writes=calls(messages,"write_file").map(c=>JSON.parse(c.function.arguments));
        if(!writes.some(c=>c.path===firstFile)){firstWrites++;content={tool_calls:[{index:0,id:`first-${++sequence}`,type:"function",function:{name:"write_file",arguments:JSON.stringify({path:firstFile,content:"first"})}}]};}
        else if(!cut){cut=true;held=true;res.writeHead(200,{"Content-Type":"text/event-stream"});delta(res,{content:"The first output is saved; I am checking the next step."});await Promise.race([gate,new Promise<void>(resolve=>res.on("close",()=>resolve()))]);if(!res.destroyed)res.destroy();return;}
        else if(!writes.some(c=>c.path===secondFile)){assert.equal(readFileSync(firstFile,"utf8"),"first");secondWrites++;content={tool_calls:[{index:0,id:`second-${++sequence}`,type:"function",function:{name:"write_file",arguments:JSON.stringify({path:secondFile,content:"second"})}}]};}
        else content={content:"Both outputs now exist. Check the saved acceptance evidence."};
      }
      res.writeHead(200,{"Content-Type":"text/event-stream"});delta(res,content);finish(res,Boolean((content as {tool_calls?:unknown}).tool_calls));
    }catch(error){if(!res.headersSent)res.writeHead(500);res.end(String(error));}
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const address=server.address();assert.ok(address&&typeof address!=="string");
  writeFileSync(join(root,"settings.json"),JSON.stringify({providers:[{id:"local",name:"Test",baseUrl:`http://127.0.0.1:${address.port}/v1`,modelId:"recovery"}],activeProviderId:"local",composerRunMode:"agent",maxModelIterations:8,userMemoryAutoExtract:false,projectMemoryAutoExtract:false}));
  const store=createSessionStore(root,{startBackgroundServices:false});projectId=(await store.createWorkspace({name:"Recovery project",path:root})).id;
  const coco=createCocoService(root,store,undefined,undefined,{projectAwareness:false});coco.start();coco.engine.command({type:"activation",action:"enable"});
  try{
    coco.engine.command({type:"chat",text:"Produce the two outputs.",workspaceId:projectId});
    await until(()=>held&&Boolean(coco.engine.snapshot().work[0]?.sessionId),()=>coco.engine.snapshot().messages);
    const sessionId=coco.engine.snapshot().work[0]!.sessionId!;
    coco.engine.command({type:"chat",text:"Can we discuss this while it is running?"});
    await until(()=>coco.engine.snapshot().messages.some(m=>m.text.includes("Yes, we can discuss"))&&!coco.engine.snapshot().chatJob);
    assert.equal(store.isTurnActive(sessionId),true);assert.equal(coco.engine.snapshot().work.length,1);assert.equal(firstWrites,1);
    if(mode==="network"){
      release();await until(()=>["completed","to_decide"].includes(coco.engine.snapshot().work[0]?.status??""),()=>coco.engine.snapshot().work);
      const snapshot=coco.engine.snapshot();assert.equal(snapshot.work[0]?.status,"completed",snapshot.work[0]?.summary??"No task");assert.equal(snapshot.work[0]?.sessionId,sessionId);assert.equal(firstWrites,1);assert.equal(secondWrites,1);
      assert.equal(readFileSync(secondFile,"utf8"),"second");assert.equal(snapshot.attempts.length,2);assert.equal(snapshot.attempts[0]?.status,"interrupted");assert.equal(snapshot.verifications[0]?.passed,true);
      assert.equal(recoveries, 0);
      const resumed = store.getSession(sessionId)?.messages ?? [];
      const lastUser = [...resumed].reverse().find(message => message.role === "user");
      assert.equal(lastUser?.parts.flatMap(part => part.type === "text" ? [part.text] : []).join("\n"), "Continue");
    }else{
      store.cancelTurn(sessionId);release();await until(()=>coco.engine.snapshot().work[0]?.status==="waiting");
      await coco.engine.tick();assert.equal(recoveries,0);assert.equal(secondWrites,0);assert.equal(store.getTurnLifecycle(sessionId)?.requestedStop,"user_stopped");assert.equal(coco.engine.snapshot().work[0]?.status,"waiting");
    }
  }finally{release();coco.stop();await coco.shutdown();store.memorySync.stop();store.database.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(root,{recursive:true,force:true});}
});

for(const uncertain of [false,true])test(`persisted interrupted session ${uncertain?"does not blindly replay an uncertain effect":"recovers after reopening the application database"}`,{timeout:15000},async()=>{
  const root=mkdtempSync(join(tmpdir(),"coco-crash-recovery-"));configure(root);let executorCalls=0,recoveryCalls=0;
  const server=createServer(async(req,res)=>{
    let body="";for await(const part of req)body+=String(part);const messages=JSON.parse(body).messages as WireMessage[],first=messages.filter((m: {role:string})=>m.role==="system").map((m: {content?:unknown})=>String(m.content??"")).join("\n");let content:unknown;
    if(isCommander(messages)){content={content:"Yes, we can discuss this while recovery checks continue."};}
    else if(first.includes("checking an interrupted project task")){recoveryCalls++;content={content:JSON.stringify({action:"resume",summary:"Unexpected recovery model"})};}
    else if(first.includes("evaluating whether a project task is complete"))content={content:JSON.stringify({action:"complete",reason:"The saved output exists"})};
    else{executorCalls++;if(!calls(messages,"write_file").length)content={tool_calls:[{index:0,id:"resumed-write",type:"function",function:{name:"write_file",arguments:JSON.stringify({path:join(root,"resumed.txt"),content:"resumed"})}}]};else content={content:"Recovered the original task."};}
    res.writeHead(200,{"Content-Type":"text/event-stream"});delta(res,content);finish(res,Boolean((content as {tool_calls?:unknown}).tool_calls));
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const address=server.address();assert.ok(address&&typeof address!=="string");
  writeFileSync(join(root,"settings.json"),JSON.stringify({providers:[{id:"local",name:"Local",baseUrl:`http://127.0.0.1:${address.port}/v1`,modelId:"recovery"}],activeProviderId:"local",userMemoryAutoExtract:false,projectMemoryAutoExtract:false,composerRunMode:"agent"}));
  const initial=createSessionStore(root,{startBackgroundServices:false}),workspace=await initial.createWorkspace({name:"Saved project",path:root});initial.memorySync.stop();initial.database.close();
  const db=openSessionDb(root),at=Date.now()-1000;
  const session:Session={id:"saved-session",type:"agent",source:"coco",title:"Saved task",workspaceId:workspace.id,workspacePath:root,providerId:"local",model:"recovery",createdAt:at,updatedAt:at,status:"running",progressText:"Working",pinned:false,archived:false,archivedAt:null,contextUsage:{usedTokens:0},plan:null,messages:[{id:"saved-user",role:"user",createdAt:at,parts:[{type:"text",text:"Create resumed.txt"}]},...(uncertain?[{id:"effect-owner",role:"assistant" as const,createdAt:at,parts:[{type:"tool_call" as const,id:"uncertain-effect",name:"run_shell",status:"running" as const,arguments:{command:"printf fixture"},argumentsRaw:'{"command":"printf fixture"}'}]}]:[])]};
  upsertSession(db,session);new SessionTurnLifecycles(db).put({sessionId:session.id,turnId:"interrupted-turn",owner:"coco",startedAt:at,state:"running",pendingEffects:[]});
  new CocoRepository(db).put<CocoWork>("work",{id:"saved-work",goalId:"saved-goal",title:"Create saved output",objective:"Create resumed.txt containing resumed",workspaceId:workspace.id,status:"executing",priority:50,dependsOn:[],steps:["Write resumed.txt"],acceptance:[{id:"file",kind:"file_exists",path:"resumed.txt",description:"resumed.txt contains resumed"}],deliverables:["resumed.txt"],ruleIds:[],revision:1,repairs:0,sessionId:session.id,fullPermissions:true,providerId:"local",createdAt:at,updatedAt:at,summary:"In progress",timeline:[]});db.close();
  const store=createSessionStore(root,{startBackgroundServices:false}),coco=createCocoService(root,store,undefined,undefined,{projectAwareness:false});coco.start();coco.engine.command({type:"activation",action:"enable"});
  try{
    coco.engine.command({type:"chat",text:"Can we chat during recovery?"});
    await until(()=>coco.engine.snapshot().messages.some(message=>message.text.includes("discuss this while recovery"))&&!coco.engine.snapshot().chatJob);
    await until(()=>["completed","to_decide"].includes(coco.engine.snapshot().work[0]?.status??""),()=>coco.engine.snapshot().work);
    const work=coco.engine.snapshot().work[0]!;assert.equal(recoveryCalls,0);assert.equal(work.sessionId,"saved-session");
    if(uncertain){assert.equal(work.status,"to_decide");assert.equal(executorCalls,0);assert.equal(existsSync(join(root,"resumed.txt")),false);assert.match(work.summary,/may already have taken effect/);}
    else{
      assert.equal(work.status,"completed",work.summary);assert.equal(readFileSync(join(root,"resumed.txt"),"utf8"),"resumed");assert.equal(store.listSessions().length,1);
      const lastUser=[...(store.getSession("saved-session")?.messages??[])].reverse().find(message=>message.role==="user");
      assert.equal(lastUser?.parts.flatMap(part=>part.type==="text"?[part.text]:[]).join("\n"),"Continue");
    }
  }finally{coco.stop();await coco.shutdown();store.memorySync.stop();store.database.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(root,{recursive:true,force:true});}
});
