import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSessionStore } from "./sessionRuntime.js";
import { createCocoService } from "./cocoService.js";
import { configureCredentialsRoot, configureLegacyKeyBridgeForTests } from "../llm/credentials.js";
import { configureUserMemoryRoot } from "../memory/store.js";
import { configurePromptDefaults } from "../settings/promptDefaults.js";
import { registerBuiltins } from "../tools/index.js";
import { setToolPermissionLevel, clearToolPermissionOverride } from "../tools/config.js";
import { getTool } from "../tools/registry.js";
import { configureHostAdapter, hostAdapter } from "../host/adapter.js";
import { createCocoExecution } from "./cocoExecution.js";
import type { CocoServiceDeps } from "./cocoServiceDeps.js";
import type { CocoWork } from "../coco/types.js";
import { CocoToolRuntime } from "../coco/toolRuntime.js";

type WireMessage = { role:string;content?:unknown;tool_calls?:{function:{name:string;arguments:string}}[] };
type Reply = string | { tool:string;args:unknown } | { partial:string; hold:Promise<void>; reasoning?:string };
async function fixture(reply:(messages:WireMessage[],root:string,projectId:string)=>Reply|Promise<Reply>) {
  const root=mkdtempSync(join(tmpdir(),"coco-native-chat-"));
  configureCredentialsRoot(root);configureLegacyKeyBridgeForTests(null);configureUserMemoryRoot(root);configurePromptDefaults(join(process.cwd(),"resources/prompts"));registerBuiltins();
  let projectId="",calls=0;
  const requests:WireMessage[][]=[],toolNames:string[][]=[];
  const server=createServer(async(req,res)=>{
    try {
      let body="";for await(const part of req)body+=String(part);
      const parsed=JSON.parse(body) as {messages:WireMessage[];tools?:{function?:{name?:string}}[]};
      const messages=parsed.messages;requests.push(messages);toolNames.push((parsed.tools??[]).flatMap(t=>t.function?.name?[t.function.name]:[]));calls++;
      const answer=await reply(messages,root,projectId);
      res.writeHead(200,{"Content-Type":"text/event-stream"});
      const send=(delta:unknown)=>res.write(`data: ${JSON.stringify({choices:[{index:0,delta,finish_reason:null}]})}\n\n`);
      const tools=typeof answer!=="string"&&"tool" in answer;
      if(typeof answer==="string")send({content:answer});
      else if(tools)send({tool_calls:[{index:0,id:`call-${calls}`,type:"function",function:{name:answer.tool,arguments:typeof answer.args==="string"?answer.args:JSON.stringify(answer.args)}}]});
      else {if(answer.reasoning)send({reasoning_content:answer.reasoning});send({content:answer.partial});await Promise.race([answer.hold,new Promise<void>(resolve=>res.on("close",()=>resolve()))]);}
      if(!res.destroyed){res.write(`data: ${JSON.stringify({choices:[{index:0,delta:{},finish_reason:tools?"tool_calls":"stop"}],usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}})}\n\n`);res.end("data: [DONE]\n\n");}
    } catch(error) {res.writeHead(500).end(String(error));}
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const address=server.address();assert.ok(address&&typeof address!=="string");
  writeFileSync(join(root,"settings.json"),JSON.stringify({providers:[{id:"local",name:"Local fixture",baseUrl:`http://127.0.0.1:${address.port}/v1`,modelId:"native-chat"}],activeProviderId:"local",composerRunMode:"agent",userMemoryAutoExtract:false,projectMemoryAutoExtract:false,maxModelIterations:8}));
  let store=createSessionStore(root,{startBackgroundServices:false});projectId=(await store.createWorkspace({name:"Chat fixture",path:root})).id;
  let coco=createCocoService(root,store,undefined,undefined,{projectAwareness:false});
  coco.start();coco.engine.command({type:"activation",action:"enable"});
  const wait=async(predicate:()=>boolean)=>{for(let i=0;i<400&&!predicate();i++)await new Promise(resolve=>setTimeout(resolve,15));assert.ok(predicate(),JSON.stringify(coco.engine.snapshot().messages.map(m=>({role:m.role,text:m.text,status:m.status}))));};
  return {root,get store(){return store;},requests,toolNames,get coco(){return coco;},wait,async send(text:string){coco.engine.command({type:"chat",text,workspaceId:projectId});await wait(()=>!coco.engine.snapshot().chatJob&&coco.engine.snapshot().messages.at(-1)?.role==="assistant");},async recreateService(){coco.stop();await coco.shutdown();store.memorySync.stop();store.database.close();store=createSessionStore(root,{startBackgroundServices:false});coco=createCocoService(root,store,undefined,undefined,{projectAwareness:false});coco.start();},async close(){coco.stop();await coco.shutdown();store.memorySync.stop();store.database.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(root,{recursive:true,force:true});}};
}
const currentTurn=(messages:WireMessage[])=>{let index=messages.length-1;while(index>=0&&messages[index]?.role!=="user")index--;return messages.slice(index);};
const submitted=(messages:WireMessage[],name:string)=>currentTurn(messages).some(m=>m.tool_calls?.some(c=>c.function.name===name));
function queueReference(f: Awaited<ReturnType<typeof fixture>>) {
  const workspaceId = f.store.listWorkspaces().find(w => w.path === f.root)!.id;
  f.coco.engine.repository.put("work", { id: "queue-reference", goalId: "reference-goal", title: "Referenced queue work", objective: "Review this selected work", workspaceId, status: "draft", priority: 0, dependsOn: [], steps: [], acceptance: [], deliverables: [], ruleIds: [], revision: 1, repairs: 0, fullPermissions: true, providerId: "local", createdAt: Date.now(), updatedAt: Date.now(), summary: "", timeline: [] });
  return "queue-reference";
}

test("queued Chat follow-ups drain through the commander with its tools and FIFO edits", { timeout: 20000 }, async () => {
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(messages => {
    const latest = String([...messages].reverse().find(m => m.role === "user")?.content);
    if (latest === "Hold the first reply.") return { partial: "Working on the first reply.", hold };
    if (latest === "Edited queued prompt") assert.match(JSON.stringify(messages.filter(m => m.role === "system")), /Referenced queue work/, "deferred follow-up preserves its selected reference");
    return submitted(messages, "coco_memory") ? `Commander answered: ${latest}` : { tool: "coco_memory", args: { action: "read" } };
  });
  try {
    f.coco.engine.command({ type: "chat", text: "Hold the first reply." });
    await f.wait(() => f.coco.engine.snapshot().messages.some(m => m.text === "Working on the first reply."));
    const id = f.coco.engine.snapshot().chat!.sessionId;
    const a = f.store.enqueuePrompt({ sessionId: id, userText: "First queued prompt", cocoWorkId: queueReference(f) }).queued;
    const b = f.store.enqueuePrompt({ sessionId: id, userText: "Second queued prompt" }).queued;
    const removed = f.store.enqueuePrompt({ sessionId: id, userText: "Discard me" }).queued;
    f.store.updateQueuedPromptText(id, a.id, "Edited queued prompt");
    f.store.moveQueuedPromptToFront(id, b.id); f.store.removeQueuedPrompt(id, removed.id);
    assert.equal(f.store.getSession(id)!.messages.filter(m => m.role === "user").length, 1, "queue stays outside transcript until sent");
    release();
    await f.wait(() => !f.coco.engine.snapshot().chatJob && f.store.getSession(id)!.messages.filter(m => m.role === "user").length === 3);
    const session = f.store.getSession(id)!;
    assert.equal(session.source, "coco_chat");
    assert.equal(session.status, "idle");
    assert.deepEqual(session.messages.filter(m => m.role === "user").map(m => m.parts.filter(p => p.type === "text").map(p => p.text).join("")), ["Hold the first reply.", "Second queued prompt", "Edited queued prompt"]);
    assert.equal(session.messages.flatMap(m => m.parts).filter(p => p.type === "tool_call" && p.name === "coco_memory").length, 2, "every drained turn retains commander tools");
    assert.equal(f.store.listPromptQueue(id).length, 0);
    assert.equal(f.coco.engine.snapshot().messages.filter(m => m.role === "user").length, 3);
  } finally { release(); await f.close(); }
});

test("Chat insertion waits for the current step, can be cancelled, and remains in the same job", { timeout: 15000 }, async () => {
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(messages => {
    if (String([...messages].reverse().find(m => m.role === "user")?.content).includes("Inserted correction")) {
      assert.match(JSON.stringify(messages.filter(m => m.role === "system")), /Referenced queue work/, "inserted prompt carries its selected reference on the wire");
      return "I incorporated the correction.";
    }
    return { partial: "Finishing the current step.", hold };
  });
  try {
    f.coco.engine.command({ type: "chat", text: "Think through the original goal." });
    await f.wait(() => f.coco.engine.snapshot().messages.some(m => m.text === "Finishing the current step."));
    const id = f.coco.engine.snapshot().chat!.sessionId, job = f.coco.engine.snapshot().chatJob!.id;
    const q = f.store.enqueuePrompt({ sessionId: id, userText: "Inserted correction", cocoWorkId: queueReference(f) }).queued;
    assert.equal(f.store.promoteQueuedPrompt(id, q.id).ok, true);
    assert.equal(f.store.deferQueuedPrompt(id, q.id).ok, true);
    assert.equal(f.store.listPromptQueue(id)[0]!.mode, "deferred");
    f.store.promoteQueuedPrompt(id, q.id);
    assert.equal(f.requests.length, 1, "arming does not abort the active request");
    assert.equal(f.coco.engine.snapshot().chatJob!.id, job);
    assert.equal(f.store.getSession(id)!.messages.filter(m => m.role === "user").length, 1);
    release(); await f.wait(() => !f.coco.engine.snapshot().chatJob);
    assert.equal(f.store.listPromptQueue(id).length, 0);
    assert.equal(f.store.getSession(id)!.messages.filter(m => m.role === "user").length, 2);
    assert.ok(!JSON.stringify(f.store.getSession(id)!.messages).includes("CoCo work references selected"), "reference context stays out of the visible transcript");
    assert.ok(f.store.getSession(id)!.messages.some(m => m.parts.some(p => p.type === "text" && p.text.includes("I incorporated"))));
    assert.equal(f.coco.engine.snapshot().messages.filter(m => m.role === "user").length, 1, "insertion does not schedule a second commander job");
  } finally { release(); await f.close(); }
});

test("stopping keeps Chat prompts, disarms insertion, and Send now re-enters CoCo", { timeout: 15000 }, async () => {
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(messages => String([...messages].reverse().find(m => m.role === "user")?.content) === "Hold this reply."
    ? { partial: "A partial answer.", hold } : "The queued follow-up is answered.");
  try {
    f.coco.engine.command({ type: "chat", text: "Hold this reply." });
    await f.wait(() => f.coco.engine.snapshot().messages.some(m => m.text === "A partial answer."));
    const id = f.coco.engine.snapshot().chat!.sessionId;
    const q = f.store.enqueuePrompt({ sessionId: id, userText: "Continue the conversation." }).queued;
    f.store.promoteQueuedPrompt(id, q.id);
    f.coco.engine.command({ type: "chatControl", action: "stop" });
    await f.wait(() => !f.coco.engine.snapshot().chatJob);
    assert.equal(f.store.listPromptQueue(id)[0]?.mode, "deferred");
    assert.equal(f.requests.length, 1);
    assert.equal(f.store.promoteQueuedPrompt(id, q.id).started, true);
    await f.wait(() => !f.coco.engine.snapshot().chatJob && f.store.getSession(id)!.messages.filter(m => m.role === "user").length === 2);
    assert.equal(f.store.getSession(id)!.source, "coco_chat");
    assert.equal(f.store.listPromptQueue(id).length, 0);
    const kept = f.store.enqueuePrompt({ sessionId: id, userText: "Keep this if the service is stopped." }).queued;
    f.coco.stop();
    assert.equal(f.store.promoteQueuedPrompt(id, kept.id).ok, false);
    assert.equal(f.store.listPromptQueue(id)[0]?.id, kept.id, "an unavailable commander never falls back to an app turn or loses a prompt");
  } finally { release(); await f.close(); }
});

test("promoting a queued prompt during a greeting starts interactive Chat with fresh tools", { timeout: 15000 }, async () => {
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(messages => JSON.stringify(messages).includes("You are CoCo greeting the user")
    ? { partial: "Welcome back.", hold }
    : submitted(messages, "coco_memory") ? "Your real request is answered." : { tool: "coco_memory", args: { action: "read" } });
  try {
    f.coco.engine.command({ type: "wake" });
    await f.wait(() => f.coco.engine.snapshot().messages.some(m => m.text === "Welcome back."));
    const id = f.coco.engine.snapshot().chat!.sessionId;
    const q = f.store.enqueuePrompt({ sessionId: id, userText: "A real user request." }).queued;
    assert.equal(f.store.promoteQueuedPrompt(id, q.id).started, true);
    await f.wait(() => !f.coco.engine.snapshot().chatJob && f.store.getSession(id)!.messages.filter(m => m.role === "user").length === 1);
    assert.match(JSON.stringify(f.store.getSession(id)!.messages), /Your real request is answered/);
    assert.ok(f.store.getSession(id)!.messages.some(m => m.parts.some(p => p.type === "tool_call" && p.name === "coco_memory")));
    assert.equal(f.store.listPromptQueue(id).length, 0);
  } finally { release(); await f.close(); }
});

test("Markdown conversation uses one persistent Larry session across follow-ups and service restart",{timeout:15000},async()=>{
  const f=await fixture(messages=>{
    const latest=String([...messages].reverse().find(m=>m.role==="user")?.content);
    if(latest.includes("remember"))return "- I will remember **Cedar**.\n- We can discuss the goal before creating work.";
    assert.ok(messages.some(m=>m.role==="user"&&String(m.content).includes("remember Cedar")),"prior user turns remain actual user messages");
    assert.ok(messages.some(m=>m.role==="assistant"&&String(m.content).startsWith("- I will remember")),"prior assistant Markdown remains in the transcript");
    return "Your project name is **Cedar**.";
  });
  try{
    await f.send("Please remember Cedar while we discuss this.");const id=f.coco.engine.snapshot().chat!.sessionId;
    assert.match(f.coco.engine.snapshot().messages.at(-1)!.text,/^- I will remember/);assert.equal(f.coco.engine.snapshot().work.length,0);
    assert.equal(f.store.getSession(id)?.source,"coco_chat");assert.equal(f.store.listSessions().length,0,"internal CoCo chat is not duplicated in project task lists");
    await f.send("What is the project name?");assert.equal(f.coco.engine.snapshot().chat?.sessionId,id);
    await f.recreateService();await f.send("What was the project name again?");assert.equal(f.coco.engine.snapshot().chat?.sessionId,id);
    assert.equal(f.store.getSession(id)?.messages.filter(m=>m.role==="user").length,3);
    assert.equal(getTool("coco_work"),undefined,"commander tools are not registered globally");
  }finally{await f.close();}
});

test("task arguments are validated as native tool calls and corrected through tool feedback",{timeout:15000},async()=>{
  let submittedCount=0;
  const f=await fixture((messages,_root,workspaceId)=>{
    if(!submitted(messages,"coco_work")){submittedCount++;return {tool:"coco_work",args:{action:"submit",plan:{reply:"Proposed work",planOnly:true,work:[{key:"review",title:"Review the project",objective:"Review the project before making changes",workspaceId,steps:["Inspect existing code"],acceptance:[]}],ruleSuggestions:[]}}};}
    const toolResults=currentTurn(messages).filter(m=>m.role==="tool");
    if(toolResults.length===1){assert.match(JSON.stringify(toolResults),/acceptance/);submittedCount++;return {tool:"coco_work",args:{action:"submit",plan:{reply:"Saved a review plan",planOnly:true,work:[{key:"review",title:"Review the project",objective:"Review the project before making changes",workspaceId,steps:["Inspect existing code"],acceptance:[{id:"review",kind:"review",description:"Findings cite concrete code locations"}]}],ruleSuggestions:[]}}};}
    return "- The review plan is saved as a draft.\n- I have not executed it.";
  });
  try{await f.send("Plan a review; do not execute yet.");const snapshot=f.coco.engine.snapshot();assert.equal(snapshot.work.length,1);assert.equal(snapshot.work[0]?.status,"draft");assert.equal(submittedCount,2);assert.match(snapshot.messages.at(-1)?.text??"",/^- The review plan/);const chat=f.store.getSession(snapshot.chat!.sessionId)!;assert.equal(chat.messages.flatMap(m=>m.parts.filter(p=>p.type==="tool_call")).length,2);}finally{await f.close();}
});

test("a native ask_user question can be answered in CoCo's ordinary message box",{timeout:15000},async()=>{
  const f=await fixture(messages=>!submitted(messages,"ask_user")?{tool:"ask_user",args:{question:"Which scope should we review?",options:[{label:"Only the parser"},{label:"The entire project"}]}}:"I will review only the parser based on your answer.");
  try{
    f.coco.engine.command({type:"chat",text:"Help me choose a scope."});await f.wait(()=>Boolean(f.coco.engine.snapshot().chat?.question));
    const id=f.coco.engine.snapshot().chat!.sessionId;
    f.coco.engine.command({type:"chat",text:"Only the parser"});await f.wait(()=>!f.coco.engine.snapshot().chatJob);
    assert.equal(f.coco.engine.snapshot().chat?.sessionId,id);assert.match(f.coco.engine.snapshot().messages.at(-1)?.text??"",/only the parser/);
    const transcript=JSON.stringify(f.store.getSession(id)?.messages);assert.match(transcript,/selected_options/);assert.match(transcript,/Only the parser/);assert.equal(f.store.getSession(id)?.messages.filter(m=>m.role==="user").length,1,"answer resumes the existing turn instead of starting a second one");
  }finally{await f.close();}
});

test("CoCo Chat uses the ordinary tool confirmation and continues in the same session",{timeout:15000},async()=>{
  const f=await fixture((messages,root)=>!submitted(messages,"write_file")?{tool:"write_file",args:{path:join(root,"confirmed.txt"),content:"confirmed"}}:"The confirmed file was written.");setToolPermissionLevel("write_file",2);
  try{
    f.coco.engine.command({type:"chat",text:"Write the fixture file after confirmation."});await f.wait(()=>Boolean(f.coco.engine.snapshot().chat?.approval));
    const approval=f.coco.engine.snapshot().chat!.approval!;
    assert.equal(approval.toolName,"write_file");
    assert.throws(()=>f.coco.engine.command({type:"chatControl",action:"approval",requestId:"stale",approved:true}),/no longer current/);
    f.coco.engine.command({type:"chatControl",action:"approval",requestId:approval.requestId,approved:true});await f.wait(()=>!f.coco.engine.snapshot().chatJob);
    assert.equal(readFileSync(join(f.root,"confirmed.txt"),"utf8"),"confirmed");assert.equal(f.coco.engine.snapshot().chat?.approval,undefined);
  }finally{clearToolPermissionOverride("write_file");await f.close();}
});

test("partial Markdown is visible before completion; stopping and continuing preserve the native session",{timeout:15000},async()=>{
  let release!:()=>void;const hold=new Promise<void>(resolve=>{release=resolve;});let calls=0;
  const f=await fixture(messages=>++calls===1?{partial:"- I am working through the existing context.",hold}:"Continued from the saved partial response.");
  try{
    f.coco.engine.command({type:"chat",text:"Think through this goal."});await f.wait(()=>f.coco.engine.snapshot().messages.some(m=>m.role==="assistant"&&m.status==="streaming"&&m.text.startsWith("- I am")));
    const id=f.coco.engine.snapshot().chat!.sessionId;f.coco.engine.command({type:"chatControl",action:"stop"});await f.wait(()=>!f.coco.engine.snapshot().chatJob);
    assert.equal(f.coco.engine.snapshot().messages.at(-1)?.status,"stopped");release();await f.send("Continue from where you stopped.");
    assert.equal(f.coco.engine.snapshot().chat?.sessionId,id);assert.match(JSON.stringify(f.requests.at(-1)),/I am working through/);
  }finally{release();await f.close();}
});

test("a failed provider reply retries as a hidden native continuation in the same session",{timeout:15000},async()=>{
  let requests=0;
  const f=await fixture(messages=>{
    if(++requests===1)throw new Error("Temporary fixture provider failure");
    assert.ok(messages.some(m=>m.role==="user"&&String(m.content).includes("Keep the original goal")));
    return "- Continued the original conversation after the temporary failure.";
  });
  try{
    await f.send("Keep the original goal and explain your approach.");const id=f.coco.engine.snapshot().chat!.sessionId;
    const session=f.store.getSession(id)!;assert.equal(session.status,"error");
    const error=[...session.messages].reverse().find(m=>m.parts.some(p=>p.type==="text"&&p.error));assert.ok(error);
    assert.equal(f.store.removeTurnError(id,error.id).ok,true);
    f.coco.engine.command({type:"chat",text:"Continue the interrupted response using the original goal and saved tool results.",continuation:"retry"});
    await f.wait(()=>!f.coco.engine.snapshot().chatJob&&f.coco.engine.snapshot().messages.at(-1)?.status==="completed");
    assert.equal(f.coco.engine.snapshot().chat?.sessionId,id);assert.equal(f.store.getSession(id)?.status,"idle");assert.equal(f.coco.engine.snapshot().work.length,0);
    assert.match(f.coco.engine.snapshot().messages.at(-1)?.text??"",/Continued the original/);
  }finally{await f.close();}
});

test("turning CoCo off stops manual chat; re-enabling preserves the session across cooldown",{timeout:15000},async()=>{
  let release!:()=>void,calls=0;const hold=new Promise<void>(resolve=>{release=resolve;});
  const f=await fixture(()=>++calls===1?{partial:"We can continue discussing the goal.",hold}:"The conversation is still available.");
  try{
    f.coco.engine.command({type:"chat",text:"Discuss the goal while automation runs."});
    await f.wait(()=>Boolean(f.coco.engine.snapshot().chatJob)&&f.coco.engine.snapshot().messages.some(m=>m.text.includes("We can continue")));
    const id=f.coco.engine.snapshot().chat!.sessionId;
    f.coco.engine.command({type:"settings",settings:{...f.coco.engine.snapshot().settings,enabled:false}});
    release();
    await f.wait(()=>!f.coco.engine.snapshot().chatJob&&!f.store.isTurnActive(id));
    assert.throws(()=>f.coco.engine.command({type:"chat",text:"Discuss while disabled."}),/Enable CoCo/);
    assert.equal(f.coco.engine.snapshot().state,"paused");assert.equal(f.coco.engine.snapshot().chat?.sessionId,id);
    f.coco.engine.command({type:"settings",settings:{...f.coco.engine.snapshot().settings,enabled:true}});
    f.coco.engine.budget.record({id:"exhausted-automation",tokens:200000,estimated:false,purpose:"execute"});
    await f.send("Answer while automatic work is cooling down.");
    assert.equal(f.coco.engine.snapshot().state,"cooldown");assert.ok(f.coco.engine.snapshot().budget.hourly>200000,"chat usage during cooldown is counted toward the shared budget");assert.equal(f.coco.engine.snapshot().chat?.sessionId,id);
  }finally{release();await f.close();}
});

test("goal planning runs independently and delivers its result after the current native reply",{timeout:15000},async()=>{
  let startPlanning=false,releasePlan!:()=>void,releaseChat!:()=>void;
  const planning=new Promise<void>(resolve=>{releasePlan=resolve;}),chatting=new Promise<void>(resolve=>{releaseChat=resolve;});
  const f=await fixture(async(messages,_root,workspaceId)=>{
    const first=messages.filter((m: {role:string})=>m.role==="system").map((m: {content?:unknown})=>String(m.content??"")).join("\n");
    if(first.includes("You are CoCo, the user's collaborator")){
      startPlanning=true;await planning;
      return JSON.stringify({reply:"The review plan is ready as a draft.",planOnly:true,work:[{key:"review",title:"Review the module",objective:"Inspect the module before changing it",workspaceId,steps:["Inspect the implementation"],acceptance:[{id:"findings",kind:"review",description:"Findings identify concrete code locations"}]}],ruleSuggestions:[]});
    }
    const prompt=String([...messages].reverse().find(m=>m.role==="user")?.content??"");
    if(prompt.includes("Hold this discussion"))return {partial:"We can keep discussing while planning finishes.",hold:chatting};
    if(prompt.includes("Can we discuss"))return "Yes, we can discuss the goal without waiting for the planner.";
    return submitted(messages,"coco_work")?"I handed the goal to background planning. We can keep talking.":{tool:"coco_work",args:{action:"plan",objective:"Review the module before making changes",workspaceId,planOnly:true}};
  });
  try{
    await f.send("Plan a module review; do not execute yet.");await f.wait(()=>startPlanning);
    assert.equal(f.coco.engine.snapshot().planningJob?.kind,"plan");assert.equal(f.coco.engine.snapshot().work.length,0);
    await f.send("Can we discuss the goal while you plan it?");assert.ok(f.coco.engine.snapshot().pendingPlans?.length);
    assert.match(f.coco.engine.snapshot().messages.at(-1)?.text??"",/without waiting for the planner/);
    f.coco.engine.command({type:"chat",text:"Hold this discussion while the background plan finishes."});
    await f.wait(()=>f.coco.engine.snapshot().messages.some(m=>m.status==="streaming"&&m.text.includes("We can keep discussing")));
    const id=f.coco.engine.snapshot().chat!.sessionId;releasePlan();
    await f.wait(()=>f.coco.engine.snapshot().work[0]?.status==="draft"&&!f.coco.engine.snapshot().pendingPlans?.length);
    assert.equal(f.store.isTurnActive(id),true);assert.ok(!JSON.stringify(f.store.getSession(id)?.messages).includes("**Plan ready**"),"background output does not mutate an active native reply");
    releaseChat();await f.wait(()=>!f.coco.engine.snapshot().chatJob);
    assert.match(JSON.stringify(f.store.getSession(id)?.messages),/\*\*Plan ready\*\*/);assert.equal(f.coco.engine.snapshot().work.length,1);
    assert.equal(f.coco.engine.repository.list<{status:string}>("chatNotice")[0]?.status,"delivered");
  }finally{releasePlan();releaseChat();await f.close();}
});

test("page wake uses natural small talk, persists as assistant speech, and never fabricates a user request", { timeout: 15000 }, async () => {
  const f = await fixture(messages => JSON.stringify(messages).includes("You are CoCo greeting the user")
    ? (() => {
      assert.ok(messages.some(m => m.role === "user"), "wire keeps a user-role message (GLM rejects user-less windows)");
      const last = messages.at(-1);
      assert.equal(last?.role, "user");
      assert.match(String(last?.content), /Automatic CoCo visit, not a user message/, "the last answered exchange is never the newest user turn on the wire");
      return "Welcome back. How has your morning been?";
    })()
    : "We can keep talking.");
  try {
    f.coco.engine.command({ type: "wake" });
    await f.wait(() => !f.coco.engine.snapshot().chatJob && f.coco.engine.snapshot().messages.some(m => m.text.includes("How has your morning")));
    assert.equal(f.coco.engine.snapshot().messages.filter(m => m.role === "user").length, 0);
    await f.send("Hello, let's talk.");
    const sessionId = f.coco.engine.snapshot().chat!.sessionId;
    const transcript = f.store.getSession(sessionId)!;
    assert.equal(transcript.messages.filter(m => m.role === "user").length, 1);
    assert.equal(transcript.messages.filter(m => m.role === "assistant" && JSON.stringify(m.parts).includes("How has your morning")).length, 1);
    const before = f.requests.length;
    f.coco.engine.command({ type: "wake" }); await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(f.requests.length, before, "a rapid remount does not greet again");
    f.coco.engine.repository.setMeta("lastVisitWake", 0);
    f.coco.engine.command({ type: "wake" }); await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(f.requests.length, before, "unchanged content stays quiet beyond the old remount throttle");
    f.coco.engine.repository.setMeta("visitState", { fingerprint: "new-task-progress", spokenAt: 0 });
    f.coco.engine.command({ type: "wake" });
    await f.wait(() => !f.coco.engine.snapshot().chatJob && f.store.getSession(sessionId)!.messages.filter(m => m.role === "assistant" && JSON.stringify(m.parts).includes("How has your morning")).length === 2);
    assert.equal(f.store.getSession(sessionId)!.messages.filter(m => m.role === "user").length, 1, "native notices do not create a synthetic user turn");
    await f.recreateService();
    assert.ok(f.store.getSession(sessionId)?.messages.some(m => m.role === "assistant" && JSON.stringify(m.parts).includes("How has your morning")));
  } finally { await f.close(); }
});

test("native Chat creates a delegated rule already enabled without a Confirm step", { timeout: 15000 }, async () => {
  const f = await fixture((messages, _root, workspaceId) => submitted(messages, "coco_work") ? "I'll follow up on the report." : {
    tool:"coco_work",args:{action:"submit",plan:{ reply: "Following up on the report", work: [], ruleSuggestions: [{ name: "Report follow-up", objective: "Follow the report already requested by the user", mode: "inspection", scope: { all: false, workspaceIds: [workspaceId], excludedWorkspaceIds: [] }, enabled: true, cadence: { kind: "minute", n: 15 }, acceptance: [] }] }},
  });
  try {
    await f.send("Keep following up on the report for me.");
    const rule = f.coco.engine.snapshot().rules[0]!;
    assert.equal(rule.confirmed, true); assert.equal(rule.enabled, true); assert.equal(rule.origin, "coco");
    assert.ok(rule.nextRunAt > Date.now()); assert.equal(f.coco.engine.snapshot().toolApprovals?.length, 0);
  } finally { await f.close(); }
});

test("reopening with nothing running and nothing recorded sends no model request and leaves no background check", { timeout: 20000 }, async () => {
  const f = await fixture(() => "I will keep our discussion in context.");
  try {
    await f.send("Let's discuss the report before taking any action.");
    const requests = f.requests.length;
    await f.recreateService();
    await new Promise(resolve => setTimeout(resolve, 1500));
    await f.wait(() => !f.coco.engine.snapshot().planningJob && !f.coco.engine.snapshot().chatJob);
    assert.equal(f.requests.length, requests, "no ledger entries and no restart interruption: CoCo stays asleep");
    assert.equal(f.coco.engine.repository.list("backgroundSession").length, 0);
    assert.equal(f.coco.engine.snapshot().work.length, 0); assert.equal(f.coco.engine.snapshot().rules.length, 0);
  } finally { await f.close(); }
});


test("an autonomous wake sends [AUTONOMOUS] in a lean prefix, the briefing as the trailing note, and no plan tools", { timeout: 20000 }, async () => {
  const f = await fixture(() => "Noted the new project.");
  try {
    f.coco.engine.recordWake({ kind: "workspace_added", workspaceId: "octo", workspaceName: "Octo Notes", workspacePath: "/tmp/octo" }, true);
    await f.wait(() => f.requests.length === 1 && !f.coco.engine.snapshot().chatJob);
    const messages = f.requests[0]!, systems = messages.filter(m => m.role === "system").map(m => String(m.content));
    assert.ok(systems.some(s => s.startsWith("[AUTONOMOUS]\n# Autonomous execution")), "home exec prompt follows AGENT");
    assert.ok(systems.findIndex(s => s.startsWith("[AUTONOMOUS]")) > systems.findIndex(s => s.startsWith("[COCO_MEMORY]")));
    assert.ok(!systems.some(s => s.includes("Current coordination context")), "no coordination JSON");
    assert.ok(!systems.some(s => s.startsWith("[Turn handoff]")));
    assert.ok(!systems.some(s => s.includes("Wake:")), "the briefing is not in the system prefix");
    const last = messages.at(-1)!;
    assert.equal(last.role, "user");
    assert.match(String(last.content), /\[Automatic CoCo wake, not a user message\] The user has sent nothing new\. Follow \[AUTONOMOUS\]\./);
    assert.match(String(last.content), /Wake: workspace added[\s\S]*Workspaces\n- Added: Octo Notes — \/tmp\/octo/);
    const tools = f.toolNames[0]!;
    assert.ok(tools.includes("coco_work") && tools.includes("coco_memory"));
    for (const denied of ["fsm_route", "write_plan_doc", "adopt_plan_doc", "create_plan", "update_plan", "complete_plan", "ask_user", "request_full_permissions", "turn_handoff"]) assert.ok(!tools.includes(denied), denied);
    await f.wait(() => f.coco.engine.repository.list<{ deliveredAt?: number }>("wakeEntry").every(e => e.deliveredAt));
  } finally { await f.close(); }
});

test("an autonomous wake sends only the newest three Chat turns; the next user turn sees the full history", { timeout: 30000 }, async () => {
  const f = await fixture(() => "Noted.");
  try {
    for (const text of ["Turn one", "Turn two", "Turn three", "Turn four"]) await f.send(text);
    const before = f.requests.length;
    f.coco.engine.recordWake({ kind: "workspace_added", workspaceId: "octo", workspaceName: "Octo Notes", workspacePath: "/tmp/octo" }, true);
    await f.wait(() => f.requests.length === before + 1 && !f.coco.engine.snapshot().chatJob);
    const userTexts = (messages: WireMessage[]) => messages.filter(m => m.role === "user").map(m => String(m.content)).filter(t => t.startsWith("Turn "));
    assert.deepEqual(userTexts(f.requests[before]!), ["Turn two", "Turn three", "Turn four"]);
    await f.send("Turn five");
    assert.deepEqual(userTexts(f.requests.at(-1)!), ["Turn one", "Turn two", "Turn three", "Turn four", "Turn five"]);
  } finally { await f.close(); }
});

test("visit greetings stream into native Chat before completion without a background card", { timeout: 15000 }, async () => {
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(() => ({ partial: "Welcome back. The report is being verified.", hold }));
  try {
    f.coco.engine.command({ type: "wake" });
    await f.wait(() => Boolean(f.coco.engine.snapshot().chat?.sessionId) && f.coco.engine.snapshot().messages.some(m => m.status === "streaming" && m.text.includes("report is being verified")));
    const snapshot = f.coco.engine.snapshot();
    assert.equal(snapshot.chatJob?.kind, "greet", "generation is still running when text becomes visible");
    assert.equal(snapshot.backgroundTasks?.some(t => t.purpose === "greet"), false);
    const transcript = f.store.getSession(snapshot.chat!.sessionId)!;
    assert.equal(transcript.source, "coco_chat");
    assert.equal(transcript.messages.filter(m => m.role === "user").length, 0);
    assert.ok(transcript.messages.some(m => m.role === "assistant" && JSON.stringify(m.parts).includes("report is being verified")));
    release(); await f.wait(() => !f.coco.engine.snapshot().chatJob);
    assert.ok(f.coco.engine.snapshot().messages.some(m => m.status === "completed" && m.text.includes("Welcome back")));
  } finally { release(); await f.close(); }
});

test("a visit advertises only read-only context and refuses a fabricated mutating tool call", { timeout: 15000 }, async () => {
  let rejected = false;
  const f = await fixture(messages => {
    const result = messages.find(m => m.role === "tool");
    if (!result) return { tool: "write_file", args: { path: "must-not-exist.txt", content: "unrequested side effect" } };
    assert.match(JSON.stringify(result), /Visit greetings only read context|not available|Unknown tool/i); rejected = true;
    return "Welcome back. What has been on your mind?";
  });
  try {
    f.coco.engine.command({ type: "wake" });
    await f.wait(() => !f.coco.engine.snapshot().chatJob && f.coco.engine.snapshot().messages.some(m => m.text.includes("Welcome back")));
    assert.equal(rejected, true);
    assert.equal(f.coco.engine.snapshot().work.length, 0);
    assert.throws(() => readFileSync(join(f.root, "must-not-exist.txt")), /ENOENT/);
  } finally { await f.close(); }
});

test("a real user message preempts a streaming visit without adding a fake prompt or a stop notice", { timeout: 15000 }, async () => {
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(messages => JSON.stringify(messages).includes("You are CoCo greeting the user") ? { partial: "Welcome back.", hold } : "Let's discuss your idea.");
  try {
    f.coco.engine.command({ type: "wake" });
    await f.wait(() => f.coco.engine.snapshot().messages.some(m => m.status === "streaming" && m.text === "Welcome back."));
    await f.send("I have an idea.");
    const session = f.store.getSession(f.coco.engine.snapshot().chat!.sessionId)!;
    assert.equal(session.messages.filter(m => m.role === "user").length, 1);
    assert.ok(session.messages.some(m => m.role === "assistant" && JSON.stringify(m.parts).includes("Let's discuss your idea.")));
    assert.ok(!f.coco.engine.snapshot().messages.some(m => m.text.includes("Stopped. You can continue here.")));
  } finally { release(); await f.close(); }
});


test("automatic remarks omit provider reasoning while ordinary Chat retains it", { timeout: 15000 }, async () => {
  const hold = Promise.resolve();
  const f = await fixture(messages => JSON.stringify(messages).includes("You are CoCo greeting the user")
    ? { partial: "The report has passed verification.", reasoning: "Internal automatic reasoning that should not appear in Chat.", hold }
    : { partial: "Here is my answer to your question.", reasoning: "Normal interactive reasoning stays available.", hold });
  try {
    f.coco.engine.command({ type: "wake" });
    await f.wait(() => !f.coco.engine.snapshot().chatJob && f.coco.engine.snapshot().messages.some(m => m.text.includes("passed verification")));
    const snapshot = f.coco.engine.snapshot(), sessionId = snapshot.chat!.sessionId;
    const wakeMessages = f.store.getSession(sessionId)!.messages;
    assert.equal(wakeMessages.flatMap(m => m.parts).filter(p => p.type === "reasoning").length, 0);
    const wake = wakeMessages.find(m => m.role === "assistant" && m.parts.some(p => p.type === "text" && p.text.includes("passed verification")))!;
    assert.ok(snapshot.chat?.textOnlyMessageIds?.includes(wake.id));
    const firstWake = wakeMessages.find(m => m.role !== "user")!;
    assert.deepEqual(snapshot.chat?.turnStartMessageIds, [firstWake.id], "the prompt-less greeting starts its own turn");
    assert.equal(f.coco.engine.repository.list<{ purpose: string }>("backgroundSession").some(s => s.purpose === "greet"), false);
    await f.send("Please explain the result.");
    const normal = f.store.getSession(sessionId)!.messages.filter(m => m.role === "assistant" && m.id !== wake.id);
    assert.ok(normal.some(m => m.parts.some(p => p.type === "reasoning")));
    assert.ok(normal.every(m => !f.coco.engine.snapshot().chat?.textOnlyMessageIds?.includes(m.id)));
    assert.deepEqual(f.coco.engine.snapshot().chat?.turnStartMessageIds, [firstWake.id], "a prompted reply is not a turn start");
    const projection = f.coco.engine.repository.get<any>("message", `chat-${wake.id}`);
    const { origin, ...legacy } = projection; f.coco.engine.repository.put("message", legacy);
    assert.ok(f.coco.engine.snapshot().chat?.textOnlyMessageIds?.includes(wake.id), "older automatic replies are recognized without rewriting history");
  } finally { await f.close(); }
});

test("a stopped automatic turn without a reply leaves nothing in the Chat display", { timeout: 15000 }, async () => {
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(messages => JSON.stringify(messages).includes("You are CoCo greeting the user") ? { partial: "", hold } : "Noted.");
  try {
    f.coco.engine.command({ type: "wake" });
    await f.wait(() => f.coco.engine.snapshot().chatJob?.kind === "greet" && f.requests.length > 0);
    const sessionId = f.coco.engine.snapshot().chat!.sessionId;
    await f.wait(() => f.store.getSession(sessionId)!.messages.some(m => m.role === "assistant"));
    f.coco.engine.command({ type: "chatControl", action: "stop" });
    await f.wait(() => !f.coco.engine.snapshot().chatJob);
    const silent = f.store.getSession(sessionId)!.messages.filter(m => m.role === "assistant");
    assert.ok(silent.length > 0);
    assert.ok(silent.every(m => f.coco.engine.snapshot().chat?.textOnlyMessageIds?.includes(m.id)));
    await f.send("Hello again.");
    const answered = f.store.getSession(sessionId)!.messages.filter(m => m.role === "assistant" && !silent.some(s => s.id === m.id));
    assert.ok(answered.every(m => !f.coco.engine.snapshot().chat?.textOnlyMessageIds?.includes(m.id)), "interactive replies keep their full display");
  } finally { release(); await f.close(); }
});

test("a replacement Chat session seeded from the same history does not reuse message ids", { timeout: 15000 }, async () => {
  const f = await fixture(() => "Noted.");
  const persistErrors: string[] = [], original = console.error;
  console.error = (...args: unknown[]) => { if (String(args[0]).includes("failed to persist")) persistErrors.push(String(args[2])); original(...args); };
  try {
    await f.send("First message.");
    // Force a fresh Chat session; it is seeded again from the same CoCo history.
    f.coco.engine.repository.setMeta("chatContextSince", -1);
    await f.send("Second message.");
    const first = f.coco.engine.snapshot().chat!.sessionId;
    f.coco.engine.repository.setMeta("chatContextSince", -1);
    await f.send("Third message.");
    const messages = f.coco.engine.snapshot().messages;
    assert.ok(!messages.some(m => m.status === "error"), JSON.stringify(messages.map(m => m.text)));
    assert.notEqual(f.coco.engine.snapshot().chat!.sessionId, first);
    assert.equal(messages.at(-1)?.text, "Noted.");
    assert.deepEqual(persistErrors, []);
  } finally { console.error = original; await f.close(); }
});

const guardRecorder = () => {
  const base = hostAdapter();
  const events: { op: "acquire" | "release"; owner: string }[] = [];
  configureHostAdapter({ ...base, powerGuard: { acquire: owner => { events.push({ op: "acquire", owner }); }, release: owner => { events.push({ op: "release", owner }); } } });
  return {
    events,
    depth: () => events.reduce((count, event) => count + (event.op === "acquire" ? 1 : -1), 0),
    restore: () => configureHostAdapter(base),
  };
};

test("chat run keeps the power guard across the turn-end gap", { timeout: 20000 }, async () => {
  const f = await fixture(() => "Chat reply.");
  const guard = guardRecorder();
  try {
    await f.send("Reply once.");
    for (let i = 0; i < 400 && guard.depth() !== 0; i++) await new Promise(resolve => setTimeout(resolve, 15));
    const chatSessionId = f.coco.engine.snapshot().chat!.sessionId;
    assert.ok(chatSessionId, "chat session exists");
    const turnRelease = guard.events.map((event, index) => ({ event, index })).filter(entry => entry.event.op === "release" && entry.event.owner === chatSessionId).at(-1);
    const runRelease = guard.events.map((event, index) => ({ event, index })).filter(entry => entry.event.op === "release" && entry.event.owner.startsWith("coco-chat:")).at(-1);
    assert.ok(turnRelease, "per-turn guard released");
    assert.ok(runRelease, "run guard released");
    assert.ok(runRelease.index > turnRelease.index, "run guard outlives the per-turn guard (turn-end gap stays guarded)");
    assert.equal(guard.depth(), 0, "guard counter balanced after the run");
  } finally { guard.restore(); await f.close(); }
});

test("work execution keeps the power guard across its supervision loop", { timeout: 30000 }, async () => {
  const f = await fixture(() => "Executed work reply.");
  const guard = guardRecorder();
  try {
    const workspaceId = f.store.listWorkspaces().find(w => w.path === f.root)!.id;
    const work = { id: "guard-exec", goalId: "guard-goal", title: "Guard exec", objective: "Do one thing", workspaceId, status: "draft", priority: 0, dependsOn: [], steps: [], acceptance: [], deliverables: [], ruleIds: [], revision: 1, repairs: 0, fullPermissions: true, providerId: "local", createdAt: Date.now(), updatedAt: Date.now(), summary: "", timeline: [] } satisfies CocoWork;
    f.coco.engine.repository.put("work", work);
    const { execute } = createCocoExecution({ root: f.root, store: f.store, repository: f.coco.engine.repository, tools: new CocoToolRuntime(), alive: () => true, engine: () => f.coco.engine, context: undefined } as unknown as CocoServiceDeps);
    await execute(work, f.coco.engine.settings(), new AbortController().signal, () => {}, () => {});
    const runAcquire = guard.events.findIndex(event => event.op === "acquire" && event.owner === "coco-execution:guard-exec");
    const runRelease = guard.events.findIndex(event => event.op === "release" && event.owner === "coco-execution:guard-exec");
    assert.ok(runAcquire >= 0 && runRelease > runAcquire, "execution run guard bracketed");
    const turnAcquire = guard.events.findIndex((event, index) => event.op === "acquire" && index > runAcquire && index < runRelease && !event.owner.startsWith("coco-"));
    assert.ok(turnAcquire > runAcquire, "turn guard acquired inside the run bracket");
    const turnRelease = guard.events.findIndex((event, index) => event.op === "release" && index > turnAcquire && index < runRelease && !event.owner.startsWith("coco-"));
    assert.ok(turnRelease > turnAcquire && turnRelease < runRelease, "turn guard released before the run bracket closed (between-turn window stays guarded)");
    assert.equal(guard.depth(), 0, "guard counter balanced after the run");
  } finally { guard.restore(); await f.close(); }
});
