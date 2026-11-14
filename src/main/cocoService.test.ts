import { runAgentTurn as runRealAgentTurn } from "../agent/runAgentTurn.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionStore } from "./sessionRuntime.js";
import { createCocoService } from "./cocoService.js";
import { registerBuiltins } from "../tools/index.js";
import { configureCredentialsRoot, configureLegacyKeyBridgeForTests } from "../llm/credentials.js";
import { configureUserMemoryRoot } from "../memory/store.js";
import { configurePromptDefaults } from "../settings/promptDefaults.js";
import { defaultSettings } from "../coco/validation.js";
import { insertLoop, openLoopsDb } from "../loops/db.js";
/** A path embedded in JSON-stringified messages is escaped (Windows backslashes) — match its JSON form. */
const jsonEscaped = (value: string): string => JSON.stringify(value).slice(1, -1);


test("real provider protocol → CoCo planning → SessionStore file tool → fresh verification → report", { timeout: 15000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "coco-integration-"));
  configureCredentialsRoot(root); configureLegacyKeyBridgeForTests(null); configureUserMemoryRoot(root); configurePromptDefaults(join(process.cwd(),"resources","prompts")); registerBuiltins();
  let projectId = "", excludedId = "", requests = 0, verificationReplies = 0;
  const projectRoot = mkdtempSync(join(tmpdir(), "coco-integration-project-"));
  const file = join(root,"result.md");
  const excludedRoot = join(projectRoot,"excluded"); mkdirSync(excludedRoot); writeFileSync(join(excludedRoot,"private.txt"),"excluded content");
  const server = createServer(async (req,res) => {
    let body = ""; for await (const chunk of req) body += String(chunk);
    const payload = JSON.parse(body), messages = payload.messages as { role: string; content: unknown; tool_calls?: unknown[] }[];
    const first = messages.filter((m: {role:string})=>m.role==="system").map((m: {content?:unknown})=>String(m.content??"")).join("\n"), serialized = JSON.stringify(messages); requests++;
    let delta: Record<string,unknown>;
    if (messages.some(m=>m.role === "system" && String(m.content).includes("You are CoCo, the user's commander")) && !messages.some(m=>m.role==="tool")) {
      assert.ok(serialized.includes(jsonEscaped(projectRoot))); assert.ok(!serialized.includes(excludedId));
      delta = { tool_calls:[{index:0,id:"context-read",type:"function",function:{name:"coco_context",arguments:JSON.stringify({workspaceId:projectId,path:"requirements.md"})}},{index:1,id:"missing-read",type:"function",function:{name:"coco_context",arguments:JSON.stringify({workspaceId:projectId,path:"missing.md"})}},{index:2,id:"excluded-read",type:"function",function:{name:"coco_context",arguments:JSON.stringify({workspaceId:projectId,path:"excluded/private.txt"})}}] };
    }
    else if (messages.some(m=>m.role === "system" && String(m.content).includes("You are CoCo, the user's commander"))) {
      assert.match(serialized,/missing.md/); assert.match(serialized,/excluded project/); assert.ok(!serialized.includes("excluded content"));
      const submitted = messages.some(m=>m.role === "assistant" && (m.tool_calls as {function:{name:string}}[]|undefined)?.some(c=>c.function.name==="coco_work"));
      delta = submitted ? {content:"- Plan saved. I will verify the result before marking it complete."} : { tool_calls:[{index:0,id:"save-plan",type:"function",function:{name:"coco_work",arguments:JSON.stringify({action:"submit",plan:{ reply:"Plan saved", planOnly:false, work:[{key:"write",title:"Write a result",objective:"Write result.md containing verified result",workspaceId:projectId,priority:50,dependsOn:[],steps:["Write the file"],deliverables:[file],acceptance:[{id:"file",description:"result.md exists",kind:"review"},{id:"content",description:"result.md reads as a verified result",kind:"review"}]}],ruleSuggestions:[] }})}}] };
    } else if (first.includes("evaluating whether a project task is complete")) {
      verificationReplies++;
      delta = verificationReplies === 1 ? {content:"- The result file contains verified result."} : {tool_calls:[{index:0,id:"verified-result",type:"function",function:{name:"submit_coco_result",arguments:JSON.stringify({result:{action:"complete",reason:"The saved goal is done"}})}}]};
    }
    else if (first.includes("concise English CoCo work report")) delta = { content:JSON.stringify({ markdown:"# CoCo report\nThe file was independently verified." }) };
    else if (!serialized.includes('"role":"tool"')) delta = { tool_calls:[{index:0,id:`write-${requests}`,type:"function",function:{name:"write_file",arguments:JSON.stringify({path:file,content:"# verified result\n"})}}] };
    else delta = { content:"The result file was written. Verify its contents." };
    res.writeHead(200,{"Content-Type":"text/event-stream"});
    res.write(`data: ${JSON.stringify({id:`response-${requests}`,choices:[{index:0,delta,finish_reason:null}]})}\n\n`);
    res.write(`data: ${JSON.stringify({choices:[{index:0,delta:{},finish_reason:delta.tool_calls?"tool_calls":"stop"}],usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}})}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing server port");
  writeFileSync(join(root,"settings.json"),JSON.stringify({providers:[{id:"local",name:"Local test",baseUrl:`http://127.0.0.1:${address.port}/v1`,modelId:"coco-test"}],activeProviderId:"local",userMemoryAutoExtract:false,projectMemoryAutoExtract:false,composerRunMode:"agent",maxModelIterations:5}));
  const store = createSessionStore(root,{startBackgroundServices:false});
  writeFileSync(join(projectRoot,"requirements.md"),"The output must contain verified result.");
  const workspace = await store.createWorkspace({name:"CoCo test",path:projectRoot}); projectId = workspace.id;
  excludedId = (await store.createWorkspace({name:"Excluded project",path:excludedRoot})).id;
  const coco = createCocoService(root,store,undefined,undefined,{projectAwareness:false}); coco.engine.repository.setMeta("settings",{...defaultSettings(),enabled:true,fullPermissions:false,shellEnabled:false,excludedWorkspaceIds:[excludedId],excludedSessionIds:["obsolete-session"]});
  try {
    coco.start(); coco.engine.command({type:"activation",action:"enable"}); coco.engine.command({type:"chat",text:"Write a result",workspaceId:projectId});
    for (let i=0;i<200;i++) { const work = coco.engine.snapshot().work[0]; if (work?.status === "completed" || work?.status === "to_decide") break; await new Promise(resolve=>setTimeout(resolve,20)); }
    const snapshot = coco.engine.snapshot(); assert.equal(snapshot.work[0]?.status,"completed",snapshot.work[0]?.summary ?? snapshot.messages.at(-1)?.text ?? "No work was generated");
    assert.equal(readFileSync(file,"utf8"),"# verified result\n"); assert.equal(snapshot.verifications[0]?.passed,true); assert.equal(verificationReplies,2,"background prose gets corrected through a structured-result tool");
    assert.ok(snapshot.work[0]?.sessionId); assert.equal(store.getSession(snapshot.work[0]!.sessionId!)?.source,"coco");
    assert.equal(store.getSession(snapshot.work[0]!.sessionId!)?.title,"Write a result","dispatched sessions are titled with the work title, not the internal CoCo work id");
    coco.engine.command({type:"report"});
    for(let i=0;i<100 && !coco.engine.snapshot().reports.length;i++) await new Promise(resolve=>setTimeout(resolve,20));
    assert.match(coco.engine.snapshot().reports[0]?.markdown ?? "",/independently verified/);
    assert.equal(coco.engine.repository.list("usage").length,requests,"every CoCo request is metered exactly once");
    assert.equal(coco.engine.snapshot().budget.daily,coco.engine.repository.list<{purpose:string;tokens:number}>("usage").reduce((total,u)=>total+u.tokens,0),"every metered request, manual chat included, counts toward the shared daily budget");
    assert.equal(coco.engine.repository.list("contextRead").length,3,"successful and failed reads are audited and recoverable");
    assert.equal(snapshot.settings.fullPermissions,true);
    const takeover = await store.startTurn({sessionId:snapshot.work[0]!.sessionId!,userText:"User takes over this normal project session",fullPermissions:true});
    assert.equal(takeover.sessionId, snapshot.work[0]!.sessionId);
    while (store.isTurnActive(takeover.sessionId)) await new Promise(resolve => setTimeout(resolve,20));
  } finally {
    coco.stop(); await coco.engine.settled(); store.memorySync.stop(); store.database.close();
    await new Promise<void>(resolve=>server.close(()=>resolve())); rmSync(root,{recursive:true,force:true}); rmSync(projectRoot,{recursive:true,force:true});
  }
});

test("legacy migration is idempotent and preserves configuration and historical runs", async()=>{
  const root=mkdtempSync(join(tmpdir(),"coco-migration-")); configureCredentialsRoot(root); configureUserMemoryRoot(root);
  writeFileSync(join(root,"settings.json"),JSON.stringify({providers:[{id:"local",name:"Local",baseUrl:"http://127.0.0.1:9",modelId:"test"}],activeProviderId:"local"}));
  const legacy=openLoopsDb(root); const loop=insertLoop(legacy,{name:"Existing loop",prompt:"Review the project",workspaceId:"project",runMode:"ask",providerId:"local",reasoningEffort:"high",fullPermissions:false,cadenceJson:JSON.stringify({kind:"day",time:"09:00"}),enabled:false,nextRunAt:1});
  legacy.prepare("INSERT INTO loop_runs(id,loop_id,session_id,status,started_at,ended_at,error) VALUES(?,?,?,?,?,?,?)").run("old-run",loop.id,"old-session","succeeded",1,2,null); legacy.close();
  const store=createSessionStore(root,{startBackgroundServices:false}), coco=createCocoService(root,store,undefined,undefined,{projectAwareness:false});
  try {
    coco.start(); let snapshot=coco.engine.snapshot(); assert.equal(snapshot.rules.length,1); assert.equal(snapshot.rules[0]?.enabled,false); assert.equal(snapshot.rules[0]?.runMode,"ask"); assert.equal(snapshot.rules[0]?.reasoningEffort,"high"); assert.equal(snapshot.legacyRuns[0]?.status,"succeeded"); assert.equal(snapshot.verifications.length,0); assert.ok(snapshot.rules[0]!.nextRunAt>Date.now());
    coco.engine.stop(); await coco.engine.settled(); coco.start(); snapshot=coco.engine.snapshot(); assert.equal(snapshot.rules.length,1); assert.equal(snapshot.legacyRuns.length,1);
  } finally {coco.stop();await coco.engine.settled();store.memorySync.stop();store.database.close();rmSync(root,{recursive:true,force:true});}
});

test("CoCo reuses and steers an existing project session, then answers its technical question", { timeout: 15000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "coco-supervisor-integration-"));
  configureCredentialsRoot(root); configureLegacyKeyBridgeForTests(null); configureUserMemoryRoot(root); configurePromptDefaults(join(process.cwd(),"resources","prompts")); registerBuiltins();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let projectId = "", sessionId = "", plans = 0, turns = 0, inserted = 0, answered = false;
  const server = createServer(async (req,res) => {
    let body = ""; for await (const chunk of req) body += String(chunk);
    const messages = JSON.parse(body).messages;
    const first = messages.filter((m: {role:string})=>m.role==="system").map((m: {content?:unknown})=>String(m.content??"")).join("\n");
    let result: unknown;
    let call: unknown;
    if (messages.some((m:{role:string;content:unknown})=>m.role === "system" && String(m.content).includes("You are CoCo, the user's commander"))) {
      assert.ok(JSON.stringify(messages).includes(sessionId)); assert.ok(JSON.stringify(messages).includes(jsonEscaped(root)));
      const current = messages.slice(messages.findLastIndex((m:{role:string})=>m.role==="user"));
      const submitted = current.some((m:{tool_calls?:{function:{name:string}}[]})=>m.tool_calls?.some(c=>c.function.name==="coco_work"));
      if (submitted) result = "The existing session is following the saved requirements.";
      else { plans++;
      result = { reply: "Continue in the existing session", planOnly: false, work: [{ key: "continue", title: plans === 1 ? "Continue implementation" : "Refine implementation", objective: plans === 1 ? "Keep the implementation small" : "Also support keyboard navigation", workspaceId: projectId, executionSessionId: sessionId, sessionStrategy: "steer", priority: 50, dependsOn: [], steps: ["Reuse existing context"], acceptance: [{ id: `criterion-${plans}`, kind: "review", description: plans === 1 ? "Small implementation" : "Keyboard navigation" }], deliverables: [] }], ruleSuggestions: [] };
      call = {index:0,id:`save-${plans}`,type:"function",function:{name:"coco_work",arguments:JSON.stringify({action:"submit",plan:result})}};
      }
    } else if (first.includes("commander of a Larry Agent execution session")) result = { action: "answer", answer: "Reuse the existing parser", reason: "The saved goal asks for minimal changes" };
    else if (first.includes("evaluating whether a project task is complete")) result = { action: "complete", reason: "The revised execution finished" }; else throw new Error(`Unexpected provider request: ${first.slice(0,80)}`);
    res.writeHead(200,{"Content-Type":"text/event-stream"});
    res.write(`data: ${JSON.stringify({choices:[{index:0,delta:call?{tool_calls:[call]}:{content:typeof result==="string"?result:JSON.stringify(result)},finish_reason:null}]})}\n\n`);
    res.write(`data: ${JSON.stringify({choices:[{index:0,delta:{},finish_reason:call?"tool_calls":"stop"}],usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}})}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing port");
  writeFileSync(join(root,"settings.json"),JSON.stringify({providers:[{id:"local",name:"Local",baseUrl:`http://127.0.0.1:${address.port}/v1`,modelId:"test"}],activeProviderId:"local",userMemoryAutoExtract:false,projectMemoryAutoExtract:false,composerRunMode:"agent"}));
  const store = createSessionStore(root, { startBackgroundServices:false, runAgentTurn: async input => {
    if (["coco_chat","coco_internal"].includes(input.session.source??"")) return runRealAgentTurn(input);
    turns++; input.session.status = "running";
    await gate;
    inserted = input.takePendingSteer?.().length ?? 0;
    const answer = await input.gate.requestUserAsk({ toolCallId:"technical-question",question:"Which parser should we use?",options:["Reuse the existing parser","Add a new parser"],allowCustom:false });
    answered = answer?.selected === "Reuse the existing parser";
    input.session.status = "idle";
    return { status:"idle",modelIterations:0 };
  } });
  projectId = (await store.createWorkspace({name:"Existing project",path:root})).id;
  const existing = await store.startTurn({workspaceId:projectId,userText:"Start implementation",fullPermissions:true}); sessionId = existing.sessionId;
  const coco = createCocoService(root,store,undefined,undefined,{projectAwareness:false});
  try {
    coco.start(); coco.engine.command({type:"activation",action:"enable"}); coco.engine.command({type:"chat",text:"Follow the existing implementation"});
    for(let i=0;i<150 && coco.engine.repository.list("dispatch").length<1;i++) await new Promise(resolve=>setTimeout(resolve,20));
    coco.engine.command({type:"chat",text:"Also support keyboard navigation"});
    for(let i=0;i<150 && coco.engine.repository.list("dispatch").length<2;i++) await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal(coco.engine.repository.list("dispatch").length,2);
    assert.equal(store.isTurnActive(sessionId),true);
    release();
    for(let i=0;i<200 && !["completed","to_decide"].includes(coco.engine.snapshot().work[0]?.status ?? "");i++) await new Promise(resolve=>setTimeout(resolve,20));
    const snapshot=coco.engine.snapshot();
    assert.equal(snapshot.work[0]?.status,"completed",snapshot.work[0]?.summary ?? "No work");
    assert.equal(snapshot.work.length,1); assert.equal(store.listSessions().length,1); assert.equal(turns,1); assert.equal(inserted,2); assert.equal(answered,true);
    assert.equal(snapshot.work[0]?.sessionId,sessionId); assert.equal(snapshot.work[0]?.revision,2); assert.equal(snapshot.verifications[0]?.checks.length,1);
    assert.equal(coco.engine.repository.list("supervision").length,1);
  } finally {
    release(); coco.stop(); store.cancelTurn(sessionId); await coco.engine.settled();
    while(store.isTurnActive(sessionId)) await new Promise(resolve=>setTimeout(resolve,10));
    store.memorySync.stop(); store.database.close(); await new Promise<void>(resolve=>server.close(()=>resolve())); rmSync(root,{recursive:true,force:true});
  }
});

test("queued work linked to a deleted session starts a new project session", { timeout: 15000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "coco-stale-session-"));
  configureCredentialsRoot(root); configureLegacyKeyBridgeForTests(null); configureUserMemoryRoot(root); configurePromptDefaults(join(process.cwd(),"resources","prompts")); registerBuiltins();
  writeFileSync(join(root,"settings.json"),JSON.stringify({providers:[{id:"local",name:"Local",baseUrl:"http://127.0.0.1:9/v1",modelId:"test"}],activeProviderId:"local",userMemoryAutoExtract:false,projectMemoryAutoExtract:false,composerRunMode:"agent"}));
  const turns: string[] = [];
  const store = createSessionStore(root, { startBackgroundServices:false, runAgentTurn: async input => {
    turns.push(input.session.id); input.session.status = "idle";
    return { status:"idle",modelIterations:0 };
  } });
  const projectId = (await store.createWorkspace({name:"Project",path:root})).id;
  const coco = createCocoService(root,store,undefined,undefined,{projectAwareness:false});
  try {
    coco.engine.repository.setMeta("settings",{...defaultSettings(),enabled:true,activationSeen:true});
    coco.engine.repository.put("work",{ id:"stale-work", goalId:"goal", goalIds:["goal"], sessionId:"deleted-session", sessionStrategy:"steer", title:"Continue font audit", objective:"Re-check fonts", workspaceId:projectId, status:"queued", priority:50, prioritySource:"coco", dependsOn:[], steps:["Scan"], acceptance:[{id:"c1",description:"Scanned",kind:"review"}], deliverables:[], ruleIds:[], revision:1, repairs:0, fullPermissions:true, providerId:"", runMode:"agent", createdAt:Date.now(), updatedAt:Date.now(), summary:"Queued", timeline:[] });
    coco.start();
    for(let i=0;i<200 && !coco.engine.repository.list("dispatch").length;i++) await new Promise(resolve=>setTimeout(resolve,20));
    const dispatch = coco.engine.repository.list<{sessionId:string;mode:string}>("dispatch")[0];
    assert.equal(dispatch?.mode,"create");
    assert.notEqual(dispatch?.sessionId,"deleted-session");
    assert.equal(store.getSession(dispatch!.sessionId)?.workspaceId,projectId);
    for(let i=0;i<200 && coco.engine.repository.get<{sessionId?:string}>("work","stale-work")?.sessionId==="deleted-session";i++) await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal(coco.engine.repository.get<{sessionId?:string}>("work","stale-work")?.sessionId,dispatch!.sessionId);
  } finally {
    coco.stop(); await coco.engine.settled(); store.memorySync.stop(); store.database.close(); rmSync(root,{recursive:true,force:true});
  }
});

