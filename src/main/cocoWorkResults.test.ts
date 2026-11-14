import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CocoRepository } from "../coco/repository.js";
import type { CocoAttempt, CocoWork, CocoWorkResult } from "../coco/types.js";
import { defaultSettings } from "../coco/validation.js";
import type { Message } from "../session/types.js";
import type { CocoServiceDeps } from "./cocoServiceDeps.js";
import { createCocoWorkResults, executionReply, reportPaths } from "./cocoWorkResults.js";

const reply = (id: string, at: number, text: string): Message => ({ id, createdAt: at, role: "assistant", parts: [{ type: "text", text }, { type: "reasoning", text: "Private thinking must never be saved" }] });
function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "coco-results-")), project = join(root,"project"), other = join(root,"other"); mkdirSync(project); mkdirSync(other);
  const db = new DatabaseSync(":memory:"), repository = new CocoRepository(db), now = Date.now();
  const work: CocoWork = { id: "work", goalId: "goal", title: "Weekly report", objective: "Write a report", workspaceId: "project", status: "completed", priority: 50, dependsOn: [], steps: [], acceptance: [], deliverables: ["report.md"], ruleIds: [], revision: 1, repairs: 0, fullPermissions: true, providerId: "", createdAt: now - 10000, updatedAt: now + 1000, sessionId: "session", summary: "Verified", timeline: [] };
  repository.put("work",work);
  const attempt: CocoAttempt = { id: "attempt", workId: work.id, revision: 1, sessionId: "session", startedAt: now - 10000, endedAt: now + 1000, status: "finished" }; repository.put("attempt",attempt);
  let messages: Message[] = [{ id: "user", role: "user", createdAt: now - 9999, parts: [{ type: "text", text: "Write the report" }] }, reply("reply",now,"Report saved to [report](report.md).")];
  const settings = defaultSettings();
  const deps = { repository, alive: () => true, engine: () => ({ settings: () => settings }), store: { listWorkspaces: () => [{ id:"project",path:project },{ id:"other",path:other }], getSession: (id:string) => id === "session" ? { workspaceId:"project", createdAt:now-30000, messages } : undefined } } as unknown as CocoServiceDeps;
  const results = createCocoWorkResults(deps);
  t.after(() => { db.close(); rmSync(root,{recursive:true,force:true}); });
  return { root, project, other, repository, results, work, attempt, now, settings, setMessages: (value:Message[]) => { messages=value; } };
}

test("keeps the final reply in its own attempt window without saving reasoning or a later task", () => {
  const messages: Message[] = [reply("old",1,"Old report"),{ id:"u",role:"user",createdAt:5,parts:[] },reply("current",6,"Current report"),{id:"next",role:"user",createdAt:11,parts:[]},reply("later",12,"Another task")];
  assert.equal(executionReply(messages,5,10)?.id,"current");
  assert.equal(executionReply(messages,11,11),undefined);
  const progress = reply("progress",7,"Still working"); progress.parts.push({type:"tool_call",id:"call",name:"write_file",arguments:{},argumentsRaw:"{}",status:"done"});
  assert.equal(executionReply([...messages.slice(0,3),progress],5,10),undefined,"a tool-bearing progress reply is not a final report");
});

test("collects only explicitly referenced local report paths", () => {
  assert.deepEqual(reportPaths("[Report](reports/weekly%20review.md) and `notes.txt` and [Web](https://example.com/report.md)",["declared.md","not a path"]),["declared.md","reports/weekly review.md","notes.txt"]);
});

test("captures full report content once and keeps it after files and session history change", async t => {
  const f=fixture(t); writeFileSync(join(f.project,"report.md"),"# Original report\n\nThe actual findings.");
  const saved=await f.results.capture(f.work.id);
  assert.equal(saved.length,2); assert.equal(saved.find(result=>result.source==="file")?.markdown,"# Original report\n\nThe actual findings.");
  assert.ok(saved.every(result=>!result.markdown.includes("Private thinking")));
  writeFileSync(join(f.project,"report.md"),"Rewritten by a later task"); f.setMessages([]);
  const restored=await f.results.read(f.work.id);
  assert.deepEqual(restored,saved);
  const reopened=createCocoWorkResults({ repository:f.repository,alive:()=>true,engine:()=>({settings:()=>f.settings}),store:{listWorkspaces:()=>[{id:"project",path:f.project}],getSession:()=>undefined} } as unknown as CocoServiceDeps);
  assert.deepEqual(await reopened.read(f.work.id),saved,"saved output does not depend on a surviving session");
});

