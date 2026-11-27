import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configureCredentialsRoot, configureLegacyKeyBridgeForTests } from "../llm/credentials.js";
import { configureUserMemoryRoot } from "../memory/store.js";
import { configurePromptDefaults } from "../settings/promptDefaults.js";
import { registerBuiltins } from "../tools/index.js";
import { createCocoService } from "./cocoService.js";
import { createSessionStore } from "./sessionRuntime.js";

test("real execution publishes a report, verification reads that snapshot, and the result survives source deletion", {timeout:15000}, async () => {
  const root=mkdtempSync(join(tmpdir(),"coco-publish-report-"));
  configureCredentialsRoot(root); configureLegacyKeyBridgeForTests(null); configureUserMemoryRoot(root);
  configurePromptDefaults(join(process.cwd(),"resources/prompts")); registerBuiltins();
  const reportPath=join(root,"weekly.md"), markdown="# Weekly findings\n\nThe saved report contains the complete project findings.";
  let projectId="", verifiedSnapshot=false, executorSawTool=false;
  type WireMessage={role:string;content?:unknown;tool_calls?:{function:{name:string}}[]};
  const server=createServer(async (req,res) => {
    let body=""; for await(const chunk of req) body+=String(chunk);
    const payload=JSON.parse(body), messages=payload.messages as WireMessage[];
    const system=messages.filter(m=>m.role==="system").map(m=>String(m.content)).join("\n");
    const called=(name:string)=>messages.some(m=>m.tool_calls?.some(call=>call.function.name===name));
    let delta:Record<string,unknown>;
    const call=(name:string,args:unknown)=>({tool_calls:[{index:0,id:`call-${name}`,type:"function",function:{name,arguments:JSON.stringify(args)}}]});
    if(system.includes("You are CoCo, the user's commander")) {
      delta=called("coco_work")?{content:"The report task is saved."}:call("coco_work",{action:"submit",plan:{reply:"Plan saved",planOnly:false,work:[{key:"report",title:"Weekly findings",objective:"Write a readable project report",workspaceId:projectId,priority:50,dependsOn:[],steps:["Write and publish the report"],acceptance:[{id:"report",description:"The complete findings can be read in the saved report",kind:"review"}],deliverables:[reportPath]}],ruleSuggestions:[]}});
    } else if(system.includes("evaluating whether a project task is complete")) {
      verifiedSnapshot=JSON.stringify(messages).includes("Saved task reports")&&JSON.stringify(messages).includes("complete project findings");
      delta={content:JSON.stringify({action:"complete",reason:"The complete report was delivered and saved."})};
    } else {
      executorSawTool ||= payload.tools?.some((tool:{function?:{name?:string}})=>tool.function?.name==="publish_coco_report") === true;
      delta=!called("write_file")?call("write_file",{path:reportPath,content:markdown}):!called("publish_coco_report")?call("publish_coco_report",{title:"Weekly findings",path:reportPath}):{content:"The report has been published for reading in CoCo."};
    }
    res.writeHead(200,{"Content-Type":"text/event-stream"});
    res.write(`data: ${JSON.stringify({choices:[{index:0,delta,finish_reason:null}]})}\n\n`);
    res.write(`data: ${JSON.stringify({choices:[{index:0,delta:{},finish_reason:delta.tool_calls?"tool_calls":"stop"}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}})}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const address=server.address(); assert.ok(address&&typeof address!=="string");
  writeFileSync(join(root,"settings.json"),JSON.stringify({providers:[{id:"local",name:"Test",baseUrl:`http://127.0.0.1:${address.port}/v1`,modelId:"coco-results"}],activeProviderId:"local",composerRunMode:"agent",maxModelIterations:8,userMemoryAutoExtract:false,projectMemoryAutoExtract:false}));
  const store=createSessionStore(root,{startBackgroundServices:false}); projectId=(await store.createWorkspace({name:"Reports project",path:root})).id;
  const coco=createCocoService(root,store,undefined,undefined,{projectAwareness:false,proactive:false});
  try {
    coco.start(); coco.engine.command({type:"activation",action:"enable"});
    coco.engine.command({type:"chat",text:"Write the weekly findings report.",workspaceId:projectId});
    for(let index=0;index<400;index++) { if(["completed","to_decide"].includes(coco.engine.snapshot().work[0]?.status??"")) break; await new Promise(resolve=>setTimeout(resolve,20)); }
    const work=coco.engine.snapshot().work[0]; assert.equal(work?.status,"completed",work?.summary??"No work was saved");
    assert.equal(executorSawTool,true); assert.equal(verifiedSnapshot,true);
    assert.equal(readFileSync(reportPath,"utf8"),markdown);
    const results=await coco.workResults(work!.id), report=results.find(result=>result.source==="report");
    assert.equal(report?.markdown,markdown); assert.ok(report?.attemptId); assert.equal(report?.sessionId,work?.sessionId);
    rmSync(reportPath);
    assert.deepEqual(await coco.workResults(work!.id),results);
  } finally {
    coco.stop(); await coco.shutdown(); store.memorySync.stop(); store.database.close();
    server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve())); rmSync(root,{recursive:true,force:true});
  }
});