test("queued work linked to an archived session starts a new project session", { timeout: 15000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "coco-archived-session-"));
  configureCredentialsRoot(root); configureLegacyKeyBridgeForTests(null); configureUserMemoryRoot(root); configurePromptDefaults(join(process.cwd(),"resources","prompts")); registerBuiltins();
  writeFileSync(join(root,"settings.json"),JSON.stringify({providers:[{id:"local",name:"Local",baseUrl:"http://127.0.0.1:9/v1",modelId:"test"}],activeProviderId:"local",userMemoryAutoExtract:false,projectMemoryAutoExtract:false,composerRunMode:"agent"}));
  const turns: string[] = [];
  const store = createSessionStore(root, { startBackgroundServices:false, runAgentTurn: async input => {
    turns.push(input.session.id); input.session.status = "idle";
    return { status:"idle",modelIterations:0 };
  } });
  const projectId = (await store.createWorkspace({name:"Project",path:root})).id;
  const coco = createCocoService(root,store,undefined,undefined,{projectAwareness:false});
  try {
    const archived = (await store.startTurn({workspaceId:projectId,userText:"Earlier font audit",fullPermissions:true})).sessionId;
    for(let i=0;i<200 && store.isTurnActive(archived);i++) await new Promise(resolve=>setTimeout(resolve,20));
    const other = (await store.startTurn({workspaceId:projectId,userText:"Unrelated work keeps the project active",fullPermissions:true})).sessionId;
    for(let i=0;i<200 && store.isTurnActive(other);i++) await new Promise(resolve=>setTimeout(resolve,20));
    store.setSessionArchived(archived,true);
    coco.engine.repository.setMeta("settings",{...defaultSettings(),enabled:true,activationSeen:true});
    coco.engine.repository.put("work",{ id:"stale-work", goalId:"goal", goalIds:["goal"], sessionId:archived, sessionStrategy:"steer", title:"Continue font audit", objective:"Re-check fonts", workspaceId:projectId, status:"queued", priority:50, prioritySource:"coco", dependsOn:[], steps:["Scan"], acceptance:[{id:"c1",description:"Scanned",kind:"review"}], deliverables:[], ruleIds:[], revision:1, repairs:0, fullPermissions:true, providerId:"", runMode:"agent", createdAt:Date.now(), updatedAt:Date.now(), summary:"Queued", timeline:[] });
    coco.start();
    for(let i=0;i<200 && !coco.engine.repository.list("dispatch").length;i++) await new Promise(resolve=>setTimeout(resolve,20));
    const dispatch = coco.engine.repository.list<{sessionId:string;mode:string}>("dispatch")[0];
    assert.equal(dispatch?.mode,"create");
    assert.notEqual(dispatch?.sessionId,archived);
    assert.equal(store.getSession(dispatch!.sessionId)?.workspaceId,projectId);
    for(let i=0;i<200 && coco.engine.repository.get<{sessionId?:string}>("work","stale-work")?.sessionId===archived;i++) await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal(coco.engine.repository.get<{sessionId?:string}>("work","stale-work")?.sessionId,dispatch!.sessionId);
  } finally {
    coco.stop(); await coco.engine.settled(); store.memorySync.stop(); store.database.close(); rmSync(root,{recursive:true,force:true});
  }
});