test("never imports the current contents of a file rewritten after the historical run", async t => {
  const f=fixture(t); const file=join(f.project,"report.md"); writeFileSync(file,"Later report"); utimesSync(file,new Date(f.now+20000),new Date(f.now+20000));
  const saved=await f.results.read(f.work.id);
  assert.equal(saved.length,1); assert.equal(saved[0]?.source,"message"); assert.equal(saved[0]?.imported,true);
});

test("captures an observed task's original output without requiring a new execution session", async t => {
  const f=fixture(t);
  f.repository.put("work",{...f.work,sessionId:undefined,observeSessionId:"session"});
  f.repository.put("attempt",{...f.attempt,sessionId:undefined});
  f.setMessages([reply("observed",f.now-20000,"# The existing report\n\nOriginal findings.")]);
  const saved=await f.results.capture(f.work.id);
  assert.equal(saved.length,1); assert.equal(saved[0]?.messageId,"observed"); assert.equal(saved[0]?.sessionId,"session");
});

test("uses the completed requirements version when a task was revised during execution", async t => {
  const f=fixture(t);
  f.repository.put("work",{...f.work,revision:2});
  f.repository.put("attempt",{...f.attempt,resultRevision:2});
  const saved=await f.results.capture(f.work.id);
  assert.equal(saved[0]?.revision,2); assert.equal(saved[0]?.attemptId,"attempt");
});

test("blocks traversal, excluded projects and symlinks while retaining the execution reply", async t => {
  const f=fixture(t); writeFileSync(join(f.other,"private.md"),"Other project's report");
  symlinkSync(join(f.other,"private.md"),join(f.project,"report.md"));
  f.work.deliverables=["../other/private.md","report.md"]; f.repository.put("work",f.work);
  const saved=await f.results.capture(f.work.id); assert.equal(saved.length,1); assert.equal(saved[0]?.source,"message");
  f.settings.excludedWorkspaceIds=["project"];
  await assert.rejects(f.results.read(f.work.id),/excluded or unavailable/);
});

test("publishes report snapshots with attempt and revision, deduplicates a retried tool call and revokes stale access", async t => {
  const f=fixture(t); f.repository.put("attempt",{...f.attempt,status:"running"});
  let valid=true;
  const tool=f.results.tool(f.work.id,()=>"session",()=>valid);
  const args={title:"Weekly findings",markdown:"# Weekly findings\n\nA complete report."};
  await tool.execute(args,{} as never); await tool.execute(args,{} as never);
  const saved=f.repository.list<CocoWorkResult>("workResult"); assert.equal(saved.length,1); assert.equal(saved[0]?.attemptId,"attempt"); assert.equal(saved[0]?.revision,1);
  f.repository.put("work",{...f.work,revision:2}); await tool.execute({...args,markdown:"Updated requirements"},{} as never);
  assert.equal(f.repository.list<CocoWorkResult>("workResult").length,2,"a later requirements revision retains its own report");
  valid=false; await assert.rejects(tool.execute(args,{} as never),/no longer active/);
  assert.equal(f.repository.get<CocoWork>("work",f.work.id)?.status,"completed","publishing does not change verification status");
});

test("rejects empty, ambiguous, oversized, binary and out-of-project report submissions", async t => {
  const f=fixture(t), tool=f.results.tool(f.work.id,()=>"session",()=>true);
  await assert.rejects(tool.execute({title:"Report",markdown:""},{} as never),/exactly one/);
  await assert.rejects(tool.execute({title:"Report",markdown:"text",path:"report.md"},{} as never),/exactly one/);
  await assert.rejects(tool.execute({title:"Report",markdown:"x".repeat(262145)},{} as never),/256 KiB/);
  writeFileSync(join(f.project,"report.md"),Buffer.from([65,0,66]));
  await assert.rejects(tool.execute({title:"Report",path:"report.md"},{} as never),/not a text file/);
  writeFileSync(join(f.other,"outside.md"),"Not this task's report");
  await assert.rejects(tool.execute({title:"Report",path:join(f.other,"outside.md")},{} as never),/another project/);
});
