import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync,writeFileSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionStore } from "./sessionRuntime.js";
import { CocoRepository } from "../coco/repository.js";
import { retainCocoHistory } from "./cocoRetention.js";
import { defaultSettings,validateSettings } from "../coco/validation.js";
import { openSessionDb,upsertSession } from "../session/db/index.js";
import type { Session } from "../session/types.js";
import type { CocoWork } from "../coco/types.js";
import { configureCredentialsRoot,configureLegacyKeyBridgeForTests } from "../llm/credentials.js";
import { configureUserMemoryRoot } from "../memory/store.js";

async function fixture(recent=true){
  const root=mkdtempSync(join(tmpdir(),"coco-retention-")),now=Date.now(),old=now-40*86400000;
  configureCredentialsRoot(root);configureLegacyKeyBridgeForTests(null);configureUserMemoryRoot(root);
  writeFileSync(join(root,"settings.json"),JSON.stringify({providers:[{id:"fixture",name:"Fixture",baseUrl:"http://127.0.0.1:9/v1",modelId:"fixture"}],activeProviderId:"fixture",userMemoryAutoExtract:false,projectMemoryAutoExtract:false}));
  const initial=createSessionStore(root,{startBackgroundServices:false}),workspace=await initial.createWorkspace({name:"Retention",path:root});initial.memorySync.stop();initial.database.close();
  const base:Session={id:"chat",type:"agent",source:"coco_chat",title:"CoCo",workspaceId:workspace.id,workspacePath:root,providerId:"fixture",model:"fixture",createdAt:old,updatedAt:now,status:"idle",progressText:"",pinned:false,archived:false,archivedAt:null,contextUsage:{usedTokens:0},plan:null,messages:[{id:"old-user",role:"user",createdAt:old,parts:[{type:"text",text:"OLD_DETAIL_CANARY"}]},{id:"old-reply",role:"assistant",createdAt:old+1,parts:[{type:"text",text:"Verified task output before the cutoff."}]},...(recent?[{id:"recent-user",role:"user" as const,createdAt:now,parts:[{type:"text" as const,text:"Keep the recent conversation."}]},{id:"recent-reply",role:"assistant" as const,createdAt:now+1,parts:[{type:"text" as const,text:"Recent reply stays verbatim."}]}]:[])]};
  const db=openSessionDb(root);upsertSession(db,base);upsertSession(db,{...base,id:"ordinary",source:"app",messages:base.messages.slice(0,2).map(m=>({...m,id:`ordinary-${m.id}`}))});upsertSession(db,{...base,id:"background",source:"coco_internal",messages:base.messages.slice(0,2).map(m=>({...m,id:`background-${m.id}`}))});db.close();
  let store=createSessionStore(root,{startBackgroundServices:false});let repository=new CocoRepository(store.database);
  repository.put("backgroundSession",{id:"old-operation:0",sessionId:"background",operationId:"old-operation",workId:"done-work",at:old});repository.put("backgroundInput",{id:"old-operation:0",input:{oldDetail:"OLD_DETAIL_CANARY"}});
  repository.put("message",{id:"old-user",role:"user",text:"OLD_DETAIL_CANARY",at:old,goalId:"old-goal"});repository.put("message",{id:"recent-user",role:"user",text:"Keep the recent conversation.",at:now});
  const work:CocoWork={id:"done-work",goalId:"old-goal",title:"Verified work",objective:"Verify the output",workspaceId:workspace.id,status:"completed",priority:50,dependsOn:[],steps:[],acceptance:[{id:"check",kind:"review",description:"Verified output"}],deliverables:["result.md"],ruleIds:[],revision:1,repairs:0,sessionId:"project-session",fullPermissions:true,providerId:"fixture",createdAt:old,updatedAt:old,summary:"Verified",timeline:[]};repository.put("work",work);repository.put("verification",{id:"v",workId:work.id,passed:true,checks:[{criterionId:"check",passed:true,evidence:"result.md verified"}]});
  return {root,now,workspaceId:workspace.id,get store(){return store;},get repository(){return repository;},async reopen(){store.memorySync.stop();store.database.close();store=createSessionStore(root,{startBackgroundServices:false});repository=new CocoRepository(store.database);},async close(){store.memorySync.stop();store.database.close();rmSync(root,{recursive:true,force:true});}};
}
test("retention defaults to 30 days and only accepts supported settings",()=>{
  assert.equal(defaultSettings().historyRetentionDays,30);assert.equal(validateSettings({...defaultSettings(),historyRetentionDays:0}).historyRetentionDays,0);assert.throws(()=>validateSettings({...defaultSettings(),historyRetentionDays:7}));
});
test("per-CoCo Chat compaction ratios are optional overrides: absent inherits, out-of-range rejected",()=>{
  const base=defaultSettings();
  assert.equal(base.compactTriggerRatio,undefined);assert.equal(base.iterationProtectTokenRatio,undefined);
  const inherited=validateSettings({...base});
  assert.equal(inherited.compactTriggerRatio,undefined);assert.equal(inherited.iterationProtectTokenRatio,undefined);
  const nulled=validateSettings({...base,compactTriggerRatio:null as unknown as number,iterationProtectTokenRatio:null as unknown as number});
  assert.equal(nulled.compactTriggerRatio,undefined);assert.equal(nulled.iterationProtectTokenRatio,undefined);
  const tuned=validateSettings({...base,compactTriggerRatio:0.95,iterationProtectTokenRatio:0.02});
  assert.equal(tuned.compactTriggerRatio,0.95);assert.equal(tuned.iterationProtectTokenRatio,0.02);
  assert.throws(()=>validateSettings({...base,compactTriggerRatio:0.49}),/between 0\.5 and 0\.95/);
  assert.throws(()=>validateSettings({...base,compactTriggerRatio:0.96}),/between 0\.5 and 0\.95/);
  assert.throws(()=>validateSettings({...base,compactTriggerRatio:Number.NaN}),/between 0\.5 and 0\.95/);
  assert.throws(()=>validateSettings({...base,iterationProtectTokenRatio:0}),/\(0, 0\.9\]/);
  assert.throws(()=>validateSettings({...base,iterationProtectTokenRatio:0.95}),/\(0, 0\.9\]/);
});
test("30-day cleanup removes expired details, preserves summaries/recent turns/task links, and survives reopening",async()=>{
  const f=await fixture();const settings={...defaultSettings(),enabled:true};
  try{
    await retainCocoHistory({store:f.store,repository:f.repository,settings,now:f.now,signal:new AbortController().signal,canContinue:()=>true,summarize:async slice=>{assert.ok(slice.messages.every(m=>m.createdAt<f.now-30*86400000));return {summary:"The old goal was completed and its result.md output was verified. Task done-work and verification v remain authoritative."};}});
    const chat=f.store.getSession("chat")!;assert.ok(!JSON.stringify(chat.messages).includes("OLD_DETAIL_CANARY"));assert.equal(chat.messages.find(m=>m.id==="recent-reply")?.parts[0]?.type,"text");assert.match(JSON.stringify(chat.messages),/retained|Retained/);
    assert.equal(f.store.database.prepare("SELECT id FROM messages WHERE id='old-user'").get(),undefined);assert.equal(f.repository.get("backgroundInput","old-operation:0"),undefined);
    assert.equal(f.repository.get<{goalId:string}>("work","done-work")?.goalId,"old-goal");assert.equal(f.repository.get<{passed:boolean}>("verification","v")?.passed,true);assert.match(f.repository.get<{text:string}>("message","old-user")!.text,/retention/);
    assert.match(JSON.stringify(f.store.getSession("ordinary")?.messages),/OLD_DETAIL_CANARY/,"ordinary project sessions are untouched");
    await f.reopen();assert.ok(!JSON.stringify(f.store.getSession("chat")?.messages).includes("OLD_DETAIL_CANARY"));assert.equal(f.store.getSession("chat")?.messages.find(m=>m.id==="recent-user")?.role,"user");
  }finally{await f.close();}
});
test("failed summarization preserves all source details",async()=>{
  const f=await fixture();try{
    await assert.rejects(retainCocoHistory({store:f.store,repository:f.repository,settings:defaultSettings(),now:f.now,signal:new AbortController().signal,canContinue:()=>true,summarize:async()=>{throw new Error("Summary unavailable");}}),/unavailable/);
    assert.match(JSON.stringify(f.store.getSession("chat")?.messages),/OLD_DETAIL_CANARY/);assert.equal(f.repository.list("retainedHistory").length,0);
  }finally{await f.close();}
});
test("unfinished work protects both Chat and its planning history; disabled/excluded retention does not summarize",async()=>{
  const f=await fixture();let calls=0;try{
    const work=f.repository.get<CocoWork>("work","done-work")!;f.repository.put("work",{...work,status:"to_decide"});
    const run=(settings=defaultSettings())=>retainCocoHistory({store:f.store,repository:f.repository,settings,now:f.now,signal:new AbortController().signal,canContinue:()=>true,summarize:async()=>{calls++;return {summary:"Summary"};}});
    await run();assert.equal(calls,0);await run({...defaultSettings(),historyRetentionDays:0});await run({...defaultSettings(),excludedWorkspaceIds:[f.workspaceId]});assert.equal(calls,0);assert.match(JSON.stringify(f.store.getSession("background")?.messages),/OLD_DETAIL_CANARY/);
  }finally{await f.close();}
});
test("a new message arriving during summarization prevents a stale history rewrite",async()=>{
  const f=await fixture(false);try{
    await retainCocoHistory({store:f.store,repository:f.repository,settings:defaultSettings(),now:f.now,signal:new AbortController().signal,canContinue:()=>true,summarize:async slice=>{if(slice.sessionId==="chat")f.store.appendCocoChatNotice("chat","new-notice","A new message arrived.");return {summary:"Old summary"};}});
    assert.match(JSON.stringify(f.store.getSession("chat")?.messages),/OLD_DETAIL_CANARY/);assert.match(JSON.stringify(f.store.getSession("chat")?.messages),/A new message arrived/);
  }finally{await f.close();}
});
test("an interrupted temporary retention transcript is cleared without erasing the source",async()=>{
  const f=await fixture();try{
    f.repository.put("backgroundSession",{id:"old-operation:0",sessionId:"background",purpose:"retention",at:f.now});
    await assert.rejects(retainCocoHistory({store:f.store,repository:f.repository,settings:defaultSettings(),now:f.now,signal:new AbortController().signal,canContinue:()=>true,summarize:async()=>{throw new Error("Unavailable");}}),/Unavailable/);
    assert.match(JSON.stringify(f.store.getSession("chat")?.messages),/OLD_DETAIL_CANARY/);assert.ok(!JSON.stringify(f.store.getSession("background")?.messages).includes("OLD_DETAIL_CANARY"));assert.equal(f.repository.get("backgroundInput","old-operation:0"),undefined);
  }finally{await f.close();}
});
